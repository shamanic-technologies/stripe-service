import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { cardUpdateOpeners } from "../db/schema";
import { getUserById } from "./client-service-client";
import {
  recordApiSnapshot,
  resolveOrgId,
  extractOrgId,
  extractString,
} from "./event-processor";

/**
 * The Stripe customer's contact email follows the LAST PERSON who actually
 * paid or saved a card for the org.
 *
 * Why: staff (or an agency) create an org for a client, so the org's Stripe
 * customer is born with the CREATOR's email (`POST /v1/customers` stamps the
 * requesting user). The client then joins and pays — and without this, every
 * receipt and payment email Stripe sends keeps going to the creator. The
 * owner's rule: "c'est la dernière personne qui le fait qui reprend".
 *
 * How we know who: the person is known when a payment or card session is
 * OPENED (the identity is on that request) and the success is known only
 * later, from Stripe. So the opener is recorded at open time and adopted only
 * when Stripe reports success:
 *
 *   - Checkout (top-up, or the in-page card setup): the opener rides on the
 *     session's own metadata (`payer_user_id`, also on the SetupIntent a setup
 *     session creates). Exact: that session, that person.
 *   - Billing portal card update: a portal session carries no metadata and the
 *     SetupIntent it creates carries nothing of ours, so the opener is kept in
 *     `card_update_openers` (one row per customer, the latest opener wins) and
 *     CONSUMED when the portal's SetupIntent succeeds.
 *
 * What never changes the email: a read, opening a session, a failed or
 * still-unpaid payment, an off-session automatic top-up (nobody opened
 * anything), and any org nobody pays for. Only the email changes — never the
 * name, never anything else on the customer.
 *
 * Fail loud like the other webhook side-effects: a client-service or Stripe
 * failure propagates. A user with no email on record is not a failure — there
 * is simply nothing to adopt, and the email stays what it was.
 */

export const PAYER_USER_METADATA_KEY = "payer_user_id";

/**
 * A portal opener older than this is not evidence of who added a card. A
 * portal session is used within minutes of being opened; this only stops a
 * forgotten marker from attributing a card added some other way (e.g. by
 * staff in the Stripe dashboard) weeks later.
 */
export const CARD_UPDATE_OPENER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Metadata to stamp on a session the given person opened. Empty for nobody. */
export function payerMetadata(userId: string | null | undefined): Record<string, string> {
  return userId ? { [PAYER_USER_METADATA_KEY]: userId } : {};
}

/** Remember who opened a billing-portal card update for this customer. */
export async function recordCardUpdateOpener(params: {
  customerId: string;
  orgId: string;
  userId: string;
}): Promise<void> {
  const openedAt = new Date();
  await db
    .insert(cardUpdateOpeners)
    .values({
      customerId: params.customerId,
      orgId: params.orgId,
      userId: params.userId,
      openedAt,
    })
    .onConflictDoUpdate({
      target: cardUpdateOpeners.customerId,
      set: { orgId: params.orgId, userId: params.userId, openedAt },
    });
}

/** Take (and delete) the portal opener for a customer, if still fresh. */
async function consumeCardUpdateOpener(customerId: string): Promise<string | null> {
  const rows = await db
    .delete(cardUpdateOpeners)
    .where(eq(cardUpdateOpeners.customerId, customerId))
    .returning({ userId: cardUpdateOpeners.userId, openedAt: cardUpdateOpeners.openedAt });
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.openedAt).getTime() > CARD_UPDATE_OPENER_MAX_AGE_MS) {
    console.log(
      `[stripe-service] card update opener for ${customerId} is stale (${String(row.openedAt)}); not adopting its email`
    );
    return null;
  }
  return row.userId;
}

export function isPayerEmailEvent(type: string): boolean {
  return (
    type === "checkout.session.completed" ||
    type === "checkout.session.async_payment_succeeded" ||
    type === "setup_intent.succeeded"
  );
}

export async function adoptPayerEmailForEvent(
  event: Stripe.Event,
  stripe: Stripe
): Promise<void> {
  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const session = event.data.object as Stripe.Checkout.Session;
    // `unpaid` = an async payment still in flight; it is adopted on
    // `async_payment_succeeded`, never before.
    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      return;
    }
    const customerId = extractString(session.customer);
    const userId = session.metadata?.[PAYER_USER_METADATA_KEY];
    if (!customerId || !userId) return;
    await adoptPayerEmail(stripe, customerId, userId);
    return;
  }

  if (event.type === "setup_intent.succeeded") {
    const si = event.data.object as Stripe.SetupIntent;
    const customerId = extractString(si.customer);
    if (!customerId) return;
    const tagged = si.metadata?.[PAYER_USER_METADATA_KEY];
    if (tagged) {
      await adoptPayerEmail(stripe, customerId, tagged);
      return;
    }
    // A SetupIntent our own card-setup checkout created, opened by a caller
    // that named nobody: there is no person to adopt, and the portal opener
    // belongs to a different session.
    if (si.metadata?.purpose === "card-setup") return;
    const opener = await consumeCardUpdateOpener(customerId);
    if (!opener) return;
    await adoptPayerEmail(stripe, customerId, opener);
  }
}

/**
 * Make `userId`'s email the customer's contact email, and re-mirror it.
 * Idempotent: an email that is already the customer's is left alone.
 */
export async function adoptPayerEmail(
  stripe: Stripe,
  customerId: string,
  userId: string
): Promise<void> {
  const identity = await getUserById(userId);
  const email = identity?.email ?? null;
  if (!email) {
    console.log(
      `[stripe-service] payer ${userId} has no email on record; ${customerId} keeps its email`
    );
    return;
  }

  const customer = await stripe.customers.retrieve(customerId);
  if ((customer as Stripe.DeletedCustomer).deleted === true) return;
  const current = (customer as Stripe.Customer).email ?? null;
  if (current !== null && current.toLowerCase() === email.toLowerCase()) return;

  const updated = await stripe.customers.update(customerId, { email });
  const orgId = await resolveOrgId(extractOrgId(updated.metadata), customerId);
  await recordApiSnapshot(updated, "customer", orgId);
  console.log(
    `[stripe-service] ${customerId} (org=${orgId}) contact email now follows payer ${userId}`
  );
}
