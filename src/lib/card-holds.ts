import type Stripe from "stripe";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { cardHolds, customers } from "../db/schema";
import { resolveAcquirer } from "./acquirer";
import {
  cardDeclineFrom,
  NoChargeablePaymentMethod,
  REVOLUT_FAILED_PAYMENT_STATES,
  resolveStripeChargeablePaymentMethodObject,
} from "./charge-org";
import { getPlatformStripe, recordApiSnapshot } from "./event-processor";
import {
  cancelOrder,
  captureOrder,
  createOrder,
  getOrder,
  listCustomerPaymentMethods,
  payOrderWithSavedMethod,
  type RevolutOrder,
} from "./revolut-client";
import { mirrorOrderById } from "./revolut-processor";

/**
 * AMOUNT HOLDS on an org's saved card — an authorisation the bank accepts or
 * refuses, which moves no money until it is CAPTURED.
 *
 * Why (owner 2026-10-22): a postpaid org saved a debit card, spent on our
 * credit line, and both charges came back "insufficient funds". Saving a card
 * proves nothing about the money behind it. A hold does: the bank blocks the
 * amount or says no, right now, while the customer is still there. Billing
 * decides WHEN to hold and WHAT to do with the answer; this file only places,
 * reads, captures and ends holds, on whichever acquirer holds the org's card.
 *
 * Rules that live here because they are acquirer facts:
 *   - A hold lasts the ACQUIRER's own window and is never renewed. Stripe
 *     states it per charge (`capture_before`, 7 days standard on our account,
 *     extended authorisation is not enabled); Revolut states it per order
 *     (`capture_deadline`, 7 days by default). Both fall back to 7 days only
 *     when the acquirer has not stated a deadline yet.
 *   - A capture of less than the hold settles that amount and releases the
 *     rest (Stripe `amount_to_capture`, Revolut partial capture). It is ONE
 *     capture per hold on both.
 *   - A captured hold IS a payment: a succeeded PaymentIntent / completed order
 *     stamped with the org, so the payment summary, the history and the public
 *     stats count it exactly like a top-up. An uncaptured, released or expired
 *     hold is counted nowhere and shown nowhere (`purpose: "card-hold"`).
 *   - A canceled or expired hold costs us nothing; a captured one costs a
 *     normal charge's fee, declared like any other.
 */

export const CARD_HOLD_PURPOSE = "card-hold";

/** The window we assume until the acquirer states its own deadline. */
export const DEFAULT_HOLD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How long one request waits for a Revolut authorisation to settle. */
export const holdSettleTiming = { intervalMs: 1000, budgetMs: 15_000 };

export type HoldStatus =
  | "pending"
  | "requires_action"
  | "held"
  | "refused"
  | "captured"
  | "released"
  | "expired";

export type HoldSession = "on_session" | "off_session";

export type CardHoldRow = typeof cardHolds.$inferSelect;

/** Statuses in which the acquirer may still hold the customer's money. */
const OPEN_STATUSES: HoldStatus[] = ["pending", "requires_action", "held"];

