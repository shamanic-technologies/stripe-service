import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db";
import { disputes, paymentIntents, refunds, revolutOrders } from "../db/schema";

/**
 * Platform-wide money movement for `GET /public/stats/billing`.
 *
 * Same truth as the per-org read (`GET /internal/payment_summary/by-org/:orgId`),
 * one level up: what came IN across every org, what went back OUT, and what is
 * therefore still real. Stripe never mutates a payment when money is returned —
 * the PaymentIntent stays `succeeded` for its full `amount_received` and the
 * return lives on a separate Refund or lost Dispute — so summing payments alone
 * over-reports the platform total by exactly the amount returned.
 *
 * Two figures are kept apart on purpose and must NOT be conflated:
 *  - PAID (gross) — what customers were charged. Accounting reports gross, so
 *    `total_paid_cents` keeps its existing meaning, byte-for-byte.
 *  - NET (`paid − returned`) — the spendable credit that actually reached
 *    customers. This is what a consumer should report as "credited".
 *
 * "Money is really gone" reuses the per-payment rule verbatim: only a Refund in
 * status `succeeded` and a Dispute in status `lost` count. A pending refund has
 * not moved yet; a failed/canceled one came back to us; an open or won dispute
 * leaves the funds with us. Because this is a QUERY over current object state
 * and never a stored accumulator, all of those flip on their own with nothing
 * to unwind.
 *
 * EVERY ACQUIRER, not just the first one. Revolut has taken real customer money
 * through this service since 2026-08-30, and a platform cash figure that counts
 * one acquirer answers a question nobody asked. Revolut's half applies the same
 * settled-only rule the Stripe half does — money in is a `payment` order that
 * reached `completed`, money out is a `refund` order that reached `completed`,
 * attributed to the payment it reverses through `related_order_id` — so a
 * refund that failed (eleven have) is simply not `completed` and drops out of
 * the sum on its own. Nothing is excluded for looking like a test: this
 * endpoint has never filtered Stripe test charges and inventing that rule for
 * one acquirer would make the two answer differently.
 *
 * CURRENCY POLICY, stated rather than inherited: every acquirer's minor-unit
 * amounts are summed into ONE scalar, exactly as the pre-existing gross total
 * already summed currencies together. This endpoint is a single cross-org
 * figure by design and there is no currency dimension in its response to widen
 * without breaking consumers. The per-currency truth lives on the per-org
 * summary, which never merges currencies and now also spans both acquirers.
 */

/** A refund/dispute roll-up: platform total plus the two time grains. */
export type ReturnedSums = {
  total: bigint;
  byMonth: Map<string, bigint>;
  byWeek: Map<string, bigint>;
};

export type PlatformReturns = {
  refunded: ReturnedSums;
  disputedLost: ReturnedSums;
};

/** One row of the grouped returns query: a (month, week) pair and its cents. */
export type ReturnedBucketRow = {
  month: Date | string | null;
  week: Date | string | null;
  cents: string | null;
};

/** The ONLY Refund status under which money has actually left our balance. */
const REFUND_SETTLED_STATUS = "succeeded";

/** The ONLY Dispute status under which the funds are gone for good. */
const DISPUTE_SETTLED_STATUS = "lost";

export function formatPeriod(p: Date | string): string {
  if (p instanceof Date) return p.toISOString().slice(0, 10);
  return String(p).slice(0, 10);
}

function emptySums(): ReturnedSums {
  return { total: 0n, byMonth: new Map(), byWeek: new Map() };
}

function addTo(map: Map<string, bigint>, period: string, cents: bigint): void {
  map.set(period, (map.get(period) ?? 0n) + cents);
}

/**
 * Fold the grouped rows into platform total + per-month + per-week sums.
 *
 * A week can straddle two months, so the query groups by BOTH grains at once
 * and each grain is summed independently here — the total is the same either
 * way, which is what keeps `sum(buckets) === total` true for both grains.
 */
export function foldReturnedRows(rows: ReturnedBucketRow[]): ReturnedSums {
  const sums = emptySums();
  for (const row of rows) {
    const cents = BigInt(row.cents ?? "0");
    if (cents === 0n) continue;
    sums.total += cents;
    // A mirrored Stripe object always carries `created`, so both grains are
    // present. Fail loud rather than silently dropping money into no bucket.
    if (row.month == null || row.week == null) {
      throw new Error(
        "returned-amounts bucket row has no period — a mirrored refund/dispute is missing created_stripe"
      );
    }
    addTo(sums.byMonth, formatPeriod(row.month), cents);
    addTo(sums.byWeek, formatPeriod(row.week), cents);
  }
  return sums;
}

