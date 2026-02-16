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
  let runId = data.runId;

  try {
    // Resolve Stripe key: from key-service if appId provided, else env var
    let stripeKey: string | undefined;
    if (data.appId) {
      try {
        stripeKey = await resolveStripeKey(data.appId);
      } catch (err) {
        console.error("Failed to resolve Stripe key for appId:", data.appId, err);
        return res.status(500).json({
          error: "Failed to resolve Stripe key from key-service",
        });
      }
    }

    // Create run in runs-service if orgId provided (BLOCKING)
    if (data.orgId && !runId) {
      try {
        const run = await createRun({
          clerkOrgId: data.orgId,
          appId: data.appId || "stripe-service",
          serviceName: "stripe-service",
          taskName: "create-checkout-session",
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
          ...(runId ? { runId } : {}),
          ...(data.orgId ? { orgId: data.orgId } : {}),
        },
        discounts: data.discounts,
      },
      stripeKey
    );

    if (!result.success) {
      if (runId) {
        await updateRun(runId, "failed").catch(console.error);
      }
      return res.status(500).json({ error: result.error || "Stripe error" });
    }

    // Record payment in database
    const [payment] = await db
      .insert(stripePayments)
      .values({
        orgId: data.orgId,
        runId,
        brandId: data.brandId,
        appId: data.appId,
        campaignId: data.campaignId,
        stripeCheckoutSessionId: result.sessionId,
        amountInCents: 0, // Amount determined at checkout
        currency: "usd",
        status: "checkout_created",
        metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      })
      .returning();

    // Add costs to run
    if (runId) {
      await addCosts(runId, [
        { costName: "stripe-checkout-session", quantity: 1 },
      ]).catch(console.error);
      await updateRun(runId, "completed").catch(console.error);
    }

    return res.json({
      success: true,
      paymentId: payment.id,
      sessionId: result.sessionId,
      url: result.url,
    });
  } catch (error: any) {
    console.error("Checkout create error:", error);
    if (runId) {
      await updateRun(runId, "failed").catch(console.error);
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
  let runId = data.runId;

  try {
    // Resolve Stripe key: from key-service if appId provided, else env var
    let stripeKey: string | undefined;
    if (data.appId) {
      try {
        stripeKey = await resolveStripeKey(data.appId);
      } catch (err) {
        console.error("Failed to resolve Stripe key for appId:", data.appId, err);
        return res.status(500).json({
          error: "Failed to resolve Stripe key from key-service",
        });
      }
    }

    // Create run in runs-service if orgId provided (BLOCKING)
    if (data.orgId && !runId) {
      try {
        const run = await createRun({
          clerkOrgId: data.orgId,
          appId: data.appId || "stripe-service",
          serviceName: "stripe-service",
          taskName: "create-payment-intent",
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
          ...(runId ? { runId } : {}),
          ...(data.orgId ? { orgId: data.orgId } : {}),
        },
      },
      stripeKey
    );

    if (!result.success) {
      if (runId) {
        await updateRun(runId, "failed").catch(console.error);
      }
      return res.status(500).json({ error: result.error || "Stripe error" });
    }

    // Record payment in database
    const [payment] = await db
      .insert(stripePayments)
      .values({
        orgId: data.orgId,
        runId,
        brandId: data.brandId,
        appId: data.appId,
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
    if (runId) {
      await addCosts(runId, [
        { costName: "stripe-payment-intent", quantity: 1 },
      ]).catch(console.error);
      await updateRun(runId, "completed").catch(console.error);
    }

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
      await updateRun(runId, "failed").catch(console.error);
    }
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

export default router;
