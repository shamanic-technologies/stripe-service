import type Stripe from "stripe";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { stripeFeeTransactions } from "../db/schema";
import { extractString } from "./event-processor";

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

export interface FeeMonth {
  /** UTC calendar month, `YYYY-MM`. */
  month: string;
  /** Lowercase ISO 4217. Currencies are never merged. */
  currency: string;
  stripe_fee_cents: number;
  revolut_fee_cents: number;
  fee_cents: number;
}

export interface FeeTotal {
  currency: string;
  stripe_fee_cents: number;
  revolut_fee_cents: number;
  fee_cents: number;
}

export interface FeeSeries {
  months: FeeMonth[];
  total: FeeTotal[];
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
}

export async function acquiringFeesByMonth(): Promise<AcquiringFeesByMonth> {
  // Stripe: a charge's fee attributes through the PaymentIntent whose latest
  // charge it is; a refund's through its refund's PaymentIntent. The same joins
  // the refund mirror attributes through, one home for the mapping.
  const result = await db.execute(sql`
    SELECT org_id, acquirer, month, currency, SUM(fee)::bigint AS fee
      FROM (
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
               f.fee
          FROM stripe_fee_transactions f
        UNION ALL
        SELECT o.org_id,
               'revolut',
               to_char(o.created_at_revolut AT TIME ZONE 'UTC', 'YYYY-MM'),
               lower(COALESCE(o.raw_json->'payments'->0->'fees'->0->>'currency', o.currency)),
               o.fee_amount
          FROM revolut_orders o
         WHERE o.type = 'payment'
           AND o.state = 'completed'
           AND o.fee_amount > 0
      ) fees
     GROUP BY 1, 2, 3, 4
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

function series(rows: FeeRow[]): FeeSeries {
  const months = new Map<string, FeeMonth>();
  const totals = new Map<string, FeeTotal>();
  for (const row of rows) {
    const fee = Number(row.fee);
    const m =
      months.get(`${row.month}|${row.currency}`) ??
      { month: row.month, currency: row.currency, stripe_fee_cents: 0, revolut_fee_cents: 0, fee_cents: 0 };
    const t =
      totals.get(row.currency) ??
      { currency: row.currency, stripe_fee_cents: 0, revolut_fee_cents: 0, fee_cents: 0 };
    for (const acc of [m, t]) {
      if (row.acquirer === "stripe") acc.stripe_fee_cents += fee;
      else acc.revolut_fee_cents += fee;
      acc.fee_cents += fee;
    }
    months.set(`${row.month}|${row.currency}`, m);
    totals.set(row.currency, t);
  }
  return {
    months: [...months.values()].sort(
      (a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency)
    ),
    total: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}
