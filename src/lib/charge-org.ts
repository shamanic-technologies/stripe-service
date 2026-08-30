import type Stripe from "stripe";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { revolutOrders } from "../db/schema";
import { resolveAcquirer } from "./acquirer";
import { recordApiSnapshot } from "./event-processor";
import {
  paymentIntentIdFromInvoice,
  paymentIntentProvenance,
} from "./invoice-provenance";
import {
  createOrder,
  getOrder,
  listCustomerPaymentMethods,
  payOrderWithSavedMethod,
} from "./revolut-client";
import { mirrorOrderById } from "./revolut-processor";

/**
 * Charge an org off-session, whichever acquirer holds its card.
 *
 * This is the vendor-neutral answer to the only question a caller actually has:
 * "take this much money from this org". billing does not name an acquirer, does
 * not know one exists, and does not change when a second one appears. Which
 * vendor that means is resolved here from the org's pin.
 *
 * The response is deliberately NOT a Stripe Invoice nor a Revolut Order. Those
 * are vendor objects with no common shape — Revolut has no invoice at all — and
 * returning one dressed as the other is the fabrication this service refuses.
 * What every caller can use is the same four facts: did it work, for how much,
 * in what currency, and what to quote back when asking about it later.
 */
export interface ChargeResult {
  object: "charge_result";
  org_id: string;
  /** Which acquirer took the money. Diagnostic only — do not branch on it. */
  acquirer: "stripe" | "revolut";
  /** The acquirer's own id for this charge, for support and reconciliation. */
  reference: string;
  /** `succeeded` only when the money actually moved. */
  status: "succeeded" | "failed";
  amount: number;
  currency: string;
  /**
   * A hosted document for this charge when the acquirer produces one. Stripe
   * finalizes an invoice with a PDF; Revolut has no invoice object, so this is
   * null for a Revolut org. Null means "this acquirer does not do that", never
   * "it failed" — a caller that needs a document must check for null rather
   * than be handed a fabricated one.
   */
  hosted_document_url: string | null;
}

export class NoChargeablePaymentMethod extends Error {
  constructor(orgId: string) {
    super(`Org ${orgId} has no chargeable saved payment method`);
    this.name = "NoChargeablePaymentMethod";
  }
}

/**
 * Charge a Revolut-pinned org: create the order, then pay it with the card the
 * customer saved for merchant-initiated use.
 *
 * ⚠️ A saved method stops being chargeable off-session once the customer
 * UPDATES their card — Revolut invalidates merchant-initiated eligibility, with
 * no event and no error until the charge itself fails. That is why the method
 * list is read live on every charge rather than cached: a stale cache would
 * make this fail at the acquirer instead of here, where the reason is legible.
 */
export async function chargeViaRevolut(params: {
  orgId: string;
  customerId: string;
  amount: number;
  currency: string;
  description: string;
  metadata?: Record<string, string>;
  /**
   * The caller's stable key for this logical top-up. Stamped on the order's
   * metadata, which is what makes a retry RESUME the order it already created
   * instead of creating a second one and charging the card twice.
   */
  idempotencyKey?: string;
}): Promise<ChargeResult> {
  const methods = await listCustomerPaymentMethods(params.customerId);
  const chargeable = methods.find((m) => m.id);
  if (!chargeable) throw new NoChargeablePaymentMethod(params.orgId);

  // Resume, never re-create. Revolut has no idempotency record of its own, so
  // the key rides on the order's metadata and the mirror is what remembers it:
  // every order this route creates is mirrored in the `finally` below, and the
  // 5-minute poller re-reads anything a crash left unmirrored. A retry that
  // finds a COMPLETED order returns it untouched — the money already moved —
  // and one that finds an unpaid or failed order pays that same order again
  // rather than minting a second one.
  const existing = params.idempotencyKey
    ? await findOrderByIdempotencyKey(params.orgId, params.idempotencyKey)
    : null;
  if (existing) {
    const current = await getOrder(existing).catch(() => null);
    if (current?.state === "completed") {
      await mirrorOrderById(existing, "webhook").catch((err) =>
        console.error(
          `[stripe-service] Revolut charge mirror failed for ${existing}:`,
          err
        )
      );
      return revolutChargeResult(params, existing, "completed");
    }
  }

  const order = existing
    ? { id: existing }
    : await createOrder({
        amount: params.amount,
        currency: params.currency,
        description: params.description,
        customer_id: params.customerId,
        metadata: {
          ...(params.metadata ?? {}),
          org_id: params.orgId,
          ...(params.idempotencyKey
            ? { idempotency_key: params.idempotencyKey }
            : {}),
        },
      });

  let paid;
  try {
    paid = await payOrderWithSavedMethod(
      order.id,
      chargeable.id,
      typeof chargeable.type === "string" ? chargeable.type : "card"
    );
  } finally {
    // Mirror whatever happened, success or failure. A declined charge is a real
    // state the mirror must carry — leaving it out would make a failure
    // indistinguishable from a charge that never ran.
    await mirrorOrderById(order.id, "webhook").catch((err) =>
      console.error(`[stripe-service] Revolut charge mirror failed for ${order.id}:`, err)
    );
  }

  const state = paid?.state ?? ("state" in order ? order.state : undefined);
  return revolutChargeResult(params, order.id, state);
}

