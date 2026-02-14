import { Router, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  stripePayments,
  stripePaymentSuccesses,
  stripePaymentFailures,
  stripeRefunds,
  stripeDisputes,
  stripeCheckoutSessions,
} from "../db/schema";
import { constructWebhookEvent } from "../lib/stripe-client";
import type Stripe from "stripe";

const router = Router();

// POST /webhooks/stripe
router.post(
  "/webhooks/stripe",
  async (req: Request, res: Response) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error("STRIPE_WEBHOOK_SECRET not configured");
      return res.status(500).json({ error: "Webhook secret not configured" });
    }

    const signature = req.headers["stripe-signature"] as string;
    if (!signature) {
      return res.status(400).json({ error: "Missing stripe-signature header" });
    }

    let event: Stripe.Event;

    try {
      event = constructWebhookEvent(req.body, signature, webhookSecret);
    } catch (err: any) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).json({ error: "Invalid signature" });
    }

    try {
      switch (event.type) {
        case "payment_intent.succeeded":
          await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
          break;

        case "payment_intent.payment_failed":
          await handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
          break;

        case "charge.refunded":
          await handleChargeRefunded(event.data.object as Stripe.Charge);
          break;

        case "charge.dispute.created":
          await handleDisputeCreated(event.data.object as Stripe.Dispute);
          break;

        case "checkout.session.completed":
          await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
          break;

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      return res.json({ received: true });
    } catch (error: any) {
      console.error(`Webhook handler error for ${event.type}:`, error);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  // Record success event
  await db
    .insert(stripePaymentSuccesses)
    .values({
      stripePaymentIntentId: paymentIntent.id,
      stripeChargeId: paymentIntent.latest_charge as string | null,
      amountInCents: paymentIntent.amount,
      currency: paymentIntent.currency,
      receiptUrl: null,
      rawPayload: JSON.stringify(paymentIntent),
    })
    .onConflictDoNothing();

  // Update payment record status
  await db
    .update(stripePayments)
    .set({ status: "succeeded", updatedAt: new Date() })
    .where(eq(stripePayments.stripePaymentIntentId, paymentIntent.id));
}

async function handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent) {
  const lastError = paymentIntent.last_payment_error;

  await db
    .insert(stripePaymentFailures)
    .values({
      stripePaymentIntentId: paymentIntent.id,
      failureCode: lastError?.code ?? null,
      failureMessage: lastError?.message ?? null,
      rawPayload: JSON.stringify(paymentIntent),
    });

  // Update payment record status
  await db
    .update(stripePayments)
    .set({ status: "failed", updatedAt: new Date() })
    .where(eq(stripePayments.stripePaymentIntentId, paymentIntent.id));
}

async function handleChargeRefunded(charge: Stripe.Charge) {
  const refunds = charge.refunds?.data || [];

  for (const refund of refunds) {
    await db
      .insert(stripeRefunds)
      .values({
        stripeRefundId: refund.id,
        stripePaymentIntentId: charge.payment_intent as string | null,
        stripeChargeId: charge.id,
        amountInCents: refund.amount,
        currency: refund.currency,
        reason: refund.reason,
        status: refund.status || "unknown",
        rawPayload: JSON.stringify(refund),
      })
      .onConflictDoNothing();
  }

  // Update payment record status if fully refunded
  if (charge.refunded && charge.payment_intent) {
    await db
      .update(stripePayments)
      .set({ status: "refunded", updatedAt: new Date() })
      .where(eq(stripePayments.stripePaymentIntentId, charge.payment_intent as string));
  }
}

async function handleDisputeCreated(dispute: Stripe.Dispute) {
  await db
    .insert(stripeDisputes)
    .values({
      stripeDisputeId: dispute.id,
      stripePaymentIntentId: dispute.payment_intent as string | null,
      stripeChargeId: dispute.charge as string,
      amountInCents: dispute.amount,
      currency: dispute.currency,
      reason: dispute.reason,
      status: dispute.status,
      rawPayload: JSON.stringify(dispute),
    })
    .onConflictDoNothing();

  // Update payment record status
  if (dispute.payment_intent) {
    await db
      .update(stripePayments)
      .set({ status: "disputed", updatedAt: new Date() })
      .where(eq(stripePayments.stripePaymentIntentId, dispute.payment_intent as string));
  }
}

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  await db
    .insert(stripeCheckoutSessions)
    .values({
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent as string | null,
      stripeCustomerId: session.customer as string | null,
      amountTotalInCents: session.amount_total,
      currency: session.currency,
      paymentStatus: session.payment_status,
      status: session.status || "complete",
      rawPayload: JSON.stringify(session),
    })
    .onConflictDoNothing();

  // Update payment record with checkout details
  if (session.payment_intent) {
    await db
      .update(stripePayments)
      .set({
        stripePaymentIntentId: session.payment_intent as string,
        stripeCustomerId: session.customer as string | null,
        amountInCents: session.amount_total || 0,
        currency: session.currency || "usd",
        status: session.payment_status === "paid" ? "succeeded" : "pending",
        updatedAt: new Date(),
      })
      .where(eq(stripePayments.stripeCheckoutSessionId, session.id));
  }
}

export default router;
