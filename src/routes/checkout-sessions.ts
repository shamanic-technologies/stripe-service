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
import { upsertCheckoutSession } from "../lib/event-processor";
import { isResourceMissing } from "../lib/stripe-client";

const router = Router();

router.post("/v1/checkout/sessions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateCheckoutSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const ctx = await buildContext(req, res);
    const body = parsed.data as Stripe.Checkout.SessionCreateParams;
    const metadata = { ...(body.metadata ?? {}), org_id: ctx.orgId };

    const session = await ctx.stripe.checkout.sessions.create(
      { ...body, metadata },
      stripeRequestOptions(ctx)
    );

    res.locals.stripeObjectId = session.id;
    await upsertCheckoutSession(session, ctx.orgId);
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
        await upsertCheckoutSession(session, orgId);
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
