import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db";
import { disputes, paymentIntents, refunds } from "../db/schema";

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
 * Currencies are summed together here, exactly as the pre-existing gross total
 * already did — this endpoint is a single cross-org scalar by design. The
 * per-currency truth lives on the per-org summary, which never merges them.
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

/** Platform-wide settled refunds + lost disputes, per grain. */
export async function platformReturns(): Promise<PlatformReturns> {
  const [refundRows, disputeRows] = await Promise.all([
    settledReturnBuckets("refund"),
    settledReturnBuckets("dispute"),
  ]);

  return {
    refunded: foldReturnedRows(refundRows),
    disputedLost: foldReturnedRows(disputeRows),
  };
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
