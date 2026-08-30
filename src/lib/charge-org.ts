import type Stripe from "stripe";
import { resolveAcquirer } from "./acquirer";
import {
  createOrder,
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
}): Promise<ChargeResult> {
  const methods = await listCustomerPaymentMethods(params.customerId);
  const chargeable = methods.find((m) => m.id);
  if (!chargeable) throw new NoChargeablePaymentMethod(params.orgId);

  const order = await createOrder({
    amount: params.amount,
    currency: params.currency,
    description: params.description,
    customer_id: params.customerId,
    metadata: { ...(params.metadata ?? {}), org_id: params.orgId },
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

  const state = paid?.state ?? order.state;
  return {
    object: "charge_result",
    org_id: params.orgId,
    acquirer: "revolut",
    reference: order.id,
    status: state === "completed" ? "succeeded" : "failed",
    amount: params.amount,
    currency: params.currency,
    // Revolut has no invoice object. Null is the honest answer, not a gap.
    hosted_document_url: null,
  };
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
