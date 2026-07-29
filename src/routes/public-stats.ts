import { Router, Request, Response, NextFunction } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { paymentIntents, customers } from "../db/schema";
import {
  mergeGrowth,
  platformReturns,
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
 * Returns follow the same "money is really gone" rule as every other read in
 * this service: settled (`succeeded`) Refunds plus LOST Disputes, attributed to
 * a mirrored PaymentIntent — so this total is exactly the sum of the per-org
 * `GET /internal/payment_summary/by-org/:orgId` totals.
 *
 * Buckets attribute a return to the period it HAPPENED in, not to the period of
 * the payment it reverses — see `mergeGrowth`.
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

    const returns = await platformReturns();
    const totalRefundedCents = returns.refunded.total;
    const totalDisputedLostCents = returns.disputedLost.total;
    const totalReturnedCents = totalRefundedCents + totalDisputedLostCents;

    return res.json({
      total_paid_cents: totalPaidCents.toString(),
      total_refunded_cents: totalRefundedCents.toString(),
      total_disputed_lost_cents: totalDisputedLostCents.toString(),
      total_returned_cents: totalReturnedCents.toString(),
      total_net_cents: (totalPaidCents - totalReturnedCents).toString(),
      accounts_with_payment_method: accountsWithPaymentMethod,
      monthly_growth: mergeGrowth(
        monthlyRows,
        returns.refunded.byMonth,
        returns.disputedLost.byMonth
      ),
      weekly_growth: mergeGrowth(
        weeklyRows,
        returns.refunded.byWeek,
        returns.disputedLost.byWeek
      ),
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
