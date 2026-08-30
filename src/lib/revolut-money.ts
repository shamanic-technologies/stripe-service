import { and, eq, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db";
import { revolutOrders } from "../db/schema";
import type { CurrencyTotals } from "./returned-amounts";

/**
 * What an org paid us through Revolut, and what came back — per currency.
 *
 * Same contract as the Stripe side, computed the same way: a QUERY over current
 * object state, never a stored accumulator. Money in is a `payment` order that
 * reached `completed`; money out is a `refund` order that reached `completed`.
 * A refund that failed — and eleven of them have, on the test payment — is
 * simply not `completed`, so it drops out of the sum with nothing to unwind.
 *
 * A refund carries no org of its own (Revolut mints it with no metadata), so it
 * is attributed by joining to the payment it reverses through
 * `related_order_id`. That join is the whole reason the tenant is not copied
 * onto the refund row.
 *
 * `asOf` bounds both sides to what had happened at that instant, exactly as the
 * Stripe half does — a return belongs to the moment it happened.
 */
export async function revolutTotalsByCurrency(
  orgId: string,
  asOf?: Date
): Promise<CurrencyTotals[]> {
  const paidBound = asOf ? lt(revolutOrders.createdAtRevolut, asOf) : undefined;

  const paid = await db
    .select({
      currency: revolutOrders.currency,
      total: sql<string>`COALESCE(SUM(${revolutOrders.amount}), 0)`,
    })
    .from(revolutOrders)
    .where(
      and(
        eq(revolutOrders.orgId, orgId),
        eq(revolutOrders.type, "payment"),
        eq(revolutOrders.state, "completed"),
        ...(paidBound ? [paidBound] : [])
      )
    )
    .groupBy(revolutOrders.currency);

  // Refunds join to their parent for the tenant. `refund.currency` is the
  // refund's own, which is what a return is denominated in. Expressed with the
  // query builder rather than raw SQL so it goes through the same path — and
  // the same tests — as every other read here.
  const parent = alias(revolutOrders, "parent_order");
  const refundBound = asOf ? lt(revolutOrders.createdAtRevolut, asOf) : undefined;
  const refunded = await db
    .select({
      currency: revolutOrders.currency,
      total: sql<string>`COALESCE(SUM(${revolutOrders.amount}), 0)`,
    })
    .from(revolutOrders)
    .innerJoin(parent, eq(parent.id, revolutOrders.relatedOrderId))
    .where(
      and(
        eq(revolutOrders.type, "refund"),
        eq(revolutOrders.state, "completed"),
        eq(parent.orgId, orgId),
        ...(refundBound ? [refundBound] : [])
      )
    )
    .groupBy(revolutOrders.currency);

  const byCurrency = new Map<string, CurrencyTotals>();
  const entry = (rawCurrency: string): CurrencyTotals => {
    // Stripe reports `usd`, Revolut reports `USD`. Same currency. Left
    // unnormalised they become two entries in the merged summary and a caller
    // summing per currency silently under-counts each of them.
    const currency = rawCurrency.toLowerCase();
    const existing = byCurrency.get(currency);
    if (existing) return existing;
    const fresh: CurrencyTotals = {
      currency,
      amount_received: 0,
      amount_refunded: 0,
      // Revolut disputes are not projected yet — no dispute payload has ever
      // been observed on this account, so there is nothing to sum. Zero here is
      // "none exist", and it becomes real the moment one does.
      amount_disputed_lost: 0,
      amount_returned: 0,
      amount_net: 0,
    };
    byCurrency.set(currency, fresh);
    return fresh;
  };

  for (const row of paid) {
    if (!row.currency) continue;
    entry(row.currency).amount_received += Number(row.total);
  }
  for (const row of refunded) {
    if (!row.currency) continue;
    entry(row.currency).amount_refunded += Number(row.total);
  }
  for (const row of byCurrency.values()) {
    row.amount_returned = row.amount_refunded + row.amount_disputed_lost;
    row.amount_net = row.amount_received - row.amount_returned;
  }
  return [...byCurrency.values()];
}

/**
 * Merge two per-currency breakdowns into one.
 *
 * The org's money is the org's money whichever acquirer took it, so the summary
 * a consumer reads is the SUM across acquirers — that is the whole point of the
 * neutral surface. Currencies are still never merged with each other.
 */
export function mergeCurrencyTotals(
  ...sets: CurrencyTotals[][]
): CurrencyTotals[] {
  const byCurrency = new Map<string, CurrencyTotals>();
  for (const set of sets) {
    for (const row of set) {
      // Case-fold before merging: the acquirers disagree on it (Stripe `usd`,
      // Revolut `USD`) and two spellings of one currency is the quiet way to
      // halve a balance.
      const key = row.currency.toLowerCase();
      const existing = byCurrency.get(key);
      if (!existing) {
        byCurrency.set(key, { ...row, currency: key });
        continue;
      }
      existing.amount_received += row.amount_received;
      existing.amount_refunded += row.amount_refunded;
      existing.amount_disputed_lost += row.amount_disputed_lost;
      existing.amount_returned += row.amount_returned;
      existing.amount_net += row.amount_net;
    }
  }
  return [...byCurrency.values()].sort((a, b) =>
    a.currency.localeCompare(b.currency)
  );
}