export class HoldIdempotencyKeyReused extends Error {
  constructor(readonly existing: CardHoldRow) {
    super(
      "Idempotency-Key already used for a hold with a different amount or currency"
    );
    this.name = "HoldIdempotencyKeyReused";
  }
}
export class HoldNotFound extends Error {
  constructor() {
    super("No such card hold for this org");
    this.name = "HoldNotFound";
  }
}
export class HoldNotLive extends Error {
  constructor(readonly hold: CardHoldRow, readonly status: HoldStatus) {
    super(`Card hold is ${status}, it can no longer be captured`);
    this.name = "HoldNotLive";
  }
}
export class HoldAlreadyCaptured extends Error {
  constructor(readonly hold: CardHoldRow) {
    super(
      `Card hold was already captured for ${hold.amountCaptured}; a hold is captured once`
    );
    this.name = "HoldAlreadyCaptured";
  }
}
export class CaptureExceedsHold extends Error {
  constructor(readonly hold: CardHoldRow) {
    super(`Cannot capture more than the ${hold.amount} held`);
    this.name = "CaptureExceedsHold";
  }
}
export class NoAcquirerCustomer extends Error {
  constructor(orgId: string) {
    super(`Org ${orgId} has no customer on its acquirer`);
    this.name = "NoAcquirerCustomer";
  }
}
/** The acquirer has not finished authorising. Retry with the SAME key. */
export class HoldPending extends Error {
  constructor(readonly hold: CardHoldRow) {
    super(
      "The acquirer is still authorising this hold; retry with the same Idempotency-Key"
    );
    this.name = "HoldPending";
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The status a hold has RIGHT NOW. A hold past its deadline is expired the
 * moment the deadline passes, whether or not the sweep has recorded it yet:
 * the acquirer will refuse to capture it, so reading it as live would promise
 * money that is no longer there.
 */
export function effectiveStatus(hold: CardHoldRow, now: Date = new Date()): HoldStatus {
  const status = hold.status as HoldStatus;
  if (
    (status === "held" || status === "requires_action") &&
    hold.expiresAt &&
    hold.expiresAt.getTime() <= now.getTime()
  ) {
    return "expired";
  }
  return status;
}

export interface CardHoldView {
  object: "card_hold";
  id: string;
  org_id: string;
  /** Diagnostic only. Do not branch on it. */
  acquirer: string;
  status: HoldStatus;
  amount: number;
  currency: string;
  amount_captured: number | null;
  session: string;
  expires_at: string | null;
  created_at: string;
  captured_at: string | null;
  ended_at: string | null;
  reference: string | null;
  metadata: Record<string, string> | null;
  /** `requires_action` only: hand to Stripe.js `handleNextAction`. */
  client_secret?: string;
  /** `refused` only: the bank's own reason. */
  failure?: { type: "card_declined"; code: string | null; message: string | null };
}

export function cardHoldView(
  hold: CardHoldRow,
  extra: { clientSecret?: string | null } = {},
  now: Date = new Date()
): CardHoldView {
  const status = effectiveStatus(hold, now);
  return {
    object: "card_hold",
    id: hold.id,
    org_id: hold.orgId,
    acquirer: hold.acquirer,
    status,
    amount: hold.amount,
    currency: hold.currency,
    amount_captured: status === "captured" ? hold.amountCaptured : null,
    session: hold.session,
    expires_at: hold.expiresAt ? hold.expiresAt.toISOString() : null,
    created_at: hold.createdAt.toISOString(),
    captured_at: hold.capturedAt ? hold.capturedAt.toISOString() : null,
    ended_at: hold.endedAt
      ? hold.endedAt.toISOString()
      : status === "expired" && hold.expiresAt
        ? hold.expiresAt.toISOString()
        : null,
    reference: hold.reference,
    metadata: (hold.metadata as Record<string, string> | null) ?? null,
    ...(status === "requires_action" && extra.clientSecret
      ? { client_secret: extra.clientSecret }
      : {}),
    ...(status === "refused"
      ? {
          failure: {
            type: "card_declined" as const,
            code: hold.declineCode,
            message: hold.declineMessage,
          },
        }
      : {}),
  };
}

export async function listCardHolds(orgId: string): Promise<CardHoldRow[]> {
  return db
    .select()
    .from(cardHolds)
    .where(eq(cardHolds.orgId, orgId))
    .orderBy(desc(cardHolds.createdAt));
}

/** The one hold billing may capture right now, if any. Newest live wins. */
export function liveHold(
  holds: CardHoldRow[],
  now: Date = new Date()
): CardHoldRow | null {
  return holds.find((h) => effectiveStatus(h, now) === "held") ?? null;
}

async function findHold(orgId: string, holdId: string): Promise<CardHoldRow> {
  const rows = await db
    .select()
    .from(cardHolds)
    .where(and(eq(cardHolds.orgId, orgId), eq(cardHolds.id, holdId)))
    .limit(1);
  if (!rows[0]) throw new HoldNotFound();
  return rows[0];
}

async function findHoldByKey(
  orgId: string,
  key: string
): Promise<CardHoldRow | null> {
  const rows = await db
    .select()
    .from(cardHolds)
    .where(and(eq(cardHolds.orgId, orgId), eq(cardHolds.idempotencyKey, key)))
    .limit(1);
  return rows[0] ?? null;
}

async function updateHold(
  hold: CardHoldRow,
  patch: Partial<typeof cardHolds.$inferInsert>
): Promise<CardHoldRow> {
  const values = { ...patch, updatedAt: new Date() };
  const rows = await db
    .update(cardHolds)
    .set(values)
    .where(eq(cardHolds.id, hold.id))
    .returning();
  return rows[0] ?? ({ ...hold, ...values } as CardHoldRow);
}

// ---------------------------------------------------------------------------
// Placing
// ---------------------------------------------------------------------------

export interface PlaceHoldParams {
  orgId: string;
  amount: number;
  currency: string;
  session: HoldSession;
  description?: string;
  metadata?: Record<string, string>;
  idempotencyKey: string;
}

export interface PlacedHold {
  hold: CardHoldRow;
  /** Present while Stripe waits for the customer to authenticate. */
  clientSecret: string | null;
  /** False when this call replayed an existing hold for the same key. */
  created: boolean;
}

/**
 * Place a hold on the org's saved card. Answers `held`, `refused` (with the
 * bank's reason), or — Stripe on-session only — `requires_action` with the
 * secret the page uses to run 3-D Secure. Could-not-ask THROWS, so it is never
 * mistaken for a refusal.
 *
 * Idempotent per (org, key): a retry resumes the same hold, never places a
 * second one (Stripe replays the create from its own idempotency record keyed
 * on the hold id; Revolut resumes the order already created).
 */
export async function placeCardHold(params: PlaceHoldParams): Promise<PlacedHold> {
  const currency = params.currency.toLowerCase();
  const existing = await findHoldByKey(params.orgId, params.idempotencyKey);
  if (existing) {
    if (existing.amount !== params.amount || existing.currency !== currency) {
      throw new HoldIdempotencyKeyReused(existing);
    }
    if (existing.status === "pending" || existing.status === "requires_action") {
      const driven = await driveHold(existing);
      return { ...driven, created: false };
    }
    return { hold: existing, clientSecret: null, created: false };
  }

  const pin = await resolveAcquirer(params.orgId);
  let paymentMethod: { id: string; type: string };
  if (pin.acquirer === "revolut") {
    if (!pin.customerId) throw new NoAcquirerCustomer(params.orgId);
    const methods = await listCustomerPaymentMethods(pin.customerId);
    const m = methods.find((x) => x.id);
    if (!m) throw new NoChargeablePaymentMethod(params.orgId);
    paymentMethod = { id: m.id, type: typeof m.type === "string" ? m.type : "card" };
  } else {
    const customerId = await stripeCustomerOf(params.orgId);
    const stripe = await getPlatformStripe();
    const pm = await resolveStripeChargeablePaymentMethodObject(
      stripe,
      params.orgId,
      customerId
    );
    paymentMethod = { id: pm.id, type: pm.type };
  }

  const inserted = await db
    .insert(cardHolds)
    .values({
      orgId: params.orgId,
      acquirer: pin.acquirer,
      paymentMethod: paymentMethod.id,
      amount: params.amount,
      currency,
      status: "pending",
      session: params.session,
      idempotencyKey: params.idempotencyKey,
      description: params.description ?? null,
      metadata: params.metadata ?? null,
    })
    .onConflictDoNothing()
    .returning();
  const hold = inserted[0];
  if (!hold) {
    // A concurrent request with the same key won the insert: answer as its replay.
    return placeCardHold(params);
  }
  const driven = await driveHold(hold, paymentMethod.type);
  return { ...driven, created: true };
}

async function stripeCustomerOf(orgId: string): Promise<string> {
  const row = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.orgId, orgId))
    .orderBy(desc(customers.syncedAt))
    .limit(1);
  if (!row[0]) throw new NoAcquirerCustomer(orgId);
  return row[0].id;
}

