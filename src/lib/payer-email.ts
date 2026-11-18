import type Stripe from "stripe";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { cardUpdateOpeners, checkoutSessions } from "../db/schema";
import { getUserById, joinName } from "./client-service-client";
import {
  recordApiSnapshot,
  resolveOrgId,
  extractOrgId,
  extractString,
} from "./event-processor";
import { alignPaymentMethodEmails } from "./pm-billing-email";

/**
 * The Stripe customer's identity (email AND name) is the PERSON IN FRONT OF IT.
 *
 * Why: staff (or an agency) create an org for a client, so the org's Stripe
 * customer is born with the CREATOR's identity (`POST /v1/customers` stamps the
 * requesting user). Stripe Checkout prefills an existing customer's email and
 * Link then offers to log in AS that email: prod 2026-11-17, a new client
 * (Ethan) opened his $10 top-up and was asked for a code sent to the owner's
 * phone, because the owner had opened a checkout on that org first
 * (ETHAN-STAFF-CHECKOUT-1118). Owner's rules: a client's checkout only ever
 * shows the client's own identity, whoever opened one before (staff included);
 * and receipts follow "la dernière personne qui le fait" (the last payer).
 *
 * Three moments:
 *
 *   1. OPEN (`showOpenerOnCustomer`): before any Checkout Session or billing
 *      portal session is created on a customer for a known person, the
 *      customer takes that person's email + name. Whoever opens sees
 *      themselves, never the previous opener.
 *   2. SUCCESS (`adoptPayerForEvent`): Stripe reports the payment or the card
 *      saved; the payer's identity is (re)applied, then every saved method
 *      still carrying a STAFF email in its billing details takes the payer's
 *      (`pm-billing-email.ts`, BILLING-LINK-PAYMENT-METHOD-1118). The opener rides on the
 *      session's metadata (`payer_user_id`, also on the SetupIntent a setup
 *      session creates); a portal card update carries no metadata, so its
 *      opener is kept in `card_update_openers` and consumed on success.
 *   3. EXPIRY (`restoreLastPayerAfterExpiry`): a checkout opened and abandoned
 *      (a staff test) must not leave its opener as the contact of an org whose
 *      client already pays: when the session expires and the customer still
 *      carries the opener's email, the identity returns to the last person who
 *      completed a checkout on that customer.
 *
 * Never changes the identity: a read, a failed or still-unpaid payment, an
 * off-session automatic top-up (nobody opened anything), an org nobody pays
 * for. A person with no email on record changes nothing. Fail loud: a
 * client-service or Stripe failure propagates (open → 5xx, webhook → retry).
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

export function isPayerIdentityEvent(type: string): boolean {
  return (
    type === "checkout.session.completed" ||
    type === "checkout.session.async_payment_succeeded" ||
    type === "checkout.session.expired" ||
    type === "setup_intent.succeeded"
  );
}

export async function adoptPayerForEvent(
  event: Stripe.Event,
  stripe: Stripe
): Promise<void> {
  if (event.type === "checkout.session.expired") {
    await restoreLastPayerAfterExpiry(event.data.object as Stripe.Checkout.Session, stripe);
    return;
  }

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
    await makeCustomerThePerson(stripe, customerId, userId, "paid");
    await alignPaymentMethodEmails(stripe, customerId);
    return;
  }

  if (event.type === "setup_intent.succeeded") {
    const si = event.data.object as Stripe.SetupIntent;
    const customerId = extractString(si.customer);
    if (!customerId) return;
    const tagged = si.metadata?.[PAYER_USER_METADATA_KEY];
    if (tagged) {
      await makeCustomerThePerson(stripe, customerId, tagged, "saved a card");
      await alignPaymentMethodEmails(stripe, customerId);
      return;
    }
    // A SetupIntent our own card-setup checkout created, opened by a caller
    // that named nobody: there is no person to adopt, and the portal opener
    // belongs to a different session.
    if (si.metadata?.purpose === "card-setup") return;
    const opener = await consumeCardUpdateOpener(customerId);
    if (!opener) return;
    await makeCustomerThePerson(stripe, customerId, opener, "saved a card");
    await alignPaymentMethodEmails(stripe, customerId);
  }
}

/**
 * Moment 1: the person about to see a Checkout or portal page on this customer
 * becomes its identity first, so Stripe prefills (and Link offers) THEIR email,
 * never a previous opener's. No person named = nothing changes.
 */