/**
 * Returns attributed to a mirrored PaymentIntent, grouped by (month, week).
 *
 * Attribution uses the same join the per-payment reads use: a refund/dispute
 * normally carries `payment_intent`, and Stripe leaves it null for charges not
 * created through a PaymentIntent, so `charge` is matched against the
 * PaymentIntent's `latest_charge` as a fallback. Grouping is over the
 * refund/dispute rows themselves (never the join product), so an object that
 * matches on BOTH keys is still counted once.
 *
 * Only attributed returns count, which is exactly what makes the platform total
 * equal the sum of the per-org totals — those resolve the org by joining
 * through the same PaymentIntent.
 */
async function settledReturnBuckets(
  kind: "refund" | "dispute"
): Promise<ReturnedBucketRow[]> {
  const source = kind === "refund" ? refunds : disputes;
  const settledStatus =
    kind === "refund" ? REFUND_SETTLED_STATUS : DISPUTE_SETTLED_STATUS;
  const piById = alias(paymentIntents, "pi_by_id");
  const piByCharge = alias(paymentIntents, "pi_by_charge");
  const month = sql<Date>`date_trunc('month', to_timestamp(${source.createdStripe}))`;
  const week = sql<Date>`date_trunc('week', to_timestamp(${source.createdStripe}))`;

  return (await db
    .select({
      month,
      week,
      cents: sql<string>`SUM(${source.amount})::text`,
    })
    .from(source)
    .leftJoin(piById, eq(piById.id, source.paymentIntent))
    .leftJoin(piByCharge, eq(piByCharge.latestCharge, source.charge))
    .where(
      and(
        eq(source.status, settledStatus),
        or(isNotNull(piById.id), isNotNull(piByCharge.id))
      )
    )
    .groupBy(month, week)) as ReturnedBucketRow[];
}

/** The ONLY Revolut order state under which the money has actually moved. */
const REVOLUT_SETTLED_STATE = "completed";

/**
 * Revolut payments taken, grouped by (month, week).
 *
 * The vendor keeps payments and refunds in ONE collection discriminated by
 * `type`, so money in is `type = 'payment' AND state = 'completed'` — the same
 * "settled only" rule as the Stripe half, expressed in the vendor's own words.
 *
 * No purpose filter: a card-verification hold never reaches `completed` (it is
 * authorised and then cancelled), and the payments this service DID take are
 * real money the platform received whatever they were for. Filtering by intent
 * here would also silently diverge from the per-org summary, which does not.
 */
async function revolutPaidBuckets(): Promise<ReturnedBucketRow[]> {
  const month = sql<Date>`date_trunc('month', ${revolutOrders.createdAtRevolut})`;
  const week = sql<Date>`date_trunc('week', ${revolutOrders.createdAtRevolut})`;

  return (await db
    .select({
      month,
      week,
      cents: sql<string>`SUM(${revolutOrders.amount})::text`,
    })
    .from(revolutOrders)
    .where(
      and(
        eq(revolutOrders.type, "payment"),
        eq(revolutOrders.state, REVOLUT_SETTLED_STATE)
      )
    )
    .groupBy(month, week)) as ReturnedBucketRow[];
}

/**
 * Revolut money returned, grouped by (month, week).
 *
 * A refund is a top-level order of its own carrying `related_order_id` — the
 * direct analogue of a Stripe Refund's `payment_intent` — and Revolut mints it
 * with no metadata, so it can answer for no tenant by itself. Joining to its
 * parent is therefore both the attribution and the guard that only returns
 * against a payment we actually mirrored are counted, which is exactly what the
 * Stripe half does with its PaymentIntent join.
 *
 * Grouping is over the refund rows themselves, so the parent join can never
 * multiply a return.
 */
async function revolutReturnBuckets(): Promise<ReturnedBucketRow[]> {
  const parent = alias(revolutOrders, "parent_order");
  const month = sql<Date>`date_trunc('month', ${revolutOrders.createdAtRevolut})`;
  const week = sql<Date>`date_trunc('week', ${revolutOrders.createdAtRevolut})`;

  return (await db
    .select({
      month,
      week,
      cents: sql<string>`SUM(${revolutOrders.amount})::text`,
    })
    .from(revolutOrders)
    .innerJoin(parent, eq(parent.id, revolutOrders.relatedOrderId))
    .where(
      and(
        eq(revolutOrders.type, "refund"),
        eq(revolutOrders.state, REVOLUT_SETTLED_STATE)
      )
    )
    .groupBy(month, week)) as ReturnedBucketRow[];
}

