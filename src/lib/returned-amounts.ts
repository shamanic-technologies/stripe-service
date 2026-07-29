import { inArray, or } from "drizzle-orm";
import { db } from "../db";
import { refunds, disputes } from "../db/schema";

/**
 * How much of a payment came back out, split by the two ways Stripe returns
 * money. All amounts are in the payment's own currency's minor unit (cents).
 */
export type ReturnedAmounts = {
  /** Sum of `succeeded` Refunds against the payment. */
  amount_refunded: number;
  /** Sum of Disputes against the payment we ultimately LOST. */
  amount_disputed_lost: number;
  /** `amount_refunded + amount_disputed_lost` — total money given back. */
  amount_returned: number;
};

export const ZERO_RETURNED: ReturnedAmounts = {
  amount_refunded: 0,
  amount_disputed_lost: 0,
  amount_returned: 0,
};

/**
 * The ONLY Refund status under which money has actually left our balance.
 * `pending` / `requires_action` have not moved yet; `failed` / `canceled` mean
 * the money came back to us, so they must stop counting as returned.
 */
const REFUND_RETURNED_STATUS = "succeeded";

/**
 * The ONLY Dispute status under which the funds are gone for good. A dispute is
 * provisionally withdrawn while it is open, but `won` (and the `*_closed`
 * outcomes) leave the money with us — counting those would over-report.
 */
const DISPUTE_RETURNED_STATUS = "lost";

/** A payment we can attribute returns to. */
export type PaymentRef = {
  id: string;
  /** PaymentIntent.latest_charge — the fallback join key (see below). */
  latestCharge: string | null;
};

function bump(
  into: Map<string, ReturnedAmounts>,
  paymentIntentId: string,
  field: "amount_refunded" | "amount_disputed_lost",
  amount: number
): void {
  const current = into.get(paymentIntentId) ?? { ...ZERO_RETURNED };
  current[field] += amount;
  current.amount_returned =
    current.amount_refunded + current.amount_disputed_lost;
  into.set(paymentIntentId, current);
}

/**
 * Money returned, per PaymentIntent id, computed live from the refunds +
 * disputes silver mirrors.
 *
 * This is a QUERY over current object state, never a stored accumulator — which
 * is what makes the awkward cases correct by construction:
 *  - a PARTIAL refund contributes only its own `amount`;
 *  - a refund that later FAILS or is CANCELED flips its own `status` and drops
 *    out of the sum on the next read, with nothing to unwind;
 *  - a LOST dispute is counted the same as a refund (the money is equally
 *    gone), while an open or won dispute is not counted at all.
 *
 * Attribution: refunds/disputes normally carry `payment_intent`. Stripe leaves
 * it null for charges that were not created through a PaymentIntent, so we also
 * match on `charge` against the PaymentIntent's `latest_charge`. Results are
 * keyed by refund/dispute id first, so an object matching on BOTH keys is
 * counted once.
 */
export async function returnedByPaymentIntent(
  payments: PaymentRef[]
): Promise<Map<string, ReturnedAmounts>> {
  const result = new Map<string, ReturnedAmounts>();
  if (payments.length === 0) return result;

  const piIds = payments.map((p) => p.id);
  const chargeIds = payments
    .map((p) => p.latestCharge)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
  const piIdByCharge = new Map<string, string>();
  for (const p of payments) {
    if (p.latestCharge) piIdByCharge.set(p.latestCharge, p.id);
  }

  const match = (
    piColumn: typeof refunds.paymentIntent | typeof disputes.paymentIntent,
    chargeColumn: typeof refunds.charge | typeof disputes.charge
  ) =>
    chargeIds.length > 0
      ? or(inArray(piColumn, piIds), inArray(chargeColumn, chargeIds))
      : inArray(piColumn, piIds);

  const [refundRows, disputeRows] = await Promise.all([
    db
      .select({
        id: refunds.id,
        paymentIntent: refunds.paymentIntent,
        charge: refunds.charge,
        amount: refunds.amount,
        status: refunds.status,
      })
      .from(refunds)
      .where(match(refunds.paymentIntent, refunds.charge)),
    db
      .select({
        id: disputes.id,
        paymentIntent: disputes.paymentIntent,
        charge: disputes.charge,
        amount: disputes.amount,
        status: disputes.status,
      })
      .from(disputes)
      .where(match(disputes.paymentIntent, disputes.charge)),
  ]);

  const knownPi = new Set(piIds);
  const resolvePi = (row: {
    paymentIntent: string | null;
    charge: string | null;
  }): string | null => {
    if (row.paymentIntent && knownPi.has(row.paymentIntent)) {
      return row.paymentIntent;
    }
    if (row.charge) return piIdByCharge.get(row.charge) ?? null;
    return null;
  };

  const seen = new Set<string>();
  for (const row of refundRows) {
    if (row.status !== REFUND_RETURNED_STATUS) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const piId = resolvePi(row);
    if (!piId) continue;
    bump(result, piId, "amount_refunded", row.amount);
  }
  for (const row of disputeRows) {
    if (row.status !== DISPUTE_RETURNED_STATUS) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const piId = resolvePi(row);
    if (!piId) continue;
    bump(result, piId, "amount_disputed_lost", row.amount);
  }

  return result;
}

