import type Stripe from "stripe";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { stripeFeeTransactions } from "../db/schema";
import { extractString } from "./event-processor";
import { revolutFeeUsdCents, stripeFeeUsdCents } from "./fee-usd";

/**
 * What the acquirers KEPT of our customers' money, per org and per UTC month,
 * since inception — the fee we ABSORB.
 *
 * Owner 2026-10-13: the customer pays its campaign spend and nothing else; card
 * fees are the platform's cost. The fee is therefore declared to runs-service on
 * an ORG-LESS run (an org there would be a charge), which leaves runs-service
 * unable to say whose payment a fee came from. This is where that answer lives:
 * the Stripe fee mirror joined to the payment it belongs to, and the Revolut fee
 * already on the order. Read only, no acquirer call.
 */

const UNATTRIBUTED_ORG = "unknown";

/** Mirror one fee-bearing balance transaction. Idempotent on its id. */
export async function recordStripeFeeTransaction(
  bt: Stripe.BalanceTransaction
): Promise<void> {
  if (!bt.fee) return;
  const row = {
    id: bt.id,
    type: bt.type,
    source: extractString(bt.source as never),
    fee: bt.fee,
    currency: bt.currency.toLowerCase(),
    createdStripe: bt.created,
    rawJson: bt as unknown as Record<string, unknown>,
    syncedAt: new Date(),
  };
  await db
    .insert(stripeFeeTransactions)
    .values(row)
    .onConflictDoUpdate({
      target: stripeFeeTransactions.id,
      set: {
        type: row.type,
        source: row.source,
        fee: row.fee,
        currency: row.currency,
        createdStripe: row.createdStripe,
        rawJson: row.rawJson,
        syncedAt: row.syncedAt,
      },
    });
}

/**
 * Boot back-fill: every balance transaction Stripe still lists (no time bound,
 * unlike events.list), keeping the fee-bearing ones. Returns how many it kept.
 */
export async function backfillStripeFeeTransactions(stripe: Stripe): Promise<number> {
  let kept = 0;
  for await (const bt of stripe.balanceTransactions.list({ limit: 100 })) {
    if (!bt.fee) continue;
    await recordStripeFeeTransaction(bt);
    kept += 1;
  }
  return kept;
}

/** USD figures of a fee bucket, converted fee by fee (see `fee-usd.ts`). */
export interface FeeUsdFigures {
  stripe_fee_usd_cents: number;
  revolut_fee_usd_cents: number;
  /** stripe + revolut, USD cents, over every CONVERTIBLE fee of the bucket. */
  fee_usd_cents: number;
  /** Fees with no rate of their own, left OUT of the USD figures, never guessed. */
  unconverted_fee_count: number;
}

export interface FeeMonth extends FeeUsdFigures {
  /** UTC calendar month, `YYYY-MM`. */
  month: string;
  /** Lowercase ISO 4217. Currencies are never merged. */
  currency: string;
  stripe_fee_cents: number;
  revolut_fee_cents: number;
  fee_cents: number;
  /** The part of `fee_cents` (in `currency`) that could not be converted to USD. */
  unconverted_fee_cents: number;
}

export interface FeeTotal extends FeeUsdFigures {
  currency: string;
  stripe_fee_cents: number;
  revolut_fee_cents: number;
  fee_cents: number;
  unconverted_fee_cents: number;
}

export interface FeeUsdMonth extends FeeUsdFigures {
  /** UTC calendar month, `YYYY-MM`. Every currency of the month, in USD. */
  month: string;
}

export interface FeeSeries {
  months: FeeMonth[];
  total: FeeTotal[];
  /** One basis: every currency of a month merged in USD cents. */
  usd_months: FeeUsdMonth[];
  usd_total: FeeUsdFigures;
}

export interface AcquiringFeesByMonth {
  object: "acquiring_fees_by_month";
  /** One entry per org with at least one fee, sorted by org id. */
  orgs: Array<{ org_id: string } & FeeSeries>;
  /** Fees whose payment maps to no org of ours (a failed payout, an org-less order). Never dropped. */
  unattributed: FeeSeries;
  /** Every fee, attributed or not: orgs + unattributed. */
  fleet: FeeSeries;
}

interface FeeRow {
  org_id: string | null;
  acquirer: "stripe" | "revolut";
  month: string;
  currency: string;
  fee: string | number;
  /** Stripe balance transaction's own `exchange_rate` (USD → settlement). */
  exchange_rate?: string | number | null;
}

