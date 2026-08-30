import { Router, Request, Response, NextFunction } from "express";
import { and, eq, desc, lt } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db";
import { customers, paymentIntents } from "../db/schema";
import {
  getPlatformStripe,
  recordApiSnapshot,
  resolveOrgId,
} from "../lib/event-processor";
import { isResourceMissing } from "../lib/stripe-client";
import {
  returnedByPaymentIntent,
  summarizeByCurrency,
  withReturnedAmounts,
  type SummaryPayment,
} from "../lib/returned-amounts";
import {
  paymentIntentIdFromInvoice,
  paymentIntentProvenance,
} from "../lib/invoice-provenance";
import {
  CreateInvoiceByOrgRequestSchema,
  UpdateCustomerMetadataRequestSchema,
} from "../schemas";

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
 * GET /internal/customers/by-org/:orgId/all
 *
 * EVERY Stripe customer mirrored for the org, as a Stripe list. The sibling
 * route above returns the ONE customer the 1:1 invariant promises; this one
 * returns all of them, because history does not always honour that promise.
 * `POST /v1/customers` has been idempotent per org since #92, but orgs that
 * predate it can hold more than one `cus_…` — 4 of them in production at the
 * time of writing. A caller reassigning an org's customers has to see all of
 * them or it silently strands the ones it never listed.
 *
 * Callers do NOT store `cus_…` (this service owns the org<->customer mapping),
 * so "which customers belong to this org" is a question only we can answer.
 * The answer comes from the `org_id` column rather than from a
 * `metadata[org_id]` filter: the column IS the mapping, it is what every other
 * org-scoped read here uses, and it stays right even for a row whose Stripe
 * metadata was never stamped. (They agree in production today — 0 of 129 rows
 * differ — so this is the same set, resolved through the mapping we own rather
 * than through the vendor's metadata.)
 *
 * DB-mirror read, no Stripe call, no limit and no pagination: an org holds a
 * handful of customers, not a page of them. An org with none gets an empty
 * list, not a 404 — "this org has no customers" is a fine answer to a list.
 */
router.get(
  "/internal/customers/by-org/:orgId/all",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;

      const rows = await db
        .select()
        .from(customers)
        .where(eq(customers.orgId, orgId))
        .orderBy(desc(customers.syncedAt));

      if (rows.length > 0) res.locals.stripeObjectId = rows[0].id;

      return res.json({
        object: "list",
        data: rows.map((r) => r.rawJson).filter((raw) => raw !== null),
        has_more: false,
        url: `/internal/customers/by-org/${orgId}/all`,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * POST /internal/customers/:id/metadata
 *
 * Rewrite a Stripe customer's metadata with no end-user identity. The `/v1`
 * twin (`POST /v1/customers/:id`) resolves a per-org-per-user Stripe key, so a
 * machine caller cannot reach it — and the workaround for that was a zero-uuid
 * `x-user-id`, which is exactly what the `/internal/*` tier exists to make
 * unnecessary (#77). Platform key, org keyed off the customer, same as every
 * other route in this file.
 *
 * Deliberately metadata-ONLY rather than a user-less mirror of the whole
 * customer update. A user-less write surface should be as narrow as the need,
 * and the need is the org<->customer mapping, which lives in metadata. Widen it
 * when something actually needs more, not in advance.
 *
 * `metadata` is forwarded verbatim, so Stripe's own semantics apply unchanged:
 * keys are MERGED into what is already there, and a key set to the empty string
 * is deleted. This is a passthrough, not a replace — a caller that wants the
 * final shape sends the final shape.
 *
 * Re-mirrors through `recordApiSnapshot`, so silver follows the write instead
 * of waiting for a webhook. That matters here more than usual: rewriting
 * `metadata.org_id` MOVES the customer between tenants, and the org the row
 * gets projected under is resolved from the UPDATED object — so the mirror
 * lands on the new owner in the same request, not on the next `customer.updated`
 * delivery.
 *
 * Fail loud: unknown customer -> 404, any other Stripe error propagates.
 */
router.post(
  "/internal/customers/:id/metadata",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = UpdateCustomerMetadataRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid request", details: parsed.error.flatten() });
      }

      const { id } = req.params;
      res.locals.stripeObjectId = id;

      const stripe = await getPlatformStripe();
      const customer = await stripe.customers.update(id, {
        metadata: parsed.data.metadata,
      });

      // The org the mirror row belongs to AFTER the write — a metadata.org_id
      // rewrite is a tenant move, and silver has to land on the new owner.
      const orgId = await resolveOrgId(
        (customer.metadata?.org_id as string | undefined) ?? null,
        customer.id
      );
      res.locals.orgId = orgId;

      await recordApiSnapshot(customer, "customer", orgId);
      return res.json(customer);
    } catch (err) {
      if (isResourceMissing(err)) {
        return res.status(404).json({ error: "Customer not found" });
      }
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
 * customer is 1:1, so the org filter is the customer filter) AND, via
 * api-service `GET /v1/billing/payments`, the dashboard's payment history.
 *
 * Each entry carries the verbatim Stripe PaymentIntent PLUS the derived
 * `amount_refunded` / `amount_disputed_lost` / `amount_returned` fields, so the
 * same read that shows a payment also says how much of it came back. Stripe
 * leaves the PaymentIntent untouched on a refund (it stays `succeeded` at full
 * `amount_received`), so without these a fully refunded top-up is
 * indistinguishable from a live one.
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

      const returned = await returnedByPaymentIntent(
        rows.map((r) => ({ id: r.id, latestCharge: r.latestCharge }))
      );

      return res.json({
        object: "list",
        data: rows.map((r) => withReturnedAmounts(r.rawJson, returned.get(r.id))),
        has_more: false,
        url: `/internal/payment_intents/by-org/${orgId}`,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /internal/payment_summary/by-org/:orgId
 *
 * What the org paid us, what we gave back, and what is therefore still real
 * money — per currency, from the DB mirrors only (no Stripe call, no end-user
 * identity). Backs billing-service's balance path, where the caller is a
 * machine (affordability gate, dunning scheduler) with no end user.
 *
 * Stripe never mutates a payment when money is returned: the PaymentIntent
 * stays `succeeded` for its full `amount_received` and the return lives on a
 * separate Refund or Dispute object. Summing payments alone therefore
 * over-reports what an org actually holds by exactly the amount refunded.
 *
 * `amount_received` uses the same predicate billing already applies to sum
 * top-ups, so an org with no refunds reports `amount_net === amount_received`.
 * `amount_returned` = succeeded Refunds + LOST Disputes, both read live from
 * the mirrors, so partial refunds, reverted refunds and dispute outcomes are
 * correct without any reconciliation step.
 *
 * This is Stripe money movement ONLY — it is NOT a credit balance. Promo
 * grants and usage stay billing-service's business; this endpoint has no
 * knowledge of them.
 *
 * An org with no mirrored payments returns `totals: []` (and `customer: null`
 * when it has no Stripe customer) rather than a fabricated zero row.
 *
 * `?as_of=<unix seconds>` answers the same question AS OF a moment: what the
 * org had paid, net of what had come back, at that second. Both sides of the
 * subtraction are bounded — payments AND returns Stripe created strictly
 * before it — so the answer is the one this endpoint would itself have given
 * then, and `as_of` at the current second is the unbounded answer. That is the
 * time attribution the rest of this service already uses: a return belongs to
 * the moment it HAPPENED and is never back-dated onto the payment it reverses,
 * because back-dating rewrites a figure a consumer has already read.
 *
 * The bound is EXCLUSIVE, so a launch instant `T` splits history cleanly: what
 * `as_of=T` counts is exactly what happened before the launch, and a payment
 * made at `T` itself is post-launch. An object with no `created_stripe` cannot
 * be placed in time and is excluded from a bounded read (an unbounded read
 * still counts it) — the same rule for payments and for returns, so the two
 * sides of `amount_net` can never be drawn from different populations.
 *
 * `as_of` is echoed back (null when absent) so a caller can tell a deploy that
 * APPLIED the bound from one that never knew about it — the two would
 * otherwise be indistinguishable, and the second silently over-counts.
 *
 * Fail loud: an `as_of` that is not a positive integer is a 400, never a
 * silently ignored filter. A dropped bound would answer a different question
 * than the one asked and read as a correct answer.
 */
router.get(
  "/internal/payment_summary/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;

      const asOfParam = req.query.as_of;
      let asOf: number | undefined;
      if (asOfParam !== undefined) {
        const parsed =
          typeof asOfParam === "string" ? Number(asOfParam) : Number.NaN;
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          return res.status(400).json({
            error:
              "as_of must be a positive integer number of seconds since the Unix epoch",
          });
        }
        asOf = parsed;
      }

      const [piRows, customerRow] = await Promise.all([
        db
          .select({
            id: paymentIntents.id,
            currency: paymentIntents.currency,
            status: paymentIntents.status,
            amountReceived: paymentIntents.amountReceived,
            latestCharge: paymentIntents.latestCharge,
          })
          .from(paymentIntents)
          .where(
            asOf === undefined
              ? eq(paymentIntents.orgId, orgId)
              : and(
                  eq(paymentIntents.orgId, orgId),
                  lt(paymentIntents.createdStripe, asOf)
                )
          ),
        db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.orgId, orgId))
          .orderBy(desc(customers.syncedAt))
          .limit(1),
      ]);

      const payments: SummaryPayment[] = piRows;
      const returned = await returnedByPaymentIntent(payments, asOf);
      const customer = customerRow.length > 0 ? customerRow[0].id : null;
      if (customer) res.locals.stripeObjectId = customer;

      return res.json({
        object: "payment_summary",
        org_id: orgId,
        customer,
        as_of: asOf ?? null,
        totals: summarizeByCurrency(payments, returned),
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

/**
 * POST /internal/invoices/by-org/:orgId
 *
 * Charge an org's Stripe customer OFF-SESSION for a top-up in a way that
 * produces a FINALIZED, PAID Stripe invoice (hosted invoice + PDF, visible in
 * the customer's billing-portal invoice list + Stripe invoice history, emailed
 * like any Stripe invoice). Backs billing-service's automatic "auto-topup"
 * reload path, which today charges via a bare off_session PaymentIntent and so
 * leaves the customer with no invoice document. Manual (interactive Checkout)
 * top-ups already produce an invoice; this closes the gap for the automatic one.
 *
 * Drives Stripe: create draft invoice -> attach one line item -> finalize ->
 * pay off_session. Uses the PLATFORM key (single-account model — no end-user to
 * resolve a per-org key against, same as the teardown / balance reads above).
 *
 * Idempotent: the caller's mandatory `Idempotency-Key` header is derived per
 * Stripe step (`:invoice` / `:item` / `:finalize` / `:pay`), so a retried call
 * for the same logical top-up replays each Stripe call from its idempotency
 * record — no duplicate invoice, no double charge — regardless of where a prior
 * attempt crashed. Missing header -> 400 (we cannot promise no-double-charge
 * without a stable caller key).
 *
 * Provenance: caller `metadata` is stamped on the invoice AND, after payment,
 * on the resulting PaymentIntent (plus `invoice_id`). Stripe copies neither
 * direction itself, and consumers read payments — see `lib/invoice-provenance`.
 * The caller's `description` rides along on that same PaymentIntent update, so
 * the payment reads as the caller wrote it instead of Stripe's generic
 * "Payment for Invoice" fallback in a customer-facing billing history.
 *
 * Fail loud: a customer-less org -> 404 (no Stripe call); any Stripe error
 * (e.g. card declined off_session) propagates -> non-2xx -> caller retries.
 * Returns the paid Stripe Invoice object verbatim (with `payments` expanded).
 */
router.post(
  "/internal/invoices/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId; // surface in api_call_log audit row

      const parsed = CreateInvoiceByOrgRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid request", details: parsed.error.flatten() });
      }

      const idempotencyHeader = req.headers["idempotency-key"];
      const idempotencyKey =
        typeof idempotencyHeader === "string" ? idempotencyHeader.trim() : "";
      if (!idempotencyKey) {
        return res.status(400).json({
          error:
            "Idempotency-Key header is required (guarantees no double-charge on retry)",
        });
      }

      const { amount, currency, description, payment_method, metadata } =
        parsed.data;

      // Resolve the org's Stripe customer (1:1 org<->customer).
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

      const stripe = await getPlatformStripe();
      const invoiceMetadata = { ...(metadata ?? {}), org_id: orgId };

      // 1. Draft invoice. `charge_automatically` + no `auto_advance` so WE drive
      //    finalize + pay explicitly (synchronous, off-session).
      //    `pending_invoice_items_behavior: "exclude"` so ONLY the item we
      //    explicitly attach below lands on this invoice — never a stray pending
      //    item the customer may have from another flow.
      const draft = await stripe.invoices.create(
        {
          customer,
          collection_method: "charge_automatically",
          auto_advance: false,
          currency,
          description,
          pending_invoice_items_behavior: "exclude",
          metadata: invoiceMetadata,
          ...(payment_method
            ? { default_payment_method: payment_method }
            : {}),
        },
        { idempotencyKey: `${idempotencyKey}:invoice` }
      );

      const invoiceId = draft.id;
      if (!invoiceId) {
        throw new Error(
          "[stripe-service] Stripe returned an invoice with no id"
        );
      }

      // 2. Single line item, explicitly bound to this invoice.
      await stripe.invoiceItems.create(
        { customer, invoice: invoiceId, amount, currency, description },
        { idempotencyKey: `${idempotencyKey}:item` }
      );

      // 3. Finalize (draft -> open; generates the hosted invoice URL + PDF).
      await stripe.invoices.finalizeInvoice(
        invoiceId,
        {},
        { idempotencyKey: `${idempotencyKey}:finalize` }
      );

      // 4. Pay off-session against the customer's stored card. `expand:
      //    ["payments"]` because the paid invoice's `payments` list is the ONLY
      //    reference to the PaymentIntent Stripe creates for it — on this API
      //    version the PaymentIntent has no `invoice` field at all.
      const paid = await stripe.invoices.pay(
        invoiceId,
        {
          off_session: true,
          expand: ["payments"],
          ...(payment_method ? { payment_method } : {}),
        },
        { idempotencyKey: `${idempotencyKey}:pay` }
      );

      res.locals.stripeObjectId = paid.id;

      // 5. Carry the caller's provenance onto the PaymentIntent, then mirror it.
      //
      //    Stripe does not copy invoice metadata to the PaymentIntent, so
      //    without this the charge lands as an anonymous `succeeded` payment and
      //    a consumer summing PaymentIntents (billing-service) cannot tell an
      //    automatic platform-initiated charge from a customer-initiated
      //    top-up — the property the pre-invoice bare-PaymentIntent path had.
      //
      //    Fail loud on both steps. The metadata update is the caller's own
      //    data, and the snapshot is the ONLY path that carries it into silver:
      //    Stripe emits no event for a metadata update, so a swallowed failure
      //    here would silently drop the provenance for good (the
      //    `payment_intent.succeeded` webhook already landed, carrying the empty
      //    metadata the PI was born with). Failing is safe precisely because
      //    every Stripe step above is idempotency-keyed: the caller retries the
      //    same logical top-up, each Stripe call replays from its idempotency
      //    record, and we reach this step again with no double charge.
      const piId = paymentIntentIdFromInvoice(paid);
      if (!piId) {
        throw new Error(
          `[stripe-service] Paid invoice ${paid.id} references no PaymentIntent — cannot attach provenance`
        );
      }
      //    The SAME update also carries the caller's `description` onto the
      //    PaymentIntent. Stripe does not copy that either: it stamps its own
      //    generic fallback ("Payment for Invoice") on the PaymentIntent an
      //    invoice creates, and that string — not the invoice's description —
      //    is what a customer reads in a billing history rendered from
      //    payments. The caller already wrote a human description for the
      //    invoice + its line item; this is the same string, on the object
      //    consumers actually read.
      const pi = await stripe.paymentIntents.update(
        piId,
        {
          metadata: paymentIntentProvenance(invoiceMetadata, invoiceId),
          description,
        },
        // Distinct from the historical `:pi-metadata` key on purpose — Stripe
        // rejects a replayed idempotency key whose params changed, and this
        // call's params now include `description`.
        { idempotencyKey: `${idempotencyKey}:pi-provenance` }
      );
      await recordApiSnapshot(pi, "payment_intent", orgId);

      return res.json(paid);
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
