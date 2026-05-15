import { Router, Request, Response, NextFunction } from "express";
import type Stripe from "stripe";
import { CreateBillingPortalSessionRequestSchema } from "../schemas";
import { buildContext, stripeRequestOptions } from "../lib/request-context";

const router = Router();

router.post(
  "/v1/billing_portal/sessions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateBillingPortalSessionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      }

      const ctx = await buildContext(req, res);
      const body = parsed.data as Stripe.BillingPortal.SessionCreateParams;

      const session = await ctx.stripe.billingPortal.sessions.create(body, stripeRequestOptions(ctx));

      res.locals.stripeObjectId = session.id;
      return res.json(session);
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