/** Push a pending hold as far as the acquirer will answer in this request. */
async function driveHold(
  hold: CardHoldRow,
  paymentMethodType?: string
): Promise<{ hold: CardHoldRow; clientSecret: string | null }> {
  return hold.acquirer === "revolut"
    ? driveRevolutHold(hold, paymentMethodType)
    : driveStripeHold(hold, paymentMethodType);
}

function holdMetadata(hold: CardHoldRow): Record<string, string> {
  return {
    ...((hold.metadata as Record<string, string> | null) ?? {}),
    org_id: hold.orgId,
    purpose: CARD_HOLD_PURPOSE,
    hold_id: hold.id,
  };
}

function holdDescription(hold: CardHoldRow): string {
  return hold.description ?? "Card authorization hold (not charged unless used)";
}

// --- Stripe ---------------------------------------------------------------

async function driveStripeHold(
  hold: CardHoldRow,
  paymentMethodType?: string
): Promise<{ hold: CardHoldRow; clientSecret: string | null }> {
  const stripe = await getPlatformStripe();
  let pi: Stripe.PaymentIntent;
  if (hold.reference) {
    pi = await stripe.paymentIntents.retrieve(hold.reference, {
      expand: ["latest_charge"],
    });
  } else {
    const customer = await stripeCustomerOf(hold.orgId);
    const pmType =
      paymentMethodType ??
      (await stripe.paymentMethods.retrieve(hold.paymentMethod ?? "")).type;
    try {
      // Keyed on the hold's own id, and built only from what the row stored,
      // so a retry replays this exact create from Stripe's idempotency record.
      pi = await stripe.paymentIntents.create(
        {
          amount: hold.amount,
          currency: hold.currency,
          customer,
          payment_method: hold.paymentMethod ?? undefined,
          payment_method_types: [pmType],
          capture_method: "manual",
          confirm: true,
          off_session: hold.session === "off_session",
          description: holdDescription(hold),
          metadata: holdMetadata(hold),
          expand: ["latest_charge"],
        },
        { idempotencyKey: `card-hold:${hold.id}` }
      );
    } catch (err) {
      const failedPi = paymentIntentOfError(err);
      const declined = cardDeclineFrom(err, failedPi?.id ?? null);
      if (!declined) throw err;
      if (failedPi) await recordApiSnapshot(failedPi, "payment_intent", hold.orgId);
      const refused = await updateHold(hold, {
        reference: failedPi?.id ?? hold.reference,
        status: "refused",
        declineCode: declined.code,
        declineMessage: declined.declineMessage,
        endedAt: new Date(),
      });
      return { hold: refused, clientSecret: null };
    }
  }
  return applyStripePaymentIntent(hold, pi);
}

