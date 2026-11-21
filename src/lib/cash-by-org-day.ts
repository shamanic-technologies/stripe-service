import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  directPayments,
  disputes,
  paymentIntents,
  refunds,
  revolutOrders,
} from "../db/schema";
import {
  DISPUTE_SETTLED_STATUS,
  REFUND_SETTLED_STATUS,
  REVOLUT_SETTLED_STATE,
  UNATTRIBUTED_ORG,
} from "./platform-billing-stats";

/**
 * Every org's money per UTC day since inception (SAAS-CASH-1121).
 *
 * The SAME money `GET /public/stats/billing` totals, cut by (org, UTC day):
 *  - GROSS = payments received that day, every acquirer, BEFORE any return:
 *    a `succeeded` Stripe PaymentIntent (`amount_received`, dated `created`),
 *    a `completed` Revolut `payment` order (dated `created_at`), a STANDING
 *    direct payment (dated `recorded_at`; a voided one never counts).
 *  - RETURNED = a `succeeded` Stripe Refund, a `lost` Stripe Dispute, a
 *    `completed` Revolut `refund` order, each dated on ITS OWN day (never
 *    back-dated to the payment) and attributed to the org of the payment it
 *    reverses (Stripe: PaymentIntent by id, else by `latest_charge`; Revolut:
 *    the parent order). A return with no mirrored payment is not counted,
 *    exactly as on the platform figure.
 *  - NET = gross − returned for that (org, day). A day with only a return is
 *    served with gross 0 and a negative net.
 *
 * The predicates are the platform figure's, imported, not restated: summing
 * every row gives `total_paid_cents` (gross) and `total_net_cents` (net) by
 * construction. Money with no resolvable org (the `unknown` sentinel, an
 * org-less Revolut order) is ONE org-less row per day (`org_id: null`), never
 * dropped. Currencies are summed into one scalar, like the platform figure.
 *
 * ONE statement, so every row and both totals come from one snapshot.
 */

export type CashByOrgDayRow = {
  org_id: string | null;
  /** UTC day `YYYY-MM-DD`; null only for a mirrored payment carrying no date. */
  day: string | null;
  gross_cents: string;
  returned_cents: string;
  net_cents: string;
};

export type CashByOrgDay = {
  object: "cash_by_org_day";
  as_of: string;
  totals: { gross_cents: string; returned_cents: string; net_cents: string };
  rows: CashByOrgDayRow[];
};

type RawRow = {
  org_id: string | null;
  day: string | null;
  gross: string | null;
  returned: string | null;
};

/** Fold the grouped rows into the served shape. Pure, so the sums are pinned. */
export function foldCashRows(raw: RawRow[], asOf: Date): CashByOrgDay {
  let gross = 0n;
  let returned = 0n;
  const rows: CashByOrgDayRow[] = raw.map((r) => {
    const g = BigInt(r.gross ?? "0");
    const ret = BigInt(r.returned ?? "0");
    gross += g;
    returned += ret;
    return {
      org_id: r.org_id,
      day: r.day,
      gross_cents: g.toString(),
      returned_cents: ret.toString(),
      net_cents: (g - ret).toString(),
    };
  });
  return {
    object: "cash_by_org_day",
    as_of: asOf.toISOString(),
    totals: {
      gross_cents: gross.toString(),
      returned_cents: returned.toString(),
      net_cents: (gross - returned).toString(),
    },
    rows,
  };
}

const utcDay = (ts: ReturnType<typeof sql>) =>
  sql`to_char((${ts} AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')`;

export async function cashByOrgDay(): Promise<CashByOrgDay> {
  const asOf = new Date();
  const result = await db.execute(sql`
    WITH movements AS (
      SELECT NULLIF(pi.org_id, ${UNATTRIBUTED_ORG}) AS org_id,
             ${utcDay(sql`to_timestamp(pi.created_stripe)`)} AS day,
             COALESCE(pi.amount_received, 0)::bigint AS gross,
             0::bigint AS returned
        FROM ${paymentIntents} pi
       WHERE pi.status = 'succeeded'
      UNION ALL
      SELECT ro.org_id,
             ${utcDay(sql`ro.created_at_revolut`)},
             COALESCE(ro.amount, 0)::bigint,
             0::bigint
        FROM ${revolutOrders} ro
       WHERE ro.type = 'payment' AND ro.state = ${REVOLUT_SETTLED_STATE}
      UNION ALL
      SELECT dp.org_id,
             ${utcDay(sql`dp.recorded_at`)},
             dp.amount::bigint,
             0::bigint
        FROM ${directPayments} dp
       WHERE dp.voided_at IS NULL
      UNION ALL
      SELECT NULLIF(COALESCE(pi_by_id.org_id, pi_by_charge.org_id), ${UNATTRIBUTED_ORG}),
             ${utcDay(sql`to_timestamp(r.created_stripe)`)},
             0::bigint,
             r.amount::bigint
        FROM ${refunds} r
        LEFT JOIN ${paymentIntents} pi_by_id ON pi_by_id.id = r.payment_intent
        LEFT JOIN ${paymentIntents} pi_by_charge ON pi_by_charge.latest_charge = r.charge
       WHERE r.status = ${REFUND_SETTLED_STATUS}
         AND (pi_by_id.id IS NOT NULL OR pi_by_charge.id IS NOT NULL)
      UNION ALL
      SELECT NULLIF(COALESCE(pi_by_id.org_id, pi_by_charge.org_id), ${UNATTRIBUTED_ORG}),
             ${utcDay(sql`to_timestamp(d.created_stripe)`)},
             0::bigint,
             d.amount::bigint
        FROM ${disputes} d
        LEFT JOIN ${paymentIntents} pi_by_id ON pi_by_id.id = d.payment_intent
        LEFT JOIN ${paymentIntents} pi_by_charge ON pi_by_charge.latest_charge = d.charge
       WHERE d.status = ${DISPUTE_SETTLED_STATUS}
         AND (pi_by_id.id IS NOT NULL OR pi_by_charge.id IS NOT NULL)
      UNION ALL
      SELECT parent.org_id,
             ${utcDay(sql`rf.created_at_revolut`)},
             0::bigint,
             COALESCE(rf.amount, 0)::bigint
        FROM ${revolutOrders} rf
        JOIN ${revolutOrders} parent ON parent.id = rf.related_order_id
       WHERE rf.type = 'refund' AND rf.state = ${REVOLUT_SETTLED_STATE}
    )
    SELECT org_id, day,
           SUM(gross)::text AS gross,
           SUM(returned)::text AS returned
      FROM movements
     GROUP BY org_id, day
    HAVING SUM(gross) <> 0 OR SUM(returned) <> 0
     ORDER BY day NULLS FIRST, org_id NULLS FIRST
  `);
  return foldCashRows(result.rows as unknown as RawRow[], asOf);
}
