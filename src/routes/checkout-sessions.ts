import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, lt } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db";
import { checkoutSessions } from "../db/schema";
import {
  CreateCheckoutSessionRequestSchema,
  ListCheckoutSessionsQuerySchema,
} from "../schemas";
import { buildContext, stripeRequestOptions } from "../lib/request-context";
import { recordApiSnapshot } from "../lib/event-processor";
import { isResourceMissing } from "../lib/stripe-client";
import { selectAcquirerForCheckout } from "../lib/acquirer-rollout";
import { checkoutViaRevolut, UnsupportedCheckout } from "../lib/checkout-org";
import { payerMetadata } from "../lib/payer-email";
import {
  assertSubscriptionAcquirer,
  pinOrgToStripeForSubscription,
  SubscriptionAcquirerNotStripe,
} from "../lib/subscriptions";

const router = Router();

/**
 * Create a checkout the org's customer can pay on.
 *
 * This is the one moment a NEW customer chooses to pay us, so it is where the
 * acquirer rollout applies: an org with no pin and no saved payment method may
 * be selected for a second acquirer here, and every other org is left exactly
 * where it is. An org on Stripe takes the unchanged path below and gets its
 * verbatim Stripe Session, byte for byte — a rollout at 0% costs one extra DB
 * read and nothing else.
 *
 * An org on an acquirer with no Checkout Session object gets the neutral
 * checkout instead: same `url` to send the buyer to, without a Stripe object
 * fabricated around it. The shape differs because the capability differs, which
 * is the same rule the neutral charge follows.
 */
router.post("/v1/checkout/sessions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateCheckoutSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const orgId = res.locals.orgId as string;
    // A SUBSCRIPTION is Stripe-only and must never trigger the rollout: the
    // rollout can pin a new org to the second acquirer as a side effect, and
    // that acquirer has no subscription object, so the request would then be
    // refused AFTER the org had been moved for good. Decide without writing
    // anything; refuse an org already pinned elsewhere.
    const isSubscription = parsed.data.mode === "subscription";
    let subscriptionPinned = true;
    if (isSubscription) {
      try {
        ({ pinned: subscriptionPinned } = await assertSubscriptionAcquirer(orgId));
      } catch (err) {
        if (err instanceof SubscriptionAcquirerNotStripe) {
          return res.status(409).json({ error: err.message, code: "acquirer_not_stripe", acquirer: err.acquirer });
        }
        throw err;
      }
    }
    const pin = isSubscription
      ? { acquirer: "stripe" as const, customerId: null, pinned: subscriptionPinned }
      : await selectAcquirerForCheckout(orgId);
    if (pin.acquirer === "revolut") {
      if (!pin.customerId) {
        return res.status(409).json({
          error: `Org ${orgId} is pinned to an acquirer it has no customer on; there is nothing to check out against`,
        });
      }
      try {
        const checkout = await checkoutViaRevolut({
          orgId,
          customerId: pin.customerId,
          body: parsed.data as Stripe.Checkout.SessionCreateParams,
        });
        res.locals.stripeObjectId = checkout.id;
        return res.json(checkout);
      } catch (err) {
        if (err instanceof UnsupportedCheckout) {
          return res.status(422).json({ error: err.message });
        }
        throw err;
      }
    }

    const ctx = await buildContext(req, res);
    const body = parsed.data as Stripe.Checkout.SessionCreateParams;
    // `payer_user_id` names the person opening this checkout, so that when
    // Stripe reports it PAID (or the card saved) the customer's contact email
    // follows them — see src/lib/payer-email.ts. A setup session creates a
    // SetupIntent, which is what reports the card saved, so it carries it too.
    const payer = payerMetadata(ctx.userId);
    const metadata = { ...(body.metadata ?? {}), ...payer, org_id: ctx.orgId };
    const params: Stripe.Checkout.SessionCreateParams = { ...body, metadata };
    if (isSubscription) {
      // Stamp the org on the SUBSCRIPTION itself, not only on the session, so
      // every object Stripe derives from it routes back to the org.
      params.subscription_data = {
        ...(body.subscription_data ?? {}),
        metadata: { ...(body.subscription_data?.metadata ?? {}), org_id: ctx.orgId },
      };
    }
    if (body.mode === "setup") {
      params.setup_intent_data = {
        ...(body.setup_intent_data ?? {}),
        metadata: { ...(body.setup_intent_data?.metadata ?? {}), ...payer },
      };
    }

    const session = await ctx.stripe.checkout.sessions.create(
      params,
      stripeRequestOptions(ctx)
    );

    res.locals.stripeObjectId = session.id;
    await recordApiSnapshot(session, "checkout_session", ctx.orgId);
    if (isSubscription) await pinOrgToStripeForSubscription(ctx.orgId, subscriptionPinned);
    return res.json(session);
  } catch (err) {
    return next(err);
  }
});

router.get(
  "/v1/checkout/sessions/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = res.locals.orgId as string;
      const { id } = req.params;
      res.locals.stripeObjectId = id;

      const row = await db
        .select()
        .from(checkoutSessions)
        .where(and(eq(checkoutSessions.id, id), eq(checkoutSessions.orgId, orgId)))
        .limit(1);

      if (row.length > 0 && row[0].rawJson) {
        return res.json(row[0].rawJson);
      }

      const ctx = await buildContext(req, res);
      try {
        const session = await ctx.stripe.checkout.sessions.retrieve(id);
        await recordApiSnapshot(session, "checkout_session", orgId);
        return res.json(session);
      } catch (err) {
        if (isResourceMissing(err)) {
          return res.status(404).json({ error: "Checkout session not found" });
        }
        throw err;
      }
    } catch (err) {
      return next(err);
    }
  }
);

router.get("/v1/checkout/sessions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = ListCheckoutSessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    }
    const orgId = res.locals.orgId as string;
    const { customer, payment_intent, limit, starting_after } = parsed.data;
    const effectiveLimit = limit ?? 10;

    const filters = [eq(checkoutSessions.orgId, orgId)];
    if (customer) filters.push(eq(checkoutSessions.customer, customer));
    if (payment_intent) filters.push(eq(checkoutSessions.paymentIntent, payment_intent));
    if (starting_after) {
      const anchor = await db
        .select({ syncedAt: checkoutSessions.syncedAt })
        .from(checkoutSessions)
        .where(eq(checkoutSessions.id, starting_after))
        .limit(1);
      if (anchor.length > 0) {
        filters.push(lt(checkoutSessions.syncedAt, anchor[0].syncedAt));
      }
    }

    const rows = await db
      .select()
      .from(checkoutSessions)
      .where(and(...filters))
      .orderBy(desc(checkoutSessions.syncedAt))
      .limit(effectiveLimit + 1);

    const hasMore = rows.length > effectiveLimit;
    const data = rows.slice(0, effectiveLimit).map((r) => r.rawJson);

    return res.json({
      object: "list",
      data,
      has_more: hasMore,
      url: "/v1/checkout/sessions",
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