/** A Stripe error thrown on confirm carries the PaymentIntent it refused. */
function paymentIntentOfError(err: unknown): Stripe.PaymentIntent | null {
  const e = err as {
    payment_intent?: Stripe.PaymentIntent;
    raw?: { payment_intent?: Stripe.PaymentIntent };
  } | null;
  const pi = e?.payment_intent ?? e?.raw?.payment_intent ?? null;
  return pi && typeof pi.id === "string" ? pi : null;
}

/** When Stripe will stop letting us capture this PaymentIntent. */
export function stripeCaptureDeadline(pi: Stripe.PaymentIntent): Date {
  const charge =
    pi.latest_charge && typeof pi.latest_charge === "object"
      ? (pi.latest_charge as Stripe.Charge)
      : null;
  const before = charge?.payment_method_details?.card?.capture_before;
  if (typeof before === "number") return new Date(before * 1000);
  return new Date(pi.created * 1000 + DEFAULT_HOLD_WINDOW_MS);
}

async function applyStripePaymentIntent(
  hold: CardHoldRow,
  pi: Stripe.PaymentIntent
): Promise<{ hold: CardHoldRow; clientSecret: string | null }> {
  await recordApiSnapshot(pi, "payment_intent", hold.orgId);
  const base = { reference: pi.id };
  switch (pi.status) {
    case "requires_capture":
      return {
        hold: await updateHold(hold, {
          ...base,
          status: "held",
          expiresAt: stripeCaptureDeadline(pi),
        }),
        clientSecret: null,
      };
    case "requires_action":
    case "requires_confirmation":
      return {
        hold: await updateHold(hold, {
          ...base,
          status: "requires_action",
          expiresAt: new Date(pi.created * 1000 + DEFAULT_HOLD_WINDOW_MS),
        }),
        clientSecret: pi.client_secret ?? null,
      };
    case "succeeded":
      return {
        hold: await updateHold(hold, {
          ...base,
          status: "captured",
          amountCaptured: pi.amount_received,
          capturedAt: hold.capturedAt ?? new Date(),
        }),
        clientSecret: null,
      };
    case "canceled":
      return {
        hold: await updateHold(hold, {
          ...base,
          status:
            hold.status === "released"
              ? "released"
              : hold.status === "held" || hold.status === "requires_action"
                ? "expired"
                : "refused",
          endedAt: hold.endedAt ?? new Date(),
        }),
        clientSecret: null,
      };
    case "requires_payment_method": {
      // The card was refused on an attempt that did not throw (3-D Secure
      // failed in the page, typically). The reason sits on the intent.
      const err = pi.last_payment_error;
      return {
        hold: await updateHold(hold, {
          ...base,
          status: "refused",
          declineCode: err?.decline_code ?? err?.code ?? null,
          declineMessage: err?.message ?? null,
          endedAt: new Date(),
        }),
        clientSecret: null,
      };
    }
    default:
      // `processing`: Stripe has not answered yet.
      return { hold: await updateHold(hold, { ...base }), clientSecret: null };
  }
}