export async function showOpenerOnCustomer(
  stripe: Stripe,
  customerId: string | null | undefined,
  userId: string | null | undefined
): Promise<void> {
  if (!customerId || !userId) return;
  await makeCustomerThePerson(stripe, customerId, userId, "opened a checkout");
}

/**
 * Moment 3: an abandoned checkout hands the customer back to the last person
 * who completed one on it — only while the customer still carries the
 * abandoning opener's email (anyone who opened since keeps it).
 */
export async function restoreLastPayerAfterExpiry(
  session: Stripe.Checkout.Session,
  stripe: Stripe
): Promise<void> {
  const customerId = extractString(session.customer);
  const opener = session.metadata?.[PAYER_USER_METADATA_KEY];
  if (!customerId || !opener) return;

  const rows = await db
    .select({ payer: sql<string>`${checkoutSessions.metadata}->>${PAYER_USER_METADATA_KEY}` })
    .from(checkoutSessions)
    .where(
      and(
        eq(checkoutSessions.customer, customerId),
        eq(checkoutSessions.status, "complete"),
        isNotNull(sql`${checkoutSessions.metadata}->>${PAYER_USER_METADATA_KEY}`)
      )
    )
    .orderBy(desc(checkoutSessions.createdStripe))
    .limit(1);
  const lastPayer = rows[0]?.payer ?? null;
  if (!lastPayer || lastPayer === opener) return;

  const openerIdentity = await getUserById(opener);
  const openerEmail = openerIdentity?.email ?? null;
  if (!openerEmail) return;
  const customer = await stripe.customers.retrieve(customerId);
  if ((customer as Stripe.DeletedCustomer).deleted === true) return;
  const current = (customer as Stripe.Customer).email ?? null;
  if (current === null || current.toLowerCase() !== openerEmail.toLowerCase()) return;

  await makeCustomerThePerson(stripe, customerId, lastPayer, "was the last payer (abandoned checkout)");
}

/**
 * Make `userId`'s email and name the customer's, and re-mirror it.
 * Idempotent: nothing is written when both already match. A person with no
 * name on record leaves the name alone when the email does not change, and
 * clears it when it does (a different person's name is worse than none).
 * Returns whether the customer was changed.
 */
export async function makeCustomerThePerson(
  stripe: Stripe,
  customerId: string,
  userId: string,
  why: string
): Promise<boolean> {
  const identity = await getUserById(userId);
  const email = identity?.email ?? null;
  if (!identity || !email) {
    console.log(
      `[stripe-service] person ${userId} has no email on record; ${customerId} keeps its identity`
    );
    return false;
  }
  const name = joinName(identity);

  const customer = await stripe.customers.retrieve(customerId);
  if ((customer as Stripe.DeletedCustomer).deleted === true) return false;
  const live = customer as Stripe.Customer;
  const currentEmail = live.email ?? null;
  const currentName = live.name ?? null;
  const emailChanges = currentEmail === null || currentEmail.toLowerCase() !== email.toLowerCase();

  const patch: Stripe.CustomerUpdateParams = {};
  if (emailChanges) patch.email = email;
  if (name !== null) {
    if (name !== currentName) patch.name = name;
  } else if (emailChanges && currentName) {
    patch.name = "";
  }
  if (Object.keys(patch).length === 0) return false;

  const updated = await stripe.customers.update(customerId, patch);
  const orgId = await resolveOrgId(extractOrgId(updated.metadata), customerId);
  await recordApiSnapshot(updated, "customer", orgId);
  console.log(
    `[stripe-service] ${customerId} (org=${orgId}) identity now follows ${userId}, who ${why}`
  );
  return true;
}
