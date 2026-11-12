import type Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { paymentMethodReads } from "../db/schema";

/**
 * The org-scoped payment-method read that sits on billing-service's spend
 * AUTHORIZE path — and must therefore not turn a burst of authorizes into a
 * burst of Stripe calls.
 *
 * ## Why this exists
 *
 * billing-service answers every `POST /v1/customer_balance/authorize` by
 * composing the org's balance, and that composition asks us — live — whether
 * the org holds a chargeable card (`?type=card`, then `?type=link`, plus a
 * second `?type=card` for the card's country). One authorize is up to three
 * `paymentMethods.list` calls against the platform Stripe account. A service
 * that authorizes once per item (apollo-service's email-find loop) therefore
 * fans a few seconds of work into hundreds of Stripe reads for ONE customer,
 * Stripe answers `429 rate_limit`, and every authorize in the burst came back
 * `502 Failed to compute balance` — spend refused not because anything was
 * unknown, but because we asked the same question hundreds of times at once
 * (prod, 2026-09-25 ~10:04 UTC: 85 refusals for one org).
 *
 * ## What it does — three things, none of them invents an answer
 *
 * 1. **Coalesces.** Concurrent identical reads (same customer, same `type`)
 *    share ONE in-flight Stripe call. A hundred simultaneous authorizes cost
 *    one read.
 * 2. **Remembers a real answer briefly.** A successful Stripe answer is reused
 *    for `PAYMENT_METHOD_READ_TTL_MS`. That is Stripe's own answer, at most that
 *    old — never a default, never a guess. Only SUCCESSES are kept: a failure is
 *    not cached, so the next caller asks again.
 * 3. **Backs off ONCE PER KEY on a rate limit.** A 429 inside the shared call is
 *    retried with backoff by the single flight on behalf of every waiter, so
 *    the retry does not multiply with the burst. If Stripe still refuses, the
 *    error propagates — fail loud, the caller gets no answer rather than a
 *    wrong one (`errorHandler` reports it as a 503 `acquirer_rate_limited`).
 *
 * ## Staleness is bounded AND event-invalidated
 *
 * A remembered answer is dropped the moment we learn it may have changed:
 * every `payment_method.*` event, `setup_intent.succeeded` and
 * `checkout.session.completed` (the events that add or remove a card) call
 * `invalidatePaymentMethodReads(customer)` from the event processor, and so does
 * our own detach route. The TTL is only the ceiling for a change Stripe has not
 * told us about yet (a webhook still in flight — the 5-minute poller is the
 * backstop there). The window a caller can see a superseded answer is therefore
 * the webhook's delivery latency capped at the TTL, and the direction does not
 * matter to billing's gate: its fail-loud contract is about being UNABLE to
 * ask, which this removes, not about seconds of lag on a card someone is
 * adding or removing in another tab.
 *
 * ## Scope
 *
 * This backs the org-keyed READ route only. The charge path (`charge-org.ts`)
 * and our own detach keep reading live: they act on the answer immediately and
 * a stale method there would be a real Stripe refusal rather than a read.
 * In-process state: one stripe-service container on the box, so one cache.
 */

/** How long a successful Stripe answer is reused from MEMORY before the stored
 *  row (below) is asked again. */
export const PAYMENT_METHOD_READ_TTL_MS = 15_000;

/**
 * ## Stored, not only remembered (MON-PAGE-SPEED-2-1112)
 *
 * The answer is also STORED (`payment_method_reads`, one row per customer and
 * type), so a container restart or a quiet org does not send the next read to
 * Stripe: the dashboard's balance read asked Stripe live on every page for any
 * org not read in the last 15 s, and a burst of them took 1-3 s. The row is
 * written when Stripe is read, DELETED the moment a card-changing event arrives
 * (same events as the memory invalidation above), and rewritten right after that
 * event by `refreshPaymentMethodReads` — so the store is fed at webhook time and
 * a read finds the post-event answer already there.
 *
 * `STORED_MAX_AGE_MS` is the ceiling for a change no event told us about: the
 * 5-minute event poller replays any webhook we missed through the same
 * invalidation, so a stored row older than the ceiling is re-read from Stripe
 * (the caller waits, exactly as before), never served.
 */
export const STORED_MAX_AGE_MS = 60 * 60_000;

/** Backoff for a rate-limited shared read: one flight retries on behalf of all
 *  its waiters, so these do not multiply with the burst. */
export const RATE_LIMIT_BACKOFF_MS = [250, 750, 1500] as const;

type PaymentMethodList = Stripe.ApiList<Stripe.PaymentMethod>;

interface Remembered {
  at: number;
  value: PaymentMethodList;
}

const remembered = new Map<string, Remembered>();
const inFlight = new Map<string, Promise<PaymentMethodList>>();
/** Bumped per customer on invalidation, so a flight that started BEFORE the
 *  invalidation cannot write its (possibly superseded) answer back after it. */
const generation = new Map<string, number>();

function keyOf(customer: string, type: string | undefined): string {
  return `${customer}\u0000${type ?? ""}`;
}