// --- Revolut --------------------------------------------------------------

type RevolutHoldVerdict =
  | { kind: "held"; deadline: Date }
  | { kind: "captured"; amount: number }
  | { kind: "refused"; code: string | null }
  | { kind: "canceled" }
  | { kind: "unpaid" }
  | { kind: "in_flight" };

export function revolutHoldVerdict(order: RevolutOrder): RevolutHoldVerdict {
  const payments = order.payments ?? [];
  const latest = payments[payments.length - 1];
  const reason =
    typeof latest?.decline_reason === "string" && latest.decline_reason
      ? latest.decline_reason
      : null;
  if (order.state === "authorised") {
    const stated = order.capture_deadline ? new Date(order.capture_deadline) : null;
    const deadline =
      stated && !Number.isNaN(stated.getTime())
        ? stated
        : new Date(
            (order.updated_at ? new Date(order.updated_at).getTime() : Date.now()) +
              DEFAULT_HOLD_WINDOW_MS
          );
    return { kind: "held", deadline };
  }
  if (order.state === "completed") {
    return { kind: "captured", amount: typeof order.amount === "number" ? order.amount : 0 };
  }
  if (latest?.state && REVOLUT_FAILED_PAYMENT_STATES.has(latest.state)) {
    return { kind: "refused", code: reason };
  }
  if (order.state === "failed") return { kind: "refused", code: reason };
  if (order.state === "cancelled") return { kind: "canceled" };
  if (!latest) return { kind: "unpaid" };
  return { kind: "in_flight" };
}

async function mirrorQuietly(orderId: string): Promise<void> {
  await mirrorOrderById(orderId, "webhook").catch((err) =>
    console.error(`[stripe-service] Card-hold mirror failed for ${orderId}:`, err)
  );
}

async function driveRevolutHold(
  hold: CardHoldRow,
  paymentMethodType = "card"
): Promise<{ hold: CardHoldRow; clientSecret: string | null }> {
  let current = hold;
  let order: RevolutOrder;
  if (!current.reference) {
    const pin = await resolveAcquirer(hold.orgId);
    if (!pin.customerId) throw new NoAcquirerCustomer(hold.orgId);
    order = await createOrder({
      amount: hold.amount,
      currency: hold.currency,
      description: holdDescription(hold),
      customerId: pin.customerId,
      // Authorise only. Captured later if billing needs the money, else it
      // lapses at the order's capture deadline.
      capture_mode: "manual",
      metadata: { ...holdMetadata(hold), idempotency_key: hold.idempotencyKey },
    });
    current = await updateHold(current, { reference: order.id });
  } else {
    order = await getOrder(current.reference);
  }

  try {
    if (revolutHoldVerdict(order).kind === "unpaid") {
      if (!hold.paymentMethod) throw new NoChargeablePaymentMethod(hold.orgId);
      // Merchant-initiated: the method was saved for merchant use, which is
      // the path proven on this acquirer (see charge-org.ts).
      await payOrderWithSavedMethod(order.id, hold.paymentMethod, paymentMethodType);
    }
    const deadline = Date.now() + holdSettleTiming.budgetMs;
    let verdict: RevolutHoldVerdict;
    for (;;) {
      order = await getOrder(order.id);
      verdict = revolutHoldVerdict(order);
      if (verdict.kind !== "in_flight" && verdict.kind !== "unpaid") break;
      if (Date.now() + holdSettleTiming.intervalMs > deadline) break;
      await new Promise((r) => setTimeout(r, holdSettleTiming.intervalMs));
    }
    current = await applyRevolutVerdict(current, verdict);
  } finally {
    await mirrorQuietly(order.id);
  }
  if (current.status === "pending") throw new HoldPending(current);
  return { hold: current, clientSecret: null };
}

