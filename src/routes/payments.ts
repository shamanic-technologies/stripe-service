import { Router, Request, Response } from "express";
import { db } from "../db";
import { stripePayments } from "../db/schema";
import {
  CreateCheckoutSessionRequestSchema,
  CreatePaymentIntentRequestSchema,
} from "../schemas";
import {
  createCheckoutSession,
  createPaymentIntent,
} from "../lib/stripe-client";
import { createRun, updateRun, addCosts } from "../lib/runs-client";
import { resolveStripeKey } from "../lib/resolve-stripe-key";

const router = Router();

// POST /checkout/create
router.post("/checkout/create", async (req: Request, res: Response) => {
  // Validate request
  const parsed = CreateCheckoutSessionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const data = parsed.data;
  const orgId = res.locals.orgId as string;
  const userId = res.locals.userId as string;
  const callerRunId = res.locals.runId as string;
  let runId: string | undefined;
  const identity = { orgId, userId };

  try {
    // Resolve Stripe key via key-service using orgId + userId
    let stripeKey: string;
    let keySource: "platform" | "org";
    try {
      const resolved = await resolveStripeKey(orgId, userId, { method: req.method, path: req.path });
      stripeKey = resolved.key;
      keySource = resolved.keySource;
    } catch (err: any) {
      console.error("Failed to resolve Stripe key:", err.message);
      return res.status(400).json({ error: err.message });
    }

    // Create own run in runs-service (BLOCKING), linked to caller's run
    try {
      const run = await createRun({
        orgId,
        userId,
        serviceName: "stripe-service",
        taskName: "create-checkout-session",
        parentRunId: callerRunId,
        brandId: data.brandId,
        campaignId: data.campaignId,
      });
      runId = run.id;
    } catch (err) {
      console.error("Failed to create run:", err);
      return res.status(500).json({
        error: "Failed to create run in runs-service",
      });
    }

    // Create Stripe checkout session
    const result = await createCheckoutSession(
      {
        lineItems: data.lineItems,
        successUrl: data.successUrl,
        cancelUrl: data.cancelUrl,
        customerId: data.customerId,
        customerEmail: data.customerEmail,
        mode: data.mode,
        metadata: {
          ...data.metadata,
          runId,
          orgId,
        },
        discounts: data.discounts,
      },
      stripeKey
    );

    if (!result.success) {
      await updateRun(runId, "failed", { ...identity, runId }).catch(console.error);
      return res.status(500).json({ error: result.error || "Stripe error" });
    }

    // Record payment in database
    const [payment] = await db
      .insert(stripePayments)
      .values({
        orgId,
        userId,
        runId,
        brandId: data.brandId,
        campaignId: data.campaignId,
        stripeCheckoutSessionId: result.sessionId,
        amountInCents: 0, // Amount determined at checkout
        currency: "usd",
        status: "checkout_created",
        metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      })
      .returning();

    // Add costs to run
    await addCosts(runId, [
      { costName: "stripe-checkout-session", quantity: 1, costSource: keySource },
    ], { ...identity, runId }).catch(console.error);
    await updateRun(runId, "completed", { ...identity, runId }).catch(console.error);

    return res.json({
      success: true,
      paymentId: payment.id,
      sessionId: result.sessionId,
      url: result.url,
    });
  } catch (error: any) {
    console.error("Checkout create error:", error);
    if (runId) {
      await updateRun(runId, "failed", { ...identity, runId }).catch(console.error);
    }
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// POST /payment-intent/create
router.post("/payment-intent/create", async (req: Request, res: Response) => {
  const parsed = CreatePaymentIntentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request",
      details: parsed.error.flatten(),
    });
  }

  const data = parsed.data;
  const orgId = res.locals.orgId as string;
  const userId = res.locals.userId as string;
  const callerRunId = res.locals.runId as string;
  let runId: string | undefined;
  const identity = { orgId, userId };

  try {
    // Resolve Stripe key via key-service using orgId + userId
    let stripeKey: string;
    let keySource: "platform" | "org";
    try {
      const resolved = await resolveStripeKey(orgId, userId, { method: req.method, path: req.path });
      stripeKey = resolved.key;
      keySource = resolved.keySource;
    } catch (err: any) {
      console.error("Failed to resolve Stripe key:", err.message);
      return res.status(400).json({ error: err.message });
    }

    // Create own run in runs-service (BLOCKING), linked to caller's run
    try {
      const run = await createRun({
        orgId,
        userId,
        serviceName: "stripe-service",
        taskName: "create-payment-intent",
        parentRunId: callerRunId,
        brandId: data.brandId,
        campaignId: data.campaignId,
      });
      runId = run.id;
    } catch (err) {
      console.error("Failed to create run:", err);
      return res.status(500).json({
        error: "Failed to create run in runs-service",
      });
    }

    // Create Stripe payment intent
    const result = await createPaymentIntent(
      {
        amountInCents: data.amountInCents,
        currency: data.currency,
        customerId: data.customerId,
        description: data.description,
        metadata: {
          ...data.metadata,
          runId,
          orgId,
        },
      },
      stripeKey
    );

    if (!result.success) {
      await updateRun(runId, "failed", { ...identity, runId }).catch(console.error);
      return res.status(500).json({ error: result.error || "Stripe error" });
    }

    // Record payment in database
    const [payment] = await db
      .insert(stripePayments)
      .values({
        orgId,
        userId,
        runId,
        brandId: data.brandId,
        campaignId: data.campaignId,
        stripePaymentIntentId: result.paymentIntentId,
        amountInCents: data.amountInCents,
        currency: data.currency || "usd",
        status: result.status || "requires_payment_method",
        description: data.description,
        metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      })
      .returning();

    // Add costs to run
    await addCosts(runId, [
      { costName: "stripe-payment-intent", quantity: 1, costSource: keySource },
    ], { ...identity, runId }).catch(console.error);
    await updateRun(runId, "completed", { ...identity, runId }).catch(console.error);

    return res.json({
      success: true,
      paymentId: payment.id,
      paymentIntentId: result.paymentIntentId,
      clientSecret: result.clientSecret,
      status: result.status,
    });
  } catch (error: any) {
    console.error("Payment intent create error:", error);
    if (runId) {
      await updateRun(runId, "failed", { ...identity, runId }).catch(console.error);
    }
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
