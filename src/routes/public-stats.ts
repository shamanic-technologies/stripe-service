import { Router, Request, Response, NextFunction } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { paymentIntents, customers } from "../db/schema";
import {
  mergeGrowth,
  payingAccounts,
  platformReturns,
  revolutPlatformPaid,
  sumsToPaidRows,
  type PaidBucketRow,
} from "../lib/platform-billing-stats";

const router = Router();

/**
 * GET /public/stats/billing
 *
 * Cross-org Stripe money movement: what came in (GROSS), what went back out,
 * and what is therefore still real (NET). No auth, no identity headers.
 *
 * Gross and net are BOTH published rather than collapsed, because they answer
 * different questions and a consumer needs both:
 *  - `total_paid_cents` / `paid_cents` — gross charges. Unchanged meaning; this
 *    is the revenue figure, and accounting reports revenue gross.
 *  - `total_net_cents` / `net_cents` — gross minus money returned. This is the
 *    spendable credit customers actually ended up with, i.e. what a consumer
 *    should report as "credited". Summing payments alone counts money we gave
 *    back as money we still hold.
 *
 * EVERY ACQUIRER is counted, on both sides. Stripe and Revolut have each taken
 * real customer money through this service, and the per-org reads already sum
 * across acquirers on the same principle: the money is the money whichever
 * acquirer took it. Returns follow the same "money is really gone" rule as
 * every other read here — a settled (`succeeded`) Stripe Refund, a LOST Stripe
 * Dispute, or a `completed` Revolut refund order, each attributed to a mirrored
 * payment of ours. Nothing is excluded for looking like a test.
 *
 * CURRENCIES ARE SUMMED TOGETHER into one scalar, as the pre-existing gross
 * total already did. That is a deliberate property of this endpoint, which is a
 * single cross-org figure with no currency dimension to widen; per-currency
 * truth lives on `GET /internal/payment_summary/by-org/:orgId`, which never
 * merges currencies and also spans both acquirers.
 *
 * HOW MANY ACCOUNTS PAID is published beside how much they paid, on the same
 * periods and with the SAME acquirer coverage as the money: `paying_accounts`
 * per bucket, `first_time_paying_accounts` for the ones with no earlier
 * payment on any acquirer, and `total_paying_accounts` for the platform. An
 * account is the ORG — the mapping this service owns — so an org that pays on
 * both acquirers is one account, and the counts answer "who PAID", never "who
 * has a card on file". A refund never un-counts a payer, and a payment we
 * cannot attribute to an org is excluded from the counts while its money still
 * counts in every figure here.
 *
 * WHEN each account became a customer is published as `first_payment_times_unix`
 * — every account's first settled payment, unix seconds, ascending. THE UNIT IS
 * IN THE NAME on purpose: `Date.now()` is MILLISECONDS, so a consumer comparing
 * a milliseconds cutoff against a seconds array counts ZERO and renders a dash,
 * which is the exact failure this array exists to kill. Every money field here
 * already says `_cents`; this one said nothing. `first_payment_times` carries
 * the identical array under the original name for one more release and is
 * deprecated. The buckets
 * above are calendar months and weeks, and a consumer asking "how many
 * accounts became customers in the LAST 30 DAYS" is asking about a window
 * anchored on an instant that aligns to neither: summing whole buckets is
 * wrong by however much of the straddling bucket falls outside the window, and
 * wrong by an amount that moves with where the edge happens to land. So the
 * instants themselves are published and the consumer counts the ones inside
 * its own window — exact for ANY window, with this service knowing none of
 * them. Same identity and same acquirer coverage as every count above, so
 * `first_payment_times.length === total_paying_accounts`.
 *
 * ⚠️ `accounts_with_payment_method` does NOT share that coverage — it is
 * STRIPE-ONLY and stays that way. It counts
 * mirrored customers carrying a default Stripe payment method. Revolut exposes
 * no mirror of its saved methods — answering for it means one live API call per
 * org, which does not belong behind an unauthenticated public route. The figure
 * is a Stripe-card count, not a platform-wide "can be charged" count; a
 * consumer needing the latter should ask the per-org surfaces.
 *
 * Buckets attribute a return to the period it HAPPENED in, not to the period of
 * the payment it reverses — see `mergeGrowth`. Every acquirer's payments and
 * returns go through that same merge, so `sum(buckets) === all-time total`
 * still holds on both grains.
 */
