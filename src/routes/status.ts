import { Router, Request, Response } from "express";
import { eq, inArray, and, sql, desc } from "drizzle-orm";
import { db } from "../db";
import {
  stripePayments,
  stripePaymentSuccesses,
  stripePaymentFailures,
  stripeRefunds,
  stripeDisputes,
} from "../db/schema";

const router = Router();

// GET /status/:paymentId - Full status with events
router.get("/status/:paymentId", async (req: Request, res: Response) => {
  const { paymentId } = req.params;

  try {
    const payment = await db.query.stripePayments.findFirst({
      where: eq(stripePayments.id, paymentId),
    });

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    // Fetch related events by payment intent ID
    const paymentIntentId = payment.stripePaymentIntentId;
    let successes: any[] = [];
    let failures: any[] = [];
    let refunds: any[] = [];
    let disputes: any[] = [];

    if (paymentIntentId) {
      [successes, failures, refunds, disputes] = await Promise.all([
        db
          .select()
          .from(stripePaymentSuccesses)
          .where(eq(stripePaymentSuccesses.stripePaymentIntentId, paymentIntentId)),
        db
          .select()
          .from(stripePaymentFailures)
          .where(eq(stripePaymentFailures.stripePaymentIntentId, paymentIntentId)),
        db
          .select()
          .from(stripeRefunds)
          .where(eq(stripeRefunds.stripePaymentIntentId, paymentIntentId)),
        db
          .select()
          .from(stripeDisputes)
          .where(eq(stripeDisputes.stripePaymentIntentId, paymentIntentId)),
      ]);
    }

    return res.json({
      payment,
      events: { successes, failures, refunds, disputes },
    });
  } catch (error: any) {
    console.error("Status lookup error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// GET /status/by-org/:orgId
router.get("/status/by-org/:orgId", async (req: Request, res: Response) => {
  const { orgId } = req.params;

  try {
    const payments = await db
      .select()
      .from(stripePayments)
      .where(eq(stripePayments.orgId, orgId))
      .orderBy(desc(stripePayments.createdAt));

    return res.json({ payments });
  } catch (error: any) {
    console.error("Status by-org error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// GET /status/by-run/:runId
router.get("/status/by-run/:runId", async (req: Request, res: Response) => {
  const { runId } = req.params;

  try {
    const payments = await db
      .select()
      .from(stripePayments)
      .where(eq(stripePayments.runId, runId))
      .orderBy(desc(stripePayments.createdAt));

    return res.json({ payments });
  } catch (error: any) {
    console.error("Status by-run error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// POST /stats - Aggregated stats
router.post("/stats", async (req: Request, res: Response) => {
  const { runIds, clerkOrgId, brandId, appId, campaignId } = req.body;

  try {
    const conditions = [];

    if (clerkOrgId) conditions.push(eq(stripePayments.orgId, clerkOrgId));
    if (brandId) conditions.push(eq(stripePayments.brandId, brandId));
    if (appId) conditions.push(eq(stripePayments.appId, appId));
    if (campaignId) conditions.push(eq(stripePayments.campaignId, campaignId));
    if (runIds?.length) conditions.push(inArray(stripePayments.runId, runIds));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const payments = await db
      .select()
      .from(stripePayments)
      .where(whereClause);

    // Gather all payment intent IDs for event queries
    const intentIds = payments
      .map((p) => p.stripePaymentIntentId)
      .filter(Boolean) as string[];

    let successCount = 0;
    let failureCount = 0;
    let refundCount = 0;
    let disputeCount = 0;

    if (intentIds.length > 0) {
      const [successes, failures, refundsResult, disputesResult] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(stripePaymentSuccesses)
          .where(inArray(stripePaymentSuccesses.stripePaymentIntentId, intentIds)),
        db
          .select({ count: sql<number>`count(*)` })
          .from(stripePaymentFailures)
          .where(inArray(stripePaymentFailures.stripePaymentIntentId, intentIds)),
        db
          .select({ count: sql<number>`count(*)` })
          .from(stripeRefunds)
          .where(inArray(stripeRefunds.stripePaymentIntentId, intentIds)),
        db
          .select({ count: sql<number>`count(*)` })
          .from(stripeDisputes)
          .where(inArray(stripeDisputes.stripePaymentIntentId, intentIds)),
      ]);

      successCount = Number(successes[0]?.count || 0);
      failureCount = Number(failures[0]?.count || 0);
      refundCount = Number(refundsResult[0]?.count || 0);
      disputeCount = Number(disputesResult[0]?.count || 0);
    }

    const totalAmountInCents = payments.reduce((sum, p) => sum + p.amountInCents, 0);

    return res.json({
      totalPayments: payments.length,
      totalAmountInCents,
      successCount,
      failureCount,
      refundCount,
      disputeCount,
    });
  } catch (error: any) {
    console.error("Stats error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