function revolutChargeResult(
  params: { orgId: string; amount: number; currency: string },
  orderId: string,
  state: string | undefined
): ChargeResult {
  return {
    object: "charge_result",
    org_id: params.orgId,
    acquirer: "revolut",
    reference: orderId,
    status: state === "completed" ? "succeeded" : "failed",
    amount: params.amount,
    currency: params.currency,
    // Revolut has no invoice object. Null is the honest answer, not a gap.
    hosted_document_url: null,
  };
}

/** The order this org already created for this key, if any. */
async function findOrderByIdempotencyKey(
  orgId: string,
  key: string
): Promise<string | null> {
  const rows = await db
    .select({ id: revolutOrders.id })
    .from(revolutOrders)
    .where(
      and(
        eq(revolutOrders.orgId, orgId),
        sql`${revolutOrders.metadata}->>'idempotency_key' = ${key}`
      )
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Charge a Stripe-pinned org by creating, finalizing and paying a one-line
 * invoice off-session — the charge that produces the hosted invoice + PDF a
 * customer can read back.
 *
 * Every Stripe call is keyed off the caller's own `idempotencyKey`, derived per
 * step, so a retry replays each call from its Stripe idempotency record: no
 * duplicate invoice and no double charge, wherever a prior attempt crashed.
 *
 * Returns the paid Invoice verbatim. `POST /internal/invoices/by-org/:orgId`
 * hands that straight back; the vendor-neutral charge shapes it through
 * `chargeResultFromInvoice`. Both take money exactly the same way.
 */
export async function chargeViaStripeInvoice(params: {
  stripe: Stripe;
  orgId: string;
  customerId: string;
  amount: number;
  currency: string;
  description: string;
  payment_method?: string;
  metadata?: Record<string, string>;
  idempotencyKey: string;
  /**
   * Called as soon as the invoice is PAID, before provenance is stamped, so a
   * caller's audit row still names the object when step 5 fails loudly.
   */
  onPaid?: (invoice: Stripe.Invoice) => void;
}): Promise<Stripe.Invoice> {
  const {
    stripe,
    orgId,
    customerId: customer,
    amount,
    currency,
    description,
    payment_method,
    idempotencyKey,
  } = params;
  const invoiceMetadata = { ...(params.metadata ?? {}), org_id: orgId };

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
      ...(payment_method ? { default_payment_method: payment_method } : {}),
    },
    { idempotencyKey: `${idempotencyKey}:invoice` }
  );

  const invoiceId = draft.id;
  if (!invoiceId) {
    throw new Error("[stripe-service] Stripe returned an invoice with no id");
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
  params.onPaid?.(paid);

  // 5. Carry the caller's provenance onto the PaymentIntent, then mirror it.
  //
  //    Stripe does not copy invoice metadata to the PaymentIntent, so without
  //    this the charge lands as an anonymous `succeeded` payment and a consumer
  //    summing PaymentIntents (billing-service) cannot tell an automatic
  //    platform-initiated charge from a customer-initiated top-up — the
  //    property the pre-invoice bare-PaymentIntent path had.
  //
  //    Fail loud on both steps. The metadata update is the caller's own data,
  //    and the snapshot is the ONLY path that carries it into silver: Stripe
  //    emits no event for a metadata update, so a swallowed failure here would
  //    silently drop the provenance for good (the `payment_intent.succeeded`
  //    webhook already landed, carrying the empty metadata the PI was born
  //    with). Failing is safe precisely because every Stripe step above is
  //    idempotency-keyed: the caller retries the same logical top-up, each
  //    Stripe call replays from its idempotency record, and we reach this step
  //    again with no double charge.
  const piId = paymentIntentIdFromInvoice(paid);
  if (!piId) {
    throw new Error(
      `[stripe-service] Paid invoice ${paid.id} references no PaymentIntent — cannot attach provenance`
    );
  }
  //    The SAME update also carries the caller's `description` onto the
  //    PaymentIntent. Stripe does not copy that either: it stamps its own
  //    generic fallback ("Payment for Invoice") on the PaymentIntent an invoice
  //    creates, and that string — not the invoice's description — is what a
  //    customer reads in a billing history rendered from payments.
  const pi = await stripe.paymentIntents.update(
    piId,
    {
      metadata: paymentIntentProvenance(invoiceMetadata, invoiceId),
      description,
    },
    // Distinct from the historical `:pi-metadata` key on purpose — Stripe
    // rejects a replayed idempotency key whose params changed, and this call's
    // params now include `description`.
    { idempotencyKey: `${idempotencyKey}:pi-provenance` }
  );
  await recordApiSnapshot(pi, "payment_intent", orgId);

  return paid;
}

/** Shape a paid Stripe invoice into the same neutral answer. */
export function chargeResultFromInvoice(
  orgId: string,
  invoice: Stripe.Invoice,
  amount: number,
  currency: string
): ChargeResult {
  return {
    object: "charge_result",
    org_id: orgId,
    acquirer: "stripe",
    reference: invoice.id ?? "",
    status: invoice.status === "paid" ? "succeeded" : "failed",
    amount,
    currency,
    hosted_document_url: invoice.hosted_invoice_url ?? null,
  };
}

/** Which acquirer would take this org's money right now. */
export { resolveAcquirer };
