import { Router, Request, Response, NextFunction } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { paymentIntents, customers } from "../db/schema";

const router = Router();

type Bucket = { period: Date | string; paid_cents: string | null };

function formatPeriod(p: Date | string): string {
  if (p instanceof Date) return p.toISOString().slice(0, 10);
  return String(p).slice(0, 10);
}

router.get("/public/stats/billing", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const totalRows = await db
      .select({
        total: sql<string>`COALESCE(SUM(${paymentIntents.amountReceived}), 0)::text`,
      })
      .from(paymentIntents)
      .where(eq(paymentIntents.status, "succeeded"));

    const totalPaidCents = totalRows[0]?.total ?? "0";

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
      )) as Bucket[];

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
      )) as Bucket[];

    return res.json({
      total_paid_cents: totalPaidCents,
      accounts_with_payment_method: accountsWithPaymentMethod,
      monthly_growth: monthlyRows.map((r) => ({
        period: formatPeriod(r.period),
        paid_cents: r.paid_cents ?? "0",
      })),
      weekly_growth: weeklyRows.map((r) => ({
        period: formatPeriod(r.period),
        paid_cents: r.paid_cents ?? "0",
      })),
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