/** Add one roll-up into another, per grain. Neither input is mutated. */
export function addSums(a: ReturnedSums, b: ReturnedSums): ReturnedSums {
  const merged: ReturnedSums = {
    total: a.total + b.total,
    byMonth: new Map(a.byMonth),
    byWeek: new Map(a.byWeek),
  };
  for (const [period, cents] of b.byMonth) addTo(merged.byMonth, period, cents);
  for (const [period, cents] of b.byWeek) addTo(merged.byWeek, period, cents);
  return merged;
}

/**
 * Platform-wide money returned, ACROSS ACQUIRERS, per grain.
 *
 * Stripe splits a return into a Refund and a lost Dispute; Revolut has only the
 * refund (no dispute payload has ever been observed on that account, so there
 * is no dispute silver to sum — zero here means "none exist", and it becomes
 * real the moment one does). Revolut refunds therefore land in `refunded`,
 * which keeps `returned = refunded + disputedLost` true on both sides.
 */
export async function platformReturns(): Promise<PlatformReturns> {
  const [refundRows, disputeRows, revolutRefundRows] = await Promise.all([
    settledReturnBuckets("refund"),
    settledReturnBuckets("dispute"),
    revolutReturnBuckets(),
  ]);

  return {
    refunded: addSums(
      foldReturnedRows(refundRows),
      foldReturnedRows(revolutRefundRows)
    ),
    disputedLost: foldReturnedRows(disputeRows),
  };
}

/** Platform-wide Revolut payments taken, per grain. */
export async function revolutPlatformPaid(): Promise<ReturnedSums> {
  return foldReturnedRows(await revolutPaidBuckets());
}

/**
 * Turn a per-period roll-up back into the row shape `mergeGrowth` consumes, so
 * a second acquirer's payments join the series through the same merge as the
 * first one's rather than through a parallel code path.
 */
export function sumsToPaidRows(byPeriod: Map<string, bigint>): PaidBucketRow[] {
  return [...byPeriod].map(([period, cents]) => ({
    period,
    paid_cents: cents.toString(),
  }));
}

/** A gross bucket as it comes back from the payments query. */
export type PaidBucketRow = {
  period: Date | string;
  paid_cents: string | null;
};

/**
 * One period of the growth series. Carries the same gross/net distinction as
 * the all-time totals, so a consumer reading buckets is never forced back to
 * raw payments to work out what was actually credited.
 */
export type GrowthBucket = {
  period: string;
  paid_cents: string;
  refunded_cents: string;
  disputed_lost_cents: string;
  returned_cents: string;
  net_cents: string;
};

/**
 * Merge gross payments with returns into one series per period.
 *
 * TIME ATTRIBUTION — a refund lands in the period it HAPPENED, not the period
 * of the payment it reverses. Stripe's ledger is append-only and so is this
 * one: back-dating a return would retroactively rewrite a bucket a consumer has
 * already read and reported. The consequence is deliberate and must be read as
 * such: a period whose refunds exceed its payments reports a NEGATIVE
 * `net_cents`. Both attributions give `sum(buckets) === all-time total`; only
 * this one leaves history immutable.
 *
 * A period present on one side only is emitted with real zeros on the other —
 * a month with a refund and no payments genuinely took in nothing.
 */
export function mergeGrowth(
  paid: PaidBucketRow[],
  refunded: Map<string, bigint>,
  disputedLost: Map<string, bigint>
): GrowthBucket[] {
  const paidByPeriod = new Map<string, bigint>();
  for (const row of paid) {
    const period = formatPeriod(row.period);
    paidByPeriod.set(
      period,
      (paidByPeriod.get(period) ?? 0n) + BigInt(row.paid_cents ?? "0")
    );
  }

  const periods = new Set<string>([
    ...paidByPeriod.keys(),
    ...refunded.keys(),
    ...disputedLost.keys(),
  ]);

  return [...periods]
    .sort((a, b) => a.localeCompare(b))
    .map((period) => {
      const paidCents = paidByPeriod.get(period) ?? 0n;
      const refundedCents = refunded.get(period) ?? 0n;
      const disputedCents = disputedLost.get(period) ?? 0n;
      const returnedCents = refundedCents + disputedCents;
      return {
        period,
        paid_cents: paidCents.toString(),
        refunded_cents: refundedCents.toString(),
        disputed_lost_cents: disputedCents.toString(),
        returned_cents: returnedCents.toString(),
        net_cents: (paidCents - returnedCents).toString(),
      };
    });
}
