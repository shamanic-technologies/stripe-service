import { Router, Request, Response, NextFunction } from "express";
import { and, desc, eq, lt } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db";
import { customers, paymentIntents } from "../db/schema";
import { getPlatformStripe, recordApiSnapshot } from "../lib/event-processor";
import { isResourceMissing } from "../lib/stripe-client";

const router = Router();

function parseLimit(raw: unknown, fallback = 10): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) return null;
  return value;
}

/**
 * GET /internal/customers/by-org/:orgId
 *
 * Server-to-server mirror read for machine balance calculations. The org is
 * keyed from the path, so callers need only X-API-Key and never need to invent
 * a fake x-user-id sentinel.
 */
router.get(
  "/internal/customers/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;

      const limit = parseLimit(req.query.limit);
      if (limit === null) return res.status(400).json({ error: "Invalid limit" });

      const filters = [eq(customers.orgId, orgId)];
      const email = req.query.email;
      if (typeof email === "string") filters.push(eq(customers.email, email));

      const startingAfter = req.query.starting_after;
      if (typeof startingAfter === "string") {
        const anchor = await db
          .select({ syncedAt: customers.syncedAt })
          .from(customers)
          .where(eq(customers.id, startingAfter))
          .limit(1);
        if (anchor.length > 0) {
          filters.push(lt(customers.syncedAt, anchor[0].syncedAt));
        }
      }

      const rows = await db
        .select()
        .from(customers)
        .where(and(...filters))
        .orderBy(desc(customers.syncedAt))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const data = rows.slice(0, limit).map((r) => r.rawJson);

      return res.json({
        object: "list",
        data,
        has_more: hasMore,
        url: `/internal/customers/by-org/${orgId}`,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /internal/payment_intents/by-org/:orgId
 *
 * Server-to-server payment-intent mirror read for balance/dunning callers.
 * Supports the balance path's customer + succeeded filters without requiring
 * x-user-id.
 */
router.get(
  "/internal/payment_intents/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;

      const limit = parseLimit(req.query.limit);
      if (limit === null) return res.status(400).json({ error: "Invalid limit" });

      const filters = [eq(paymentIntents.orgId, orgId)];
      const customer = req.query.customer;
      if (typeof customer === "string") filters.push(eq(paymentIntents.customer, customer));
      const status = req.query.status;
      if (typeof status === "string") filters.push(eq(paymentIntents.status, status));

      const startingAfter = req.query.starting_after;
      if (typeof startingAfter === "string") {
        const anchor = await db
          .select({ syncedAt: paymentIntents.syncedAt })
          .from(paymentIntents)
          .where(eq(paymentIntents.id, startingAfter))
          .limit(1);
        if (anchor.length > 0) {
          filters.push(lt(paymentIntents.syncedAt, anchor[0].syncedAt));
        }
      }

      const rows = await db
        .select()
        .from(paymentIntents)
        .where(and(...filters))
        .orderBy(desc(paymentIntents.syncedAt))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const data = rows.slice(0, limit).map((r) => r.rawJson);

      return res.json({
        object: "list",
        data,
        has_more: hasMore,
        url: `/internal/payment_intents/by-org/${orgId}`,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /internal/payment_methods/by-org/:orgId?customer=cus_...
 *
 * Server-to-server Stripe payment-method read for "has attached card" checks.
 * It first proves the customer belongs to the path org in the local mirror,
 * then uses the platform Stripe client. No x-user-id sentinel is required.
 */
router.get(
  "/internal/payment_methods/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;

      const customer = req.query.customer;
      if (typeof customer !== "string" || customer.length === 0) {
        return res.status(400).json({ error: "Missing required query: customer" });
      }

      const row = await db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, customer), eq(customers.orgId, orgId)))
        .limit(1);

      if (row.length === 0) {
        return res.status(404).json({ error: "Customer not found" });
      }

      res.locals.stripeObjectId = customer;
      const stripe = await getPlatformStripe();
      const params: Stripe.PaymentMethodListParams = { customer };
      const type = req.query.type;
      if (typeof type === "string") params.type = type as Stripe.PaymentMethodListParams.Type;

      const list = await stripe.paymentMethods.list(params);
      return res.json(list);
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * DELETE /internal/customers/by-org/:orgId
 *
 * Org-teardown operation. Resolves the org's Stripe customer, deletes it ONLINE
 * at Stripe, then durably tombstones the local silver mirror so the boot-time
 * silver repair (`repairAllSilverFromBronze`) cannot resurrect the row.
 *
 * Server-to-server: X-API-Key only. No x-org-id/x-user-id — the orgId is in the
 * path and `/internal/*` is exempt from `requireIdentityHeaders`. Uses the
 * platform Stripe key (single-account model, same as the poller / back-fill /
 * webhook side-effects).
 *
 * Idempotent:
 *  - No customer mirrored for the org -> 200, nothing deleted.
 *  - Customer already gone at Stripe (`resource_missing`) -> treated as success;
 *    the mirror is still tombstoned.
 * Fail loud: any other Stripe error propagates (non-2xx; caller retries).
 *
 * The tombstone is a synthetic `deleted` bronze event recorded via
 * `recordApiSnapshot`. Its `created_stripe = now` dominates the projection's
 * `ORDER BY created_stripe DESC`, so the silver row stays deleted across every
 * future re-projection. A later real `customer.deleted` webhook agrees
 * (also `deleted`), so re-projection is consistent.
 */
router.delete(
  "/internal/customers/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId; // surface in api_call_log audit row

      const rows = await db
        .select({ id: customers.id, livemode: customers.livemode })
        .from(customers)
        .where(eq(customers.orgId, orgId));

      // Nothing to delete — idempotent success (teardown is safe to re-run).
      if (rows.length === 0) {
        return res.json({ deleted: 0, customer_ids: [] });
      }

      const stripe = await getPlatformStripe();
      const deletedIds: string[] = [];

      // 1:1 org<->customer is the invariant; loop defensively in case a stray
      // duplicate row exists so AC "no customer remains" holds regardless.
      for (const row of rows) {
        try {
          await stripe.customers.del(row.id);
        } catch (err) {
          // Already deleted at Stripe -> the job is done for this customer.
          // Any other Stripe error is real: propagate (fail loud).
          if (!isResourceMissing(err)) throw err;
        }

        // Delete Stripe FIRST, tombstone SECOND. If the tombstone throws, the
        // error propagates and a re-run re-deletes (404 -> ok) + re-tombstones.
        // `deleted: true` rides along in the stored bronze payload and drives
        // projectSilverFromBronze into its delete branch (DeletedCustomer).
        const tombstone = {
          id: row.id,
          deleted: true,
          livemode: row.livemode === "true",
        };
        await recordApiSnapshot(tombstone, "customer", orgId);
        deletedIds.push(row.id);
      }

      res.locals.stripeObjectId = deletedIds[0];
      return res.json({ deleted: deletedIds.length, customer_ids: deletedIds });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