export function isStripeRateLimit(err: unknown): boolean {
  const e = err as { type?: unknown; rawType?: unknown; statusCode?: unknown } | null;
  return (
    e?.type === "StripeRateLimitError" ||
    e?.rawType === "rate_limit_error" ||
    e?.statusCode === 429
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listWithBackoff(
  stripe: Stripe,
  params: Stripe.PaymentMethodListParams
): Promise<PaymentMethodList> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await stripe.paymentMethods.list(params);
    } catch (err) {
      if (!isStripeRateLimit(err) || attempt >= RATE_LIMIT_BACKOFF_MS.length) throw err;
      const base = RATE_LIMIT_BACKOFF_MS[attempt];
      await sleep(base + Math.floor(Math.random() * base));
    }
  }
}

/**
 * `paymentMethods.list({ customer, type? })`, coalesced and briefly remembered.
 * Same params and same verbatim Stripe list as a direct call.
 */
export async function listPaymentMethodsForRead(
  stripe: Stripe,
  customer: string,
  type?: string
): Promise<PaymentMethodList> {
  const key = keyOf(customer, type);
  const hit = remembered.get(key);
  if (hit && Date.now() - hit.at < PAYMENT_METHOD_READ_TTL_MS) return hit.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const startedAt = generation.get(customer) ?? 0;
  const flight = readStoredOrStripe(stripe, customer, type, startedAt)
    .then((value) => {
      if ((generation.get(customer) ?? 0) === startedAt) {
        remembered.set(key, { at: Date.now(), value });
      }
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, flight);
  return flight;
}

/** The stored row when it is younger than the ceiling, else Stripe (then stored). */
async function readStoredOrStripe(
  stripe: Stripe,
  customer: string,
  type: string | undefined,
  startedAt: number
): Promise<PaymentMethodList> {
  const [row] = await db
    .select({ body: paymentMethodReads.body, readAt: paymentMethodReads.readAt })
    .from(paymentMethodReads)
    .where(and(eq(paymentMethodReads.customerId, customer), eq(paymentMethodReads.type, type ?? "")))
    .limit(1);
  if (row && Date.now() - new Date(row.readAt).getTime() < STORED_MAX_AGE_MS) {
    return row.body as PaymentMethodList;
  }
  return readStripeAndStore(stripe, customer, type, startedAt);
}

async function readStripeAndStore(
  stripe: Stripe,
  customer: string,
  type: string | undefined,
  startedAt: number
): Promise<PaymentMethodList> {
  const params: Stripe.PaymentMethodListParams = { customer };
  if (type) params.type = type as Stripe.PaymentMethodListParams.Type;
  const value = await listWithBackoff(stripe, params);
  // Never store an answer a card-changing event has superseded while it was in
  // flight. Re-checked after the write: an event landing during the write gets
  // its delete re-applied, so the store never keeps a pre-event answer.
  if ((generation.get(customer) ?? 0) !== startedAt) return value;
  const where = and(eq(paymentMethodReads.customerId, customer), eq(paymentMethodReads.type, type ?? ""));
  const readAt = new Date();
  await db
    .insert(paymentMethodReads)
    .values({ customerId: customer, type: type ?? "", body: value, readAt })
    .onConflictDoUpdate({
      target: [paymentMethodReads.customerId, paymentMethodReads.type],
      set: { body: value, readAt },
    });
  if ((generation.get(customer) ?? 0) !== startedAt) {
    await db.delete(paymentMethodReads).where(where);
  }
  return value;
}

/**
 * Forget every remembered AND stored answer for a customer — its methods may
 * have changed. Resolves once the stored rows are gone; throws when they could
 * not be deleted (the caller must not report the event handled).
 */
export async function invalidatePaymentMethodReads(customer: string): Promise<void> {
  generation.set(customer, (generation.get(customer) ?? 0) + 1);
  const prefix = `${customer}\u0000`;
  for (const key of remembered.keys()) {
    if (key.startsWith(prefix)) remembered.delete(key);
  }
  await db.delete(paymentMethodReads).where(eq(paymentMethodReads.customerId, customer));
}

/** The types a balance read asks for: billing's chargeable-method check is card, then link. */
export const STORED_TYPES = ["card", "link"] as const;

/**
 * Store the post-event answer right after a card-changing event, so the next
 * read finds it instead of asking Stripe. Best-effort by design: a failure here
 * leaves no row, and the next read asks Stripe and stores it (never a guess).
 */
export async function refreshPaymentMethodReads(stripe: Stripe, customer: string): Promise<void> {
  const startedAt = generation.get(customer) ?? 0;
  await Promise.all(STORED_TYPES.map((type) => readStripeAndStore(stripe, customer, type, startedAt)));
}

/**
 * The customer a card-changing Stripe event concerns, or null when the event
 * does not change which methods a customer holds. A detach nulls
 * `data.object.customer` and names the previous owner only in
 * `previous_attributes.customer`, so both are read.
 */
export function customerTouchedByEvent(event: Stripe.Event): string | null {
  const t = event.type;
  if (
    !t.startsWith("payment_method.") &&
    t !== "setup_intent.succeeded" &&
    t !== "checkout.session.completed"
  ) {
    return null;
  }
  const obj = event.data?.object as { customer?: unknown } | undefined;
  const prev = (event.data as { previous_attributes?: { customer?: unknown } })
    ?.previous_attributes;
  const pick = (v: unknown): string | null =>
    typeof v === "string"
      ? v
      : v && typeof (v as { id?: unknown }).id === "string"
        ? (v as { id: string }).id
        : null;
  return pick(obj?.customer) ?? pick(prev?.customer);
}

/** Test-only: start from an empty cache. */
export function resetPaymentMethodReads(): void {
  remembered.clear();
  inFlight.clear();
  generation.clear();
}
