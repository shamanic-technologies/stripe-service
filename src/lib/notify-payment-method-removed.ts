import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { customers } from "../db/schema";
import { extractString } from "./event-processor";
import {
  PAYMENT_METHOD_REMOVED_EVENT_TYPE,
  sendStaffEmail,
} from "./transactional-email-client";

/**
 * Staff notification: an organisation lost a payment method.
 *
 * There is no "remove card" control in our product — the customer does it in
 * Stripe's own billing portal, so no write path of ours can observe it. The
 * only place the fact is visible is the bronze event ledger, which already
 * receives `payment_method.detached` from both the webhook and the 5-minute
 * unfiltered poll. Payment methods stay unmirrored (they attach and detach
 * without reliably emitting other events, so a local cache drifts); this
 * side-effect reads the event and sends, it stores nothing.
 *
 * Every detach notifies. The remaining chargeable-card count carries the
 * severity: two cards down to one is routine, down to zero means automatic
 * top-up can no longer run.
 *
 * ## Why this never fails the webhook
 *
 * Stripe retries a non-2xx, so an email service that is down would turn into an
 * endless redelivery loop of a notification nobody can receive. This function
 * therefore swallows everything it can go wrong on and returns a boolean.
 * It also takes a Stripe *resolver* rather than a client, unlike the sibling
 * side-effects: resolving the platform key is itself a network call to
 * key-service, and doing it in the caller would put a throwing statement back
 * outside the guard.
 *
 * ## Why one detach is one email
 *
 * `processEvent` runs side-effects only when the bronze insert was new
 * (`ON CONFLICT (id) DO NOTHING` on the Stripe event id). Webhook delivery,
 * webhook redelivery and the poller all carry the same `evt_…`, so the second
 * and third sightings never reach here. The boot re-projection
 * (`repairAllSilverFromBronze`) does not run side-effects at all.
 */

export function isPaymentMethodDetachedEvent(eventType: string): boolean {
  return eventType === "payment_method.detached";
}

export async function notifyPaymentMethodRemoved(
  event: Stripe.Event,
  resolveStripe: () => Promise<Stripe>
): Promise<boolean> {
  try {
    return await notify(event, resolveStripe);
  } catch (err) {
    console.error(
      `[stripe-service] Staff notification for ${event.id} (payment_method.detached) failed and was swallowed so Stripe does not retry:`,
      err
    );
    return false;
  }
}

async function notify(
  event: Stripe.Event,
  resolveStripe: () => Promise<Stripe>
): Promise<boolean> {
  const pm = event.data?.object as Stripe.PaymentMethod | undefined;
  if (!pm?.id) return false;

  const customerId = detachedFromCustomerId(event, pm);
  if (!customerId) {
    console.warn(
      `[stripe-service] payment_method.detached ${event.id}: no previous customer on the event, cannot attribute the removal`
    );
    return false;
  }

  const owner = await lookupCustomer(customerId);
  if (!owner) {
    // Not one of ours, or the org teardown tombstone already landed.
    console.log(
      `[stripe-service] payment_method.detached ${event.id}: customer ${customerId} maps to no organisation of ours, no staff notification`
    );
    return false;
  }

  const stripe = await resolveStripe();

  let cardsRemaining: number;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if ((customer as Stripe.DeletedCustomer).deleted === true) {
      console.log(
        `[stripe-service] payment_method.detached ${event.id}: customer ${customerId} is deleted at Stripe (org teardown), no staff notification`
      );
      return false;
    }
    cardsRemaining = await countChargeableCards(stripe, customerId);
  } catch (err) {
    // Deleting a Stripe customer detaches its payment methods, so a teardown
    // emits this event for every card the org held. By the time we read, the
    // customer is already gone at Stripe — that is the signal, not an error.
    if (isResourceMissing(err)) {
      console.log(
        `[stripe-service] payment_method.detached ${event.id}: customer ${customerId} no longer exists at Stripe (org teardown), no staff notification`
      );
      return false;
    }
    throw err;
  }

  const orgLabel = owner.name || owner.email || owner.orgId;
  const customerLabel = owner.name || owner.email || "no name on file";

  await sendStaffEmail({
    eventType: PAYMENT_METHOD_REMOVED_EVENT_TYPE,
    orgId: owner.orgId,
    metadata: {
      orgId: owner.orgId,
      orgLabel,
      customerId,
      customerLabel,
      customerEmail: owner.email ?? "",
      paymentMethodId: pm.id,
      paymentMethodLabel: describePaymentMethod(pm),
      cardsRemaining: String(cardsRemaining),
      cardsRemainingLabel: cardsRemainingLabel(cardsRemaining),
      impact: impactLine(cardsRemaining),
      removedAt: new Date(event.created * 1000).toISOString(),
      eventId: event.id,
    },
  });

  console.log(
    `[stripe-service] Staff notified: org ${owner.orgId} removed ${pm.id} from ${customerId}, ${cardsRemaining} chargeable card(s) left`
  );
  return true;
}