async function applyRevolutVerdict(
  hold: CardHoldRow,
  verdict: RevolutHoldVerdict
): Promise<CardHoldRow> {
  switch (verdict.kind) {
    case "held":
      return updateHold(hold, { status: "held", expiresAt: verdict.deadline });
    case "captured":
      return updateHold(hold, {
        status: "captured",
        amountCaptured: hold.amountCaptured ?? verdict.amount,
        capturedAt: hold.capturedAt ?? new Date(),
      });
    case "refused":
      return updateHold(hold, {
        status: "refused",
        declineCode: verdict.code,
        endedAt: new Date(),
      });
    case "canceled":
      return updateHold(hold, {
        status:
          hold.status === "released"
            ? "released"
            : hold.status === "held"
              ? "expired"
              : "refused",
        endedAt: hold.endedAt ?? new Date(),
      });
    default:
      return hold;
  }
}

// ---------------------------------------------------------------------------
// Capturing, releasing, expiring
// ---------------------------------------------------------------------------

/**
 * Take `amount` (≤ the hold) out of a live hold. The rest is released by the
 * acquirer. Idempotent: the same amount again answers the captured hold.
 */
export async function captureCardHold(params: {
  orgId: string;
  holdId: string;
  amount: number;
}): Promise<CardHoldRow> {
  let hold = await findHold(params.orgId, params.holdId);
  if (hold.status === "captured") {
    if (hold.amountCaptured === params.amount) return hold;
    throw new HoldAlreadyCaptured(hold);
  }
  if (params.amount > hold.amount) throw new CaptureExceedsHold(hold);
  if (hold.status === "pending" || hold.status === "requires_action") {
    hold = (await driveHold(hold).catch((err) => {
      if (err instanceof HoldPending) return { hold: err.hold };
      throw err;
    })).hold;
  }
  const status = effectiveStatus(hold);
  if (status !== "held") throw new HoldNotLive(hold, status);
  if (!hold.reference) throw new HoldNotLive(hold, status);

  if (hold.acquirer === "revolut") {
    // Recorded BEFORE the capture: the mirror reads it to count the order at
    // what was taken rather than at what was authorised.
    hold = await updateHold(hold, { amountCaptured: params.amount });
    let order: RevolutOrder | null = null;
    try {
      await captureOrder(hold.reference!, params.amount);
      const deadline = Date.now() + holdSettleTiming.budgetMs;
      for (;;) {
        order = await getOrder(hold.reference!);
        if (order.state !== "authorised" && order.state !== "processing") break;
        if (Date.now() + holdSettleTiming.intervalMs > deadline) break;
        await new Promise((r) => setTimeout(r, holdSettleTiming.intervalMs));
      }
    } finally {
      await mirrorQuietly(hold.reference!);
    }
    const verdict = order ? revolutHoldVerdict(order) : ({ kind: "in_flight" } as const);
    if (verdict.kind === "captured") {
      return updateHold(hold, { status: "captured", capturedAt: new Date() });
    }
    if (verdict.kind === "canceled") {
      const ended = await applyRevolutVerdict(hold, verdict);
      throw new HoldNotLive(ended, effectiveStatus(ended));
    }
    throw new HoldPending(hold);
  }

  const stripe = await getPlatformStripe();
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.capture(
      hold.reference,
      { amount_to_capture: params.amount },
      { idempotencyKey: `card-hold:${hold.id}:capture:${params.amount}` }
    );
  } catch (err) {
    // The intent is no longer capturable (Stripe released it at its deadline):
    // read it, record what it is, and say so.
    const live = await stripe.paymentIntents.retrieve(hold.reference, {
      expand: ["latest_charge"],
    });
    if (live.status === "requires_capture") throw err;
    const { hold: after } = await applyStripePaymentIntent(hold, live);
    if (after.status === "captured") return after;
    throw new HoldNotLive(after, effectiveStatus(after));
  }
  await recordApiSnapshot(pi, "payment_intent", hold.orgId);
  return updateHold(hold, {
    status: "captured",
    amountCaptured: pi.amount_received,
    capturedAt: new Date(),
  });
}