export async function acquiringFeesByMonth(): Promise<AcquiringFeesByMonth> {
  // Stripe: a charge's fee attributes through the PaymentIntent whose latest
  // charge it is; a refund's through its refund's PaymentIntent. The same joins
  // the refund mirror attributes through, one home for the mapping.
  // One row PER FEE (not grouped): each fee converts to USD with its own rate.
  const result = await db.execute(sql`
    SELECT COALESCE(
             (SELECT pi.org_id FROM payment_intents pi
               WHERE pi.latest_charge = f.source LIMIT 1),
             (SELECT pi.org_id FROM refunds r
                JOIN payment_intents pi ON pi.id = r.payment_intent
               WHERE r.id = f.source LIMIT 1),
             (SELECT pi.org_id FROM refunds r
                JOIN payment_intents pi ON pi.latest_charge = r.charge
               WHERE r.id = f.source LIMIT 1)
           ) AS org_id,
           'stripe' AS acquirer,
           to_char(to_timestamp(f.created_stripe) AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
           f.currency,
           f.fee,
           f.raw_json->>'exchange_rate' AS exchange_rate
      FROM stripe_fee_transactions f
    UNION ALL
    SELECT o.org_id,
           'revolut',
           to_char(o.created_at_revolut AT TIME ZONE 'UTC', 'YYYY-MM'),
           lower(COALESCE(o.raw_json->'payments'->0->'fees'->0->>'currency', o.currency)),
           o.fee_amount,
           NULL
      FROM revolut_orders o
     WHERE o.type = 'payment'
       AND o.state = 'completed'
       AND o.fee_amount > 0
  `);
  return foldFeeRows(result.rows as unknown as FeeRow[]);
}

/** Pure fold, exported for tests. */
export function foldFeeRows(rows: FeeRow[]): AcquiringFeesByMonth {
  const byOrg = new Map<string, FeeRow[]>();
  const unattributed: FeeRow[] = [];
  for (const row of rows) {
    const org = row.org_id && row.org_id !== UNATTRIBUTED_ORG ? row.org_id : null;
    if (org === null) unattributed.push(row);
    else byOrg.set(org, [...(byOrg.get(org) ?? []), row]);
  }
  return {
    object: "acquiring_fees_by_month",
    orgs: [...byOrg.keys()]
      .sort()
      .map((org_id) => ({ org_id, ...series(byOrg.get(org_id) ?? []) })),
    unattributed: series(unattributed),
    fleet: series(rows),
  };
}

function rowUsdCents(row: FeeRow, fee: number): number | null {
  if (row.acquirer === "revolut") return revolutFeeUsdCents(fee, row.currency);
  const rate = row.exchange_rate == null ? null : Number(row.exchange_rate);
  return stripeFeeUsdCents(fee, row.currency, rate);
}

const zeroUsd = (): FeeUsdFigures => ({
  stripe_fee_usd_cents: 0,
  revolut_fee_usd_cents: 0,
  fee_usd_cents: 0,
  unconverted_fee_count: 0,
});

function series(rows: FeeRow[]): FeeSeries {
  const months = new Map<string, FeeMonth>();
  const totals = new Map<string, FeeTotal>();
  const usdMonths = new Map<string, FeeUsdMonth>();
  const usdTotal = zeroUsd();
  for (const row of rows) {
    const fee = Number(row.fee);
    const usd = rowUsdCents(row, fee);
    const m =
      months.get(`${row.month}|${row.currency}`) ??
      {
        month: row.month, currency: row.currency,
        stripe_fee_cents: 0, revolut_fee_cents: 0, fee_cents: 0,
        ...zeroUsd(), unconverted_fee_cents: 0,
      };
    const t =
      totals.get(row.currency) ??
      {
        currency: row.currency,
        stripe_fee_cents: 0, revolut_fee_cents: 0, fee_cents: 0,
        ...zeroUsd(), unconverted_fee_cents: 0,
      };
    const um = usdMonths.get(row.month) ?? { month: row.month, ...zeroUsd() };
    for (const acc of [m, t]) {
      if (row.acquirer === "stripe") acc.stripe_fee_cents += fee;
      else acc.revolut_fee_cents += fee;
      acc.fee_cents += fee;
      if (usd === null) acc.unconverted_fee_cents += fee;
    }
    for (const acc of [m, t, um, usdTotal] as FeeUsdFigures[]) {
      if (usd === null) {
        acc.unconverted_fee_count += 1;
        continue;
      }
      if (row.acquirer === "stripe") acc.stripe_fee_usd_cents += usd;
      else acc.revolut_fee_usd_cents += usd;
      acc.fee_usd_cents += usd;
    }
    months.set(`${row.month}|${row.currency}`, m);
    totals.set(row.currency, t);
    usdMonths.set(row.month, um);
  }
  return {
    months: [...months.values()].sort(
      (a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency)
    ),
    total: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    usd_months: [...usdMonths.values()].sort((a, b) => a.month.localeCompare(b.month)),
    usd_total: usdTotal,
  };
}