/**
 * The customer the payment method was removed FROM.
 *
 * Verified against the real prod event `evt_1TzQD1EnlXMXdaZao55dx2VF`
 * (2026-07-31): `data.object.customer` is `null` on a detach and the previous
 * owner is only in `data.previous_attributes.customer`. Read the previous
 * attribute first and keep the object field as a fallback, so the code still
 * works if Stripe ever leaves it populated.
 */
function detachedFromCustomerId(
  event: Stripe.Event,
  pm: Stripe.PaymentMethod
): string | null {
  const previous = (
    event.data as { previous_attributes?: { customer?: unknown } } | undefined
  )?.previous_attributes;
  return (
    extractString(previous?.customer as never) ??
    extractString(pm.customer as never)
  );
}

interface CustomerOwner {
  orgId: string;
  email: string | null;
  name: string | null;
}

async function lookupCustomer(
  customerId: string
): Promise<CustomerOwner | null> {
  const rows = await db
    .select({
      orgId: customers.orgId,
      email: customers.email,
      name: customers.name,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  const row = rows[0];
  if (!row?.orgId || row.orgId === "unknown") return null;
  return { orgId: row.orgId, email: row.email, name: row.name };
}

/**
 * Cards the customer can still be charged with. Card-type only: Stripe refuses
 * Link and other wallet payment methods in off_session mode, so they are not
 * what automatic top-up runs on. Auto-paginated so the count is exact rather
 * than capped at a page.
 */
async function countChargeableCards(
  stripe: Stripe,
  customerId: string
): Promise<number> {
  const ids: string[] = [];
  for await (const card of stripe.paymentMethods.list({
    customer: customerId,
    type: "card",
    limit: 100,
  })) {
    ids.push(card.id);
  }
  return ids.length;
}

function cardsRemainingLabel(count: number): string {
  if (count === 0) return "no chargeable card left";
  if (count === 1) return "1 chargeable card left";
  return `${count} chargeable cards left`;
}

function impactLine(count: number): string {
  return count === 0
    ? "No chargeable card is left on this organisation, so automatic top-up will fail from now on."
    : "Automatic top-up can still run on the remaining card.";
}

/**
 * Enough to recognise the payment method without opening Stripe.
 */
export function describePaymentMethod(pm: Stripe.PaymentMethod): string {
  const card = pm.card;
  if (card?.last4) {
    const brand = humanise(card.brand ?? "card");
    const expiry =
      card.exp_month && card.exp_year
        ? `, expires ${String(card.exp_month).padStart(2, "0")}/${card.exp_year}`
        : "";
    return `${brand} ending ${card.last4}${expiry}`;
  }

  const link = (pm as { link?: { email?: string | null } | null }).link;
  if (link?.email) return `Link (${link.email})`;

  const bank = (
    pm as {
      us_bank_account?: {
        bank_name?: string | null;
        last4?: string | null;
      } | null;
    }
  ).us_bank_account;
  if (bank?.last4) {
    return `${bank.bank_name ?? "Bank account"} ending ${bank.last4}`;
  }

  const type = humanise(pm.type ?? "payment method");
  const email = pm.billing_details?.email;
  return email ? `${type} (${email})` : type;
}

function humanise(value: string): string {
  return value
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isResourceMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "resource_missing";
}
