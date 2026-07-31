import type Stripe from "stripe";

/**
 * Provenance for an off-session invoiced charge.
 *
 * Stripe does NOT copy an Invoice's metadata onto the PaymentIntent it creates
 * when the invoice is paid, and on our API version the PaymentIntent carries no
 * `invoice` back-reference either (the link exists only in the other direction,
 * `invoice.payments[].payment.payment_intent`). So a consumer that sums
 * PaymentIntents — which is what billing-service does — sees an automatic
 * platform-initiated charge as an anonymous `succeeded` payment with empty
 * metadata, indistinguishable from a customer-initiated Checkout top-up.
 *
 * Before the auto-reload moved to the invoice route every automatic charge was a
 * bare PaymentIntent stamped with the caller's own metadata (`{type:
 * "auto_reload"}`), so this is a provenance REGRESSION, not a missing feature.
 * These helpers restore it: the caller's metadata is stamped back onto the
 * resulting PaymentIntent, plus the invoice id so the two objects are joinable
 * from either side.
 */

/** A paid Stripe Invoice, viewed through the two shapes that reference a PI. */
type InvoiceWithPayments = Stripe.Invoice & {
  /** Present on API versions predating the `invoice.payments` list. */
  payment_intent?: string | { id: string } | null;
  payments?: {
    data?: Array<{
      payment?: { payment_intent?: string | { id: string } | null } | null;
    }> | null;
  } | null;
};

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : (ref.id ?? null);
}

/**
 * The PaymentIntent that paid this invoice, or null when the invoice references
 * none. Reads the modern `payments` list first (requires `expand: ["payments"]`
 * on the call that produced the invoice) and falls back to the legacy top-level
 * `payment_intent` field, so the lookup does not depend on the pinned Stripe API
 * version.
 */
export function paymentIntentIdFromInvoice(
  invoice: Stripe.Invoice
): string | null {
  const inv = invoice as InvoiceWithPayments;

  for (const entry of inv.payments?.data ?? []) {
    const piId = idOf(entry?.payment?.payment_intent);
    if (piId) return piId;
  }

  return idOf(inv.payment_intent);
}

/**
 * The metadata to stamp on the PaymentIntent: everything the caller supplied on
 * the invoice, plus the invoice id as a back-reference Stripe itself does not
 * provide on the PaymentIntent.
 *
 * Caller keys are never overwritten by anything except `invoice_id`, which is
 * ours and factual. Nothing is invented — a caller that supplied no metadata
 * gets exactly `{org_id, invoice_id}`.
 */
export function paymentIntentProvenance(
  invoiceMetadata: Record<string, string>,
  invoiceId: string
): Record<string, string> {
  return { ...invoiceMetadata, invoice_id: invoiceId };
}
