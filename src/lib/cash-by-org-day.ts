import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  directPayments,
  disputes,
  paymentIntents,
  paymentOrgAttributions,
  refunds,
  revolutOrders,
} from "../db/schema";
import {
  DISPUTE_SETTLED_STATUS,
  REFUND_SETTLED_STATUS,
  REVOLUT_AGENCY_TYPE,
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
 * AGENCY money (SAAS-CASH-1121-AGENCY) is counted ONCE, in its own fields,
 * never in the SaaS ones: a `completed` Revolut `payment_request` order (a
 * payment link staff created and sent by hand = an agency fee, not a top-up)
 * is `agency_gross_cents` on its created day; a `completed` Revolut refund
 * whose parent is a `payment_request` is `agency_returned_cents` on the
 * refund's day. A row may carry agency money only (SaaS gross 0). Agency
 * money never reaches payment_summary, credited or public stats.
 *
 * A STAFF ATTRIBUTION (`payment_org_attributions`, see
 * `payment-attributions.ts`) moves an org-less payment (and its returns) to
 * the stated org's row. A payment's OWN org always wins over an attribution.
 * Totals are unchanged by an attribution (it moves money between rows). This
 * read is the ONLY reader of that table.
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
  agency_gross_cents: string;
  agency_returned_cents: string;
  agency_net_cents: string;
};

export type CashTotals = {
  gross_cents: string;
  returned_cents: string;
  net_cents: string;
  agency_gross_cents: string;
  agency_returned_cents: string;
  agency_net_cents: string;
};

export type CashByOrgDay = {
  object: "cash_by_org_day";
  as_of: string;
  totals: CashTotals;
  rows: CashByOrgDayRow[];
};

type RawRow = {
  org_id: string | null;
  day: string | null;
  gross: string | null;
  returned: string | null;
  agency_gross?: string | null;
  agency_returned?: string | null;
};