/** Per-currency money movement for one org. All amounts in minor units. */
export type CurrencyTotals = {
  currency: string;
  /** Gross paid in: `SUM(amount_received)` over `succeeded` PaymentIntents. */
  amount_received: number;
  amount_refunded: number;
  amount_disputed_lost: number;
  amount_returned: number;
  /** `amount_received - amount_returned` — money we actually still hold. */
  amount_net: number;
};

/** A mirrored PaymentIntent, reduced to the fields the summary needs. */
export type SummaryPayment = PaymentRef & {
  currency: string;
  status: string;
  amountReceived: number | null;
};

/**
 * Roll an org's payments up per currency: gross in, returned out, net.
 *
 * Gross uses exactly the predicate billing-service already applies when it sums
 * top-ups (`status === "succeeded"` AND numeric `amount_received`), so an org
 * with no refunds reports `amount_net === amount_received` and nothing changes
 * for it.
 *
 * Returns are counted over ALL of the org's payments regardless of the payment's
 * own status: money that left is money that left, and hiding it behind a status
 * filter is exactly the under-reporting this endpoint exists to fix. In practice
 * only a captured (`succeeded`) payment can be refunded or disputed.
 *
 * Currencies are never merged — a currency with any activity on either side
 * gets its own entry, so a multi-currency org is reported truthfully rather
 * than summed into a meaningless scalar.
 */
export function summarizeByCurrency(
  payments: SummaryPayment[],
  returned: Map<string, ReturnedAmounts>
): CurrencyTotals[] {
  const byCurrency = new Map<string, CurrencyTotals>();
  const entry = (currency: string): CurrencyTotals => {
    const existing = byCurrency.get(currency);
    if (existing) return existing;
    const fresh: CurrencyTotals = {
      currency,
      amount_received: 0,
      amount_refunded: 0,
      amount_disputed_lost: 0,
      amount_returned: 0,
      amount_net: 0,
    };
    byCurrency.set(currency, fresh);
    return fresh;
  };

  for (const payment of payments) {
    const ret = returned.get(payment.id);
    const isGross =
      payment.status === "succeeded" && typeof payment.amountReceived === "number";
    if (!isGross && !ret) continue;

    const row = entry(payment.currency);
    if (isGross) row.amount_received += payment.amountReceived as number;
    if (ret) {
      row.amount_refunded += ret.amount_refunded;
      row.amount_disputed_lost += ret.amount_disputed_lost;
      row.amount_returned += ret.amount_returned;
    }
  }

  for (const row of byCurrency.values()) {
    row.amount_net = row.amount_received - row.amount_returned;
  }

  return [...byCurrency.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency)
  );
}

/**
 * Merge the derived returned-money fields onto a mirrored Stripe PaymentIntent
 * so a single per-payment read conveys both what was charged and what came
 * back. The Stripe object itself is untouched in `raw_json`; these three fields
 * are stripe-service-derived siblings (Stripe's PaymentIntent has no notion of
 * refunds — that lives on the Charge, and even there a lost dispute is absent).
 */
export function withReturnedAmounts(
  rawJson: unknown,
  returned: ReturnedAmounts | undefined
): unknown {
  if (!rawJson || typeof rawJson !== "object") return rawJson;
  return {
    ...(rawJson as Record<string, unknown>),
    ...(returned ?? ZERO_RETURNED),
  };
}
