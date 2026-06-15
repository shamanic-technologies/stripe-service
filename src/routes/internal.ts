import { Router, Request, Response, NextFunction } from "express";
import { eq, desc } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db";
import { customers, paymentIntents } from "../db/schema";
import { getPlatformStripe, recordApiSnapshot } from "../lib/event-processor";
import { isResourceMissing } from "../lib/stripe-client";

const router = Router();

/**
 * `/internal/*` — server-to-server platform operations. X-API-Key only (via
 * serviceAuth); exempt from `requireIdentityHeaders` because the org is keyed
 * off the path, not the end-user. These routes use the platform Stripe key
 * (single-account model, same as the poller / back-fill / webhook side-effects)
 * — there is no end-user to resolve a per-org key against.
 *
 * The GET reads here back billing-service's user-less balance composition
 * (affordability + dunning schedulers are machine-triggered, no end-user):
 *   - getCustomerByOrg              -> GET /internal/customers/by-org/:orgId
 *   - sumSucceededTopupsForCustomer -> GET /internal/payment_intents/by-org/:orgId
 *   - hasAttachedCardPm             -> GET /internal/payment_methods/by-org/:orgId
 * They mirror the corresponding `/v1/*` reads in shape (passthrough Stripe
 * objects) but key the org off the path and never require x-user-id.
 */

/**
 * DELETE /internal/customers/by-org/:orgId
 *
 * Org-teardown operation. Resolves the org's Stripe customer, deletes it ONLINE
 * at Stripe, then durably tombstones the local silver mirror so the boot-time
 * silver repair (`repairAllSilverFromBronze`) cannot resurrect the row.
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

/**
 * GET /internal/customers/by-org/:orgId
 *
 * The org's mirrored Stripe customer (1:1 org<->customer). DB-mirror read, no
 * Stripe call. Returns the verbatim Stripe customer `raw_json`, or 404 when the
 * org has no customer. Mirrors `GET /v1/customers?limit=1` but org-keyed off the
 * path and user-less. Backs billing-service `getCustomerByOrg`.
 */
router.get(
  "/internal/customers/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;

      const row = await db
        .select()
        .from(customers)
        .where(eq(customers.orgId, orgId))
        .orderBy(desc(customers.syncedAt))
        .limit(1);

      if (row.length === 0 || !row[0].rawJson) {
        return res.status(404).json({ error: "Customer not found" });
      }

      res.locals.stripeObjectId = row[0].id;
      return res.json(row[0].rawJson);
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /internal/payment_intents/by-org/:orgId
 *
 * Every PaymentIntent mirrored for the org, as a Stripe list. DB-mirror read,
 * no Stripe call, no limit (the caller sums succeeded top-ups across the full
 * set). Mirrors `GET /v1/payment_intents` but org-keyed off the path and
 * user-less. Backs billing-service `sumSucceededTopupsForCustomer` (org<->
 * customer is 1:1, so the org filter is the customer filter).
 */
router.get(
  "/internal/payment_intents/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;

      const rows = await db
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.orgId, orgId))
        .orderBy(desc(paymentIntents.syncedAt));

      return res.json({
        object: "list",
        data: rows.map((r) => r.rawJson),
        has_more: false,
        url: `/internal/payment_intents/by-org/${orgId}`,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /internal/payment_methods/by-org/:orgId?type=card
 *
 * Live Stripe `paymentMethods.list` for the org's customer, via the PLATFORM
 * key (single-account model — no end-user to resolve a per-org key against,
 * same as the teardown route above). The customer is resolved from the mirror;
 * 404 when the org has none. Mirrors `GET /v1/payment_methods` but org-keyed off
 * the path and user-less. Backs billing-service `hasAttachedCardPm`.
 */
router.get(
  "/internal/payment_methods/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;
      const type =
        typeof req.query.type === "string" ? req.query.type : undefined;

      const row = await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.orgId, orgId))
        .orderBy(desc(customers.syncedAt))
        .limit(1);

      if (row.length === 0) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const customer = row[0].id;
      res.locals.stripeObjectId = customer;

      const stripe = await getPlatformStripe();
      const params: Stripe.PaymentMethodListParams = { customer };
      if (type) params.type = type as Stripe.PaymentMethodListParams.Type;
      const list = await stripe.paymentMethods.list(params);
      return res.json(list);
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
