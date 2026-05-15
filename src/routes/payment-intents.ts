import { Router, Request, Response, NextFunction } from "express";
import { eq, and, desc, lt } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../db";
import { paymentIntents } from "../db/schema";
import {
  CreatePaymentIntentRequestSchema,
  ListPaymentIntentsQuerySchema,
} from "../schemas";
import { buildContext, stripeRequestOptions } from "../lib/request-context";
import { upsertPaymentIntent } from "../lib/event-processor";
import { isResourceMissing } from "../lib/stripe-client";

const router = Router();

router.post("/v1/payment_intents", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CreatePaymentIntentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const ctx = await buildContext(req, res);
    const body = parsed.data as Stripe.PaymentIntentCreateParams;
    const metadata = { ...(body.metadata ?? {}), org_id: ctx.orgId };

    const pi = await ctx.stripe.paymentIntents.create(
      { ...body, metadata },
      stripeRequestOptions(ctx)
    );

    res.locals.stripeObjectId = pi.id;
    await upsertPaymentIntent(pi, ctx.orgId);
    return res.json(pi);
  } catch (err) {
    return next(err);
  }
});

router.get(
  "/v1/payment_intents/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = res.locals.orgId as string;
      const { id } = req.params;
      res.locals.stripeObjectId = id;

      const row = await db
        .select()
        .from(paymentIntents)
        .where(and(eq(paymentIntents.id, id), eq(paymentIntents.orgId, orgId)))
        .limit(1);

      if (row.length > 0 && row[0].rawJson) {
        return res.json(row[0].rawJson);
      }

      const ctx = await buildContext(req, res);
      try {
        const pi = await ctx.stripe.paymentIntents.retrieve(id);
        await upsertPaymentIntent(pi, orgId);
        return res.json(pi);
      } catch (err) {
        if (isResourceMissing(err)) {
          return res.status(404).json({ error: "PaymentIntent not found" });
        }
        throw err;
      }
    } catch (err) {
      return next(err);
    }
  }
);

router.get("/v1/payment_intents", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = ListPaymentIntentsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    }
    const orgId = res.locals.orgId as string;
    const { customer, limit, starting_after } = parsed.data;
    const effectiveLimit = limit ?? 10;

    const filters = [eq(paymentIntents.orgId, orgId)];
    if (customer) filters.push(eq(paymentIntents.customer, customer));
    if (starting_after) {
      const anchor = await db
        .select({ syncedAt: paymentIntents.syncedAt })
        .from(paymentIntents)
        .where(eq(paymentIntents.id, starting_after))
        .limit(1);
      if (anchor.length > 0) {
        filters.push(lt(paymentIntents.syncedAt, anchor[0].syncedAt));
      }
    }

    const rows = await db
      .select()
      .from(paymentIntents)
      .where(and(...filters))
      .orderBy(desc(paymentIntents.syncedAt))
      .limit(effectiveLimit + 1);

    const hasMore = rows.length > effectiveLimit;
    const data = rows.slice(0, effectiveLimit).map((r) => r.rawJson);

    return res.json({
      object: "list",
      data,
      has_more: hasMore,
      url: "/v1/payment_intents",
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