router.get("/public/stats/billing", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const totalRows = await db
      .select({
        total: sql<string>`COALESCE(SUM(${paymentIntents.amountReceived}), 0)::text`,
      })
      .from(paymentIntents)
      .where(eq(paymentIntents.status, "succeeded"));

    const totalPaidCents = BigInt(totalRows[0]?.total ?? "0");

    const accountsRows = await db
      .select({
        count: sql<string>`COUNT(*)::text`,
      })
      .from(customers)
      .where(
        sql`${customers.rawJson}->'invoice_settings'->>'default_payment_method' IS NOT NULL`
      );

    const accountsWithPaymentMethod = Number(accountsRows[0]?.count ?? "0");

    const monthlyRows = (await db
      .select({
        period: sql<Date>`date_trunc('month', to_timestamp(${paymentIntents.createdStripe}))`,
        paid_cents: sql<string>`SUM(${paymentIntents.amountReceived})::text`,
      })
      .from(paymentIntents)
      .where(eq(paymentIntents.status, "succeeded"))
      .groupBy(sql`date_trunc('month', to_timestamp(${paymentIntents.createdStripe}))`)
      .orderBy(
        sql`date_trunc('month', to_timestamp(${paymentIntents.createdStripe}))`
      )) as PaidBucketRow[];

    const weeklyRows = (await db
      .select({
        period: sql<Date>`date_trunc('week', to_timestamp(${paymentIntents.createdStripe}))`,
        paid_cents: sql<string>`SUM(${paymentIntents.amountReceived})::text`,
      })
      .from(paymentIntents)
      .where(eq(paymentIntents.status, "succeeded"))
      .groupBy(sql`date_trunc('week', to_timestamp(${paymentIntents.createdStripe}))`)
      .orderBy(
        sql`date_trunc('week', to_timestamp(${paymentIntents.createdStripe}))`
      )) as PaidBucketRow[];

    const [returns, revolutPaid, accounts] = await Promise.all([
      platformReturns(),
      revolutPlatformPaid(),
      payingAccounts(),
    ]);
    const totalRefundedCents = returns.refunded.total;
    const totalDisputedLostCents = returns.disputedLost.total;
    const totalReturnedCents = totalRefundedCents + totalDisputedLostCents;

    return res.json({
      total_paid_cents: (totalPaidCents + revolutPaid.total).toString(),
      total_refunded_cents: totalRefundedCents.toString(),
      total_disputed_lost_cents: totalDisputedLostCents.toString(),
      total_returned_cents: totalReturnedCents.toString(),
      total_net_cents: (
        totalPaidCents +
        revolutPaid.total -
        totalReturnedCents
      ).toString(),
      accounts_with_payment_method: accountsWithPaymentMethod,
      total_paying_accounts: accounts.total,
      first_payment_times_unix: accounts.firstPaymentTimes,
      // DEPRECATED, served one more release so no consumer breaks on the rename.
      // Identical array, same order. Read `first_payment_times_unix`.
      first_payment_times: accounts.firstPaymentTimes,
      monthly_growth: mergeGrowth(
        [...monthlyRows, ...sumsToPaidRows(revolutPaid.byMonth)],
        returns.refunded.byMonth,
        returns.disputedLost.byMonth,
        accounts.byMonth
      ),
      weekly_growth: mergeGrowth(
        [...weeklyRows, ...sumsToPaidRows(revolutPaid.byWeek)],
        returns.refunded.byWeek,
        returns.disputedLost.byWeek,
        accounts.byWeek
      ),
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
