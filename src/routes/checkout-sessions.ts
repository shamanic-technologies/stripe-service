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
    const pin = await selectAcquirerForCheckout(orgId);
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
    const metadata = { ...(body.metadata ?? {}), org_id: ctx.orgId };

    const session = await ctx.stripe.checkout.sessions.create(
      { ...body, metadata },
      stripeRequestOptions(ctx)
    );

    res.locals.stripeObjectId = session.id;
    await recordApiSnapshot(session, "checkout_session", ctx.orgId);
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
