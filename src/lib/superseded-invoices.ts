import type Stripe from "stripe";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db";
import { paymentIntents } from "../db/schema";
import { extractString } from "./event-processor";

/**
 * A REFUSED charge attempt must never stay payable once something else stands
 * for the same debt (STALE-CARD-AFTER-REMOVAL-1103, owner relay 2026-11-03).
 *
 * Every off-session charge opens a real Stripe invoice (draft → finalize → pay).
 * When the pay is refused the invoice stays OPEN, with a hosted link the
 * customer can still pay. billing-service then retries the same debt under a
 * new key, so a new invoice is opened and the old one is still payable: the
 * customer could pay the same debt twice (prod 2026-11-03: four open invoices
 * of $50.02 → $58.68 on one customer, each a payable link).
 *
 * Rule: a refused charge attempt is VOIDED as soon as it is superseded —
 *   - a newer attempt is about to pay (`voidRefusedChargeAttempts` before pay),
 *   - a charge succeeded (the same sweep after pay),
 *   - for history: a later successful payment of the same customer exists
 *     (`voidSupersededChargeInvoicesFleet`, at every boot, idempotent).
 *
 * "Refused charge attempt" is read off the invoice itself: open, `attempted`
 * (Stripe tried to collect and failed), charged automatically, stamped with
 * our `org_id`, and not a subscription invoice (subscriptions run their own
 * dunning and are never ours to void). An open invoice nobody tried to pay yet
 * is never touched: it may be an attempt in flight right now.
 */
export function isRefusedChargeAttempt(inv: Stripe.Invoice): boolean {
  // `parent.subscription_details` on API clover, top-level `subscription` before.
  const shaped = inv as Stripe.Invoice & {
    subscription?: unknown;
    parent?: { subscription_details?: unknown } | null;
  };
  return (
    inv.status === "open" &&
    inv.attempted === true &&
    inv.collection_method === "charge_automatically" &&
    typeof inv.metadata?.org_id === "string" &&
    inv.metadata.org_id !== "" &&
    !shaped.parent?.subscription_details &&
    !shaped.subscription
  );
}

/**
 * Void every refused charge attempt of a customer except `keepInvoiceId`.
 * Fail loud: a void that did not happen leaves a payable duplicate, so the
 * caller must hear it (a charge retry is idempotent and re-runs this).
 */
export async function voidRefusedChargeAttempts(
  stripe: Stripe,
  customerId: string,
  keepInvoiceId: string
): Promise<string[]> {
  const voided: string[] = [];
  for await (const inv of stripe.invoices.list({
    customer: customerId,
    status: "open",
    limit: 100,
  })) {
    if (!inv.id || inv.id === keepInvoiceId || !isRefusedChargeAttempt(inv)) continue;
    await stripe.invoices.voidInvoice(inv.id, {}, { idempotencyKey: `void-superseded:${inv.id}` });
    voided.push(inv.id);
  }
  if (voided.length > 0) {
    console.log(
      `[stripe-service] Voided ${voided.length} refused charge attempt(s) of ${customerId} superseded by ${keepInvoiceId}: ${voided.join(", ")}`
    );
  }
  return voided;
}

/**
 * History: void every refused charge attempt whose customer has a LATER
 * successful payment in the mirror (any rail: an invoiced charge or a Checkout
 * top-up). A refused attempt with nothing after it is left alone: the next
 * attempt for that debt supersedes it through the charge flow.
 */
export async function voidSupersededChargeInvoicesFleet(stripe: Stripe): Promise<string[]> {
  const voided: string[] = [];
  for await (const inv of stripe.invoices.list({ status: "open", limit: 100 })) {
    if (!inv.id || !isRefusedChargeAttempt(inv)) continue;
    const customer = extractString(inv.customer as string | { id: string } | null);
    if (!customer) continue;
    const later = await db
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.customer, customer),
          eq(paymentIntents.status, "succeeded"),
          gt(paymentIntents.createdStripe, inv.created)
        )
      )
      .limit(1);
    if (later.length === 0) continue;
    await stripe.invoices.voidInvoice(inv.id, {}, { idempotencyKey: `void-superseded:${inv.id}` });
    voided.push(inv.id);
    console.log(
      `[stripe-service] Voided refused charge attempt ${inv.id} of ${customer}: superseded by payment ${later[0].id}`
    );
  }
  return voided;
}
