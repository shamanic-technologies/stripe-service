import { Router, Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { customers } from "../db/schema";
import { getPlatformStripe, recordApiSnapshot } from "../lib/event-processor";
import { isResourceMissing } from "../lib/stripe-client";

const router = Router();

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