/** End a hold without taking anything. Idempotent. */
export async function releaseCardHold(params: {
  orgId: string;
  holdId: string;
}): Promise<CardHoldRow> {
  const hold = await findHold(params.orgId, params.holdId);
  if (hold.status === "captured") throw new HoldAlreadyCaptured(hold);
  if (!OPEN_STATUSES.includes(hold.status as HoldStatus)) return hold;
  await cancelAtAcquirer(hold);
  return updateHold(hold, { status: "released", endedAt: new Date() });
}

async function cancelAtAcquirer(hold: CardHoldRow): Promise<void> {
  if (!hold.reference) return;
  if (hold.acquirer === "revolut") {
    const order = await getOrder(hold.reference);
    if (order.state !== "cancelled" && order.state !== "completed" && order.state !== "failed") {
      await cancelOrder(hold.reference);
    }
    await mirrorQuietly(hold.reference);
    return;
  }
  const stripe = await getPlatformStripe();
  const pi = await stripe.paymentIntents.retrieve(hold.reference);
  if (pi.status === "canceled" || pi.status === "succeeded") return;
  const canceled = await stripe.paymentIntents.cancel(hold.reference, {}, {
    idempotencyKey: `card-hold:${hold.id}:cancel`,
  });
  await recordApiSnapshot(canceled, "payment_intent", hold.orgId);
}

/**
 * Record every hold whose deadline passed as `expired`, releasing it at the
 * acquirer when the acquirer has not already done so. Never renews anything.
 * A hold that turns out CAPTURED at the acquirer is recorded as captured.
 */
export async function sweepExpiredCardHolds(now: Date = new Date()): Promise<number> {
  const open = await db
    .select()
    .from(cardHolds)
    .where(inArray(cardHolds.status, OPEN_STATUSES));
  let expired = 0;
  for (const hold of open) {
    const deadline =
      hold.expiresAt ?? new Date(hold.createdAt.getTime() + DEFAULT_HOLD_WINDOW_MS);
    if (deadline.getTime() > now.getTime()) continue;
    try {
      if (hold.acquirer === "stripe" && hold.reference) {
        const stripe = await getPlatformStripe();
        const pi = await stripe.paymentIntents.retrieve(hold.reference);
        if (pi.status === "succeeded") {
          await applyStripePaymentIntent(hold, pi);
          continue;
        }
      }
      if (hold.acquirer === "revolut" && hold.reference) {
        const order = await getOrder(hold.reference);
        if (order.state === "completed") {
          await applyRevolutVerdict(hold, revolutHoldVerdict(order));
          continue;
        }
      }
      await cancelAtAcquirer(hold);
      await updateHold(hold, { status: "expired", endedAt: deadline });
      expired += 1;
    } catch (err) {
      // One hold the acquirer could not answer for must not stop the others;
      // it reads `expired` already and the next sweep retries it.
      console.error(`[stripe-service] Could not expire card hold ${hold.id}:`, err);
    }
  }
  return expired;
}

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function startCardHoldSweeper(): void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    sweepExpiredCardHolds()
      .then((n) => {
        if (n > 0) console.log(`[stripe-service] Card holds expired: ${n}`);
      })
      .catch((err) => console.error("[stripe-service] Card-hold sweep failed:", err))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(tick, 60_000);
  setInterval(tick, SWEEP_INTERVAL_MS);
}
