import type Stripe from "stripe";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { customers } from "../db/schema";
import { pinAcquirer, resolveAcquirer, type Acquirer } from "./acquirer";
import {
  extractString,
  getPlatformStripe,
  recordApiSnapshot,
} from "./event-processor";
import { payerMetadata } from "./payer-email";

/**
 * Stripe subscriptions, org-scoped.
 *
 * A subscription is a Stripe capability with no twin on the second acquirer,
 * so everything here is STRIPE ONLY and says so: an org already pinned to
 * another acquirer is refused before anything is written, and an org that is
 * not pinned yet is pinned to Stripe once a subscription checkout exists, so
 * the acquirer rollout can never move it afterwards (a subscription's card
 * lives with Stripe and cannot be charged anywhere else).
 *
 * What this module does NOT know: trial grants, credits, who may raise the
 * amount, when. Those are the caller's business rules. This exposes the Stripe
 * capability, scoped to the org that owns it, and nothing more.
 *
 * Reads are LIVE from Stripe, never mirrored: a subscription changes state on
 * Stripe's clock (trial ending, invoice paid, period rolling) and a caller
 * reading it seconds after a Checkout completes must see the truth. The
 * org -> customer mapping is the mirror's, the same one every by-org read here
 * uses.
 */

/** The org is on an acquirer that has no subscription object. */
export class SubscriptionAcquirerNotStripe extends Error {
  constructor(readonly orgId: string, readonly acquirer: Acquirer) {
    super(
      `Org ${orgId} pays through ${acquirer}, which has no subscriptions; a subscription can only be taken on stripe`
    );
  }
}

/** The org has no Stripe customer to subscribe. */
export class SubscriptionNoCustomer extends Error {
  constructor(readonly orgId: string) {
    super(`Org ${orgId} has no Stripe customer to subscribe; create the customer first`);
  }
}

/** No subscription with that id exists at Stripe. */
export class SubscriptionNotFound extends Error {
  constructor(readonly subscriptionId: string) {
    super(`Subscription ${subscriptionId} not found`);
  }
}

/** The subscription exists but belongs to another org's customer. */
export class SubscriptionNotOwned extends Error {
  constructor(readonly orgId: string, readonly subscriptionId: string) {
    super(`Subscription ${subscriptionId} does not belong to org ${orgId}`);
  }
}

/** The subscription has ended and can no longer be changed. */
export class SubscriptionEnded extends Error {
  constructor(readonly subscriptionId: string, readonly status: string) {
    super(`Subscription ${subscriptionId} has ended (status ${status}) and cannot be changed`);
  }
}

/** A subscription shape this surface does not change (several prices). */
export class SubscriptionShapeUnsupported extends Error {
  constructor(readonly subscriptionId: string, readonly itemCount: number) {
    super(
      `Subscription ${subscriptionId} carries ${itemCount} items; only a single-price subscription can be re-priced here`
    );
  }
}

/** Statuses after which Stripe will never charge the subscription again. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

/**
 * The fields a caller needs to reason about an org's subscription, read off
 * the Stripe object. `subscription` would be the whole object; this is the
 * part a billing decision actually reads, named as Stripe names it.
 */
export interface SubscriptionSummary {
  object: "subscription_summary";
  id: string;
  org_id: string;
  customer: string | null;
  status: Stripe.Subscription.Status;
  /** Monthly amount in minor units, summed over the subscription's prices. */
  amount: number | null;
  currency: string | null;
  interval: string | null;
  interval_count: number | null;
  trial_start: number | null;
  trial_end: number | null;
  current_period_start: number | null;
  /** When the current period ends — the NEXT charge date while active. */
  current_period_end: number | null;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
  ended_at: number | null;
  /** A payment method is set for the subscription (its own, or the customer's default). */
  has_payment_method: boolean;
  default_payment_method: string | null;
  latest_invoice: string | null;
  created: number;
  metadata: Stripe.Metadata;
}