/** Fold the grouped rows into the served shape. Pure, so the sums are pinned. */
export function foldCashRows(raw: RawRow[], asOf: Date): CashByOrgDay {
  let gross = 0n;
  let returned = 0n;
  let agencyGross = 0n;
  let agencyReturned = 0n;
  const rows: CashByOrgDayRow[] = raw.map((r) => {
    const g = BigInt(r.gross ?? "0");
    const ret = BigInt(r.returned ?? "0");
    const ag = BigInt(r.agency_gross ?? "0");
    const ar = BigInt(r.agency_returned ?? "0");
    gross += g;
    returned += ret;
    agencyGross += ag;
    agencyReturned += ar;
    return {
      org_id: r.org_id,
      day: r.day,
      gross_cents: g.toString(),
      returned_cents: ret.toString(),
      net_cents: (g - ret).toString(),
      agency_gross_cents: ag.toString(),
      agency_returned_cents: ar.toString(),
      agency_net_cents: (ag - ar).toString(),
    };
  });
  return {
    object: "cash_by_org_day",
    as_of: asOf.toISOString(),
    totals: {
      gross_cents: gross.toString(),
      returned_cents: returned.toString(),
      net_cents: (gross - returned).toString(),
      agency_gross_cents: agencyGross.toString(),
      agency_returned_cents: agencyReturned.toString(),
      agency_net_cents: (agencyGross - agencyReturned).toString(),
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
      SELECT COALESCE(NULLIF(pi.org_id, ${UNATTRIBUTED_ORG}), att.org_id) AS org_id,
             ${utcDay(sql`to_timestamp(pi.created_stripe)`)} AS day,
             COALESCE(pi.amount_received, 0)::bigint AS gross,
             0::bigint AS returned,
             0::bigint AS agency_gross,
             0::bigint AS agency_returned
        FROM ${paymentIntents} pi
        LEFT JOIN ${paymentOrgAttributions} att
          ON att.acquirer = 'stripe' AND att.payment_id = pi.id
       WHERE pi.status = 'succeeded'
      UNION ALL
      SELECT COALESCE(ro.org_id, att.org_id),
             ${utcDay(sql`ro.created_at_revolut`)},
             CASE WHEN ro.type = 'payment' THEN COALESCE(ro.amount, 0) ELSE 0 END::bigint,
             0::bigint,
             CASE WHEN ro.type = ${REVOLUT_AGENCY_TYPE} THEN COALESCE(ro.amount, 0) ELSE 0 END::bigint,
             0::bigint
        FROM ${revolutOrders} ro
        LEFT JOIN ${paymentOrgAttributions} att
          ON att.acquirer = 'revolut' AND att.payment_id = ro.id
       WHERE ro.type IN ('payment', ${REVOLUT_AGENCY_TYPE}) AND ro.state = ${REVOLUT_SETTLED_STATE}
      UNION ALL
      SELECT dp.org_id,
             ${utcDay(sql`dp.recorded_at`)},
             dp.amount::bigint,
             0::bigint, 0::bigint, 0::bigint
        FROM ${directPayments} dp
       WHERE dp.voided_at IS NULL
      UNION ALL
      SELECT COALESCE(NULLIF(COALESCE(pi_by_id.org_id, pi_by_charge.org_id), ${UNATTRIBUTED_ORG}), att.org_id),
             ${utcDay(sql`to_timestamp(r.created_stripe)`)},
             0::bigint,
             r.amount::bigint,
             0::bigint, 0::bigint
        FROM ${refunds} r
        LEFT JOIN ${paymentIntents} pi_by_id ON pi_by_id.id = r.payment_intent
        LEFT JOIN ${paymentIntents} pi_by_charge ON pi_by_charge.latest_charge = r.charge
        LEFT JOIN ${paymentOrgAttributions} att
          ON att.acquirer = 'stripe' AND att.payment_id = COALESCE(pi_by_id.id, pi_by_charge.id)
       WHERE r.status = ${REFUND_SETTLED_STATUS}
         AND (pi_by_id.id IS NOT NULL OR pi_by_charge.id IS NOT NULL)
      UNION ALL
      SELECT COALESCE(NULLIF(COALESCE(pi_by_id.org_id, pi_by_charge.org_id), ${UNATTRIBUTED_ORG}), att.org_id),
             ${utcDay(sql`to_timestamp(d.created_stripe)`)},
             0::bigint,
             d.amount::bigint,
             0::bigint, 0::bigint
        FROM ${disputes} d
        LEFT JOIN ${paymentIntents} pi_by_id ON pi_by_id.id = d.payment_intent
        LEFT JOIN ${paymentIntents} pi_by_charge ON pi_by_charge.latest_charge = d.charge
        LEFT JOIN ${paymentOrgAttributions} att
          ON att.acquirer = 'stripe' AND att.payment_id = COALESCE(pi_by_id.id, pi_by_charge.id)
       WHERE d.status = ${DISPUTE_SETTLED_STATUS}
         AND (pi_by_id.id IS NOT NULL OR pi_by_charge.id IS NOT NULL)
      UNION ALL
      SELECT COALESCE(parent.org_id, att.org_id),
             ${utcDay(sql`rf.created_at_revolut`)},
             0::bigint,
             CASE WHEN parent.type = 'payment' THEN COALESCE(rf.amount, 0) ELSE 0 END::bigint,
             0::bigint,
             CASE WHEN parent.type = ${REVOLUT_AGENCY_TYPE} THEN COALESCE(rf.amount, 0) ELSE 0 END::bigint
        FROM ${revolutOrders} rf
        JOIN ${revolutOrders} parent ON parent.id = rf.related_order_id
        LEFT JOIN ${paymentOrgAttributions} att
          ON att.acquirer = 'revolut' AND att.payment_id = parent.id
       WHERE rf.type = 'refund' AND rf.state = ${REVOLUT_SETTLED_STATE}
         AND parent.type IN ('payment', ${REVOLUT_AGENCY_TYPE})
    )
    SELECT org_id, day,
           SUM(gross)::text AS gross,
           SUM(returned)::text AS returned,
           SUM(agency_gross)::text AS agency_gross,
           SUM(agency_returned)::text AS agency_returned
      FROM movements
     GROUP BY org_id, day
    HAVING SUM(gross) <> 0 OR SUM(returned) <> 0
        OR SUM(agency_gross) <> 0 OR SUM(agency_returned) <> 0
     ORDER BY day NULLS FIRST, org_id NULLS FIRST
  `);
  return foldCashRows(result.rows as unknown as RawRow[], asOf);
}