/** Every Stripe customer the mirror maps to this org (newest first). */
export async function orgStripeCustomers(
  orgId: string
): Promise<Array<{ id: string; defaultPaymentMethod: string | null }>> {
  const rows = await db
    .select({ id: customers.id, rawJson: customers.rawJson })
    .from(customers)
    .where(eq(customers.orgId, orgId))
    .orderBy(desc(customers.syncedAt));
  return rows.map((r) => {
    const raw = (r.rawJson ?? {}) as {
      invoice_settings?: { default_payment_method?: unknown } | null;
    };
    return {
      id: r.id,
      defaultPaymentMethod: extractString(
        raw.invoice_settings?.default_payment_method as string | { id: string } | null | undefined
      ),
    };
  });
}

/**
 * Shape a Stripe subscription into the summary. On the API version this
 * service pins (clover), the billing period lives on each ITEM, not on the
 * subscription, so it is read from the items and falls back to the top-level
 * field an older payload may still carry.
 */
export function summarizeSubscription(
  sub: Stripe.Subscription,
  orgId: string,
  customerDefaultPaymentMethod: string | null
): SubscriptionSummary {
  const items = sub.items?.data ?? [];
  let amount: number | null = null;
  let currency: string | null = null;
  let interval: string | null = null;
  let intervalCount: number | null = null;
  let periodStart: number | null = null;
  let periodEnd: number | null = null;
  for (const item of items) {
    const unit = item.price?.unit_amount;
    if (typeof unit === "number") {
      amount = (amount ?? 0) + unit * (item.quantity ?? 1);
    }
    currency = currency ?? item.price?.currency ?? null;
    interval = interval ?? item.price?.recurring?.interval ?? null;
    intervalCount = intervalCount ?? item.price?.recurring?.interval_count ?? null;
    const itemRec = item as unknown as {
      current_period_start?: number;
      current_period_end?: number;
    };
    if (typeof itemRec.current_period_start === "number") {
      periodStart = periodStart === null ? itemRec.current_period_start : Math.min(periodStart, itemRec.current_period_start);
    }
    if (typeof itemRec.current_period_end === "number") {
      periodEnd = periodEnd === null ? itemRec.current_period_end : Math.min(periodEnd, itemRec.current_period_end);
    }
  }
  const legacy = sub as unknown as {
    current_period_start?: number;
    current_period_end?: number;
  };
  if (periodStart === null && typeof legacy.current_period_start === "number") {
    periodStart = legacy.current_period_start;
  }
  if (periodEnd === null && typeof legacy.current_period_end === "number") {
    periodEnd = legacy.current_period_end;
  }

  const ownPm = extractString(
    sub.default_payment_method as string | { id: string } | null | undefined
  );
  const effectivePm = ownPm ?? customerDefaultPaymentMethod;

  return {
    object: "subscription_summary",
    id: sub.id,
    org_id: orgId,
    customer: extractString(sub.customer as string | { id: string } | null),
    status: sub.status,
    amount,
    currency,
    interval,
    interval_count: intervalCount,
    trial_start: sub.trial_start ?? null,
    trial_end: sub.trial_end ?? null,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    cancel_at_period_end: sub.cancel_at_period_end === true,
    cancel_at: sub.cancel_at ?? null,
    canceled_at: sub.canceled_at ?? null,
    ended_at: sub.ended_at ?? null,
    has_payment_method: effectivePm !== null,
    default_payment_method: effectivePm,
    latest_invoice: extractString(
      sub.latest_invoice as string | { id: string } | null | undefined
    ),
    created: sub.created,
    metadata: sub.metadata ?? {},
  };
}

/**
 * Every subscription the org's Stripe customers hold, LIVE, newest first.
 *
 * An org with no Stripe customer, or customers with no subscription, answers
 * an EMPTY list — Stripe (or the mapping) answered, and there is none. A
 * Stripe failure THROWS: "we could not ask" must never read as "none".
 */
export async function listOrgSubscriptions(orgId: string): Promise<SubscriptionSummary[]> {
  const owned = await orgStripeCustomers(orgId);
  if (owned.length === 0) return [];
  const stripe = await getPlatformStripe();
  const out: SubscriptionSummary[] = [];
  for (const customer of owned) {
    let startingAfter: string | undefined;
    for (;;) {
      const page = await stripe.subscriptions.list({
        customer: customer.id,
        status: "all",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const sub of page.data) {
        out.push(summarizeSubscription(sub, orgId, customer.defaultPaymentMethod));
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
  }
  out.sort((a, b) => b.created - a.created);
  return out;
}

/**
 * Retrieve a subscription and prove it is this org's. Ownership is the
 * mapping this service owns (the subscription's customer is one of the org's
 * mirrored customers); a subscription whose own `metadata.org_id` names a
 * DIFFERENT org is refused too, whatever its customer.
 */
async function loadOwnedSubscription(
  stripe: Stripe,
  orgId: string,
  subscriptionId: string
): Promise<{ sub: Stripe.Subscription; customerDefaultPaymentMethod: string | null }> {
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode === 404) {
      throw new SubscriptionNotFound(subscriptionId);
    }
    throw err;
  }
  const owned = await orgStripeCustomers(orgId);
  const customerId = extractString(sub.customer as string | { id: string } | null);
  const match = owned.find((c) => c.id === customerId);
  const stampedOrg = sub.metadata?.org_id;
  if (!match || (typeof stampedOrg === "string" && stampedOrg !== orgId)) {
    throw new SubscriptionNotOwned(orgId, subscriptionId);
  }
  return { sub, customerDefaultPaymentMethod: match.defaultPaymentMethod };
}

/**
 * Change the monthly amount for FUTURE invoices. No proration: nothing is
 * invoiced now, and the next invoice is the first at the new amount. The
 * product and the billing interval stay what they were.
 */
export async function changeSubscriptionAmount(params: {
  orgId: string;
  subscriptionId: string;
  amount: number;
  idempotencyKey?: string;
}): Promise<SubscriptionSummary> {
  const stripe = await getPlatformStripe();
  const { sub, customerDefaultPaymentMethod } = await loadOwnedSubscription(
    stripe,
    params.orgId,
    params.subscriptionId
  );
  if (ENDED_STATUSES.has(sub.status)) {
    throw new SubscriptionEnded(sub.id, sub.status);
  }
  const items = sub.items?.data ?? [];
  if (items.length !== 1) {
    throw new SubscriptionShapeUnsupported(sub.id, items.length);
  }
  const item = items[0];
  const product = extractString(
    item.price.product as string | { id: string } | null
  );
  const recurring = item.price.recurring;
  if (!product || !recurring) {
    throw new SubscriptionShapeUnsupported(sub.id, items.length);
  }
  const updated = await stripe.subscriptions.update(
    sub.id,
    {
      items: [
        {
          id: item.id,
          price_data: {
            currency: item.price.currency,
            product,
            unit_amount: params.amount,
            recurring: {
              interval: recurring.interval,
              interval_count: recurring.interval_count,
            },
          },
        },
      ],
      proration_behavior: "none",
    },
    params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined
  );
  return summarizeSubscription(updated, params.orgId, customerDefaultPaymentMethod);
}

/**
 * Schedule (true) or withdraw (false) cancellation at the end of the current
 * period. Stopping future charges never refunds the current period.
 */
export async function setCancelAtPeriodEnd(params: {
  orgId: string;
  subscriptionId: string;
  cancelAtPeriodEnd: boolean;
}): Promise<SubscriptionSummary> {
  const stripe = await getPlatformStripe();
  const { sub, customerDefaultPaymentMethod } = await loadOwnedSubscription(
    stripe,
    params.orgId,
    params.subscriptionId
  );
  if (ENDED_STATUSES.has(sub.status)) {
    throw new SubscriptionEnded(sub.id, sub.status);
  }
  if (sub.cancel_at_period_end === params.cancelAtPeriodEnd) {
    return summarizeSubscription(sub, params.orgId, customerDefaultPaymentMethod);
  }
  const updated = await stripe.subscriptions.update(sub.id, {
    cancel_at_period_end: params.cancelAtPeriodEnd,
  });
  return summarizeSubscription(updated, params.orgId, customerDefaultPaymentMethod);
}

/**
 * Decide, WITHOUT side effects, that an org's subscription checkout goes
 * through Stripe. Deliberately NOT `selectAcquirerForCheckout`: the rollout
 * there can pin a new org to the second acquirer as a side effect, and a
 * subscription must never cause that. An org pinned elsewhere is refused.
 */
export async function assertSubscriptionAcquirer(
  orgId: string
): Promise<{ pinned: boolean }> {
  const pin = await resolveAcquirer(orgId);
  if (pin.acquirer !== "stripe") {
    throw new SubscriptionAcquirerNotStripe(orgId, pin.acquirer);
  }
  return { pinned: pin.pinned };
}

/**
 * Once a subscription checkout exists, keep the org on Stripe for good: pin
 * it explicitly so the rollout (which only ever selects UNPINNED orgs) can
 * never move it. Only after Stripe accepted the session — a refused request
 * leaves no trace.
 */
export async function pinOrgToStripeForSubscription(
  orgId: string,
  alreadyPinned: boolean
): Promise<void> {
  if (alreadyPinned) return;
  await pinAcquirer({ orgId, acquirer: "stripe" });
}

export interface SubscriptionCheckoutParams {
  orgId: string;
  amount: number;
  currency: string;
  trialPeriodDays: number;
  uiMode: "hosted" | "embedded";
  successUrl?: string;
  cancelUrl?: string;
  returnUrl?: string;
  productName?: string;
  metadata?: Record<string, string>;
  payerUserId: string | null;
  idempotencyKey?: string;
}

/**
 * A Checkout Session in subscription mode, monthly, at the stated amount,
 * card collection REQUIRED (also during a free trial), on the org's own Stripe
 * customer. `org_id` is stamped on the session AND on the subscription, so
 * every object Stripe derives from it routes back to the org.
 */
export async function createSubscriptionCheckout(
  params: SubscriptionCheckoutParams
): Promise<Stripe.Checkout.Session> {
  const { pinned } = await assertSubscriptionAcquirer(params.orgId);
  const owned = await orgStripeCustomers(params.orgId);
  if (owned.length === 0) throw new SubscriptionNoCustomer(params.orgId);
  const customerId = owned[0].id;

  const tagging = {
    ...(params.metadata ?? {}),
    purpose: "subscription",
    org_id: params.orgId,
  };
  const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
    metadata: tagging,
  };
  if (params.trialPeriodDays > 0) {
    subscriptionData.trial_period_days = params.trialPeriodDays;
    // Card is mandatory: a trial that somehow ends with no method cancels
    // instead of producing an unpayable invoice.
    subscriptionData.trial_settings = {
      end_behavior: { missing_payment_method: "cancel" },
    };
  }

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    customer: customerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: params.currency,
          unit_amount: params.amount,
          recurring: { interval: "month" },
          product_data: { name: params.productName ?? "Distribute subscription" },
        },
      },
    ],
    // Collect a card even when nothing is due today (the trial).
    payment_method_collection: "always",
    subscription_data: subscriptionData,
    metadata: { ...tagging, ...payerMetadata(params.payerUserId) },
  };
  if (params.uiMode === "embedded") {
    sessionParams.ui_mode = "embedded";
    if (params.returnUrl) {
      sessionParams.return_url = params.returnUrl;
    } else {
      sessionParams.redirect_on_completion = "never";
    }
  } else {
    sessionParams.success_url = params.successUrl;
    if (params.cancelUrl) sessionParams.cancel_url = params.cancelUrl;
  }

  const stripe = await getPlatformStripe();
  const session = await stripe.checkout.sessions.create(
    sessionParams,
    params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined
  );
  await recordApiSnapshot(session, "checkout_session", params.orgId);
  await pinOrgToStripeForSubscription(params.orgId, pinned);
  return session;
}
