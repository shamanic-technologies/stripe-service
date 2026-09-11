import { Router, Request, Response, NextFunction } from "express";
import { CreateBillingPortalSessionRequestSchema } from "../schemas";
import { buildContext, stripeRequestOptions } from "../lib/request-context";
import {
  cardUpdatePortalParams,
  invoiceHistoryPortalParams,
} from "../lib/portal-session";

const router = Router();

/**
 * POST /v1/billing_portal/sessions
 *
 * Creates a portal session that can NEVER remove a card. See
 * `src/lib/portal-session.ts` for why that is a rule of this service rather
 * than a caller's choice.
 *
 * The caller says what the customer came to do; the session shape follows:
 *
 *   flow_data { type: "payment_method_update" }  -> the add/replace-a-card flow
 *   no flow_data                                 -> invoice history
 *
 * Two things are REFUSED rather than honoured, because honouring either would
 * hand back the full portal under a different name:
 *
 *   - a caller-supplied `configuration`. The configuration is what makes the
 *     guarantee true, so it is ours, not the caller's.
 *   - any `flow_data.type` other than `payment_method_update`. We bill one-off
 *     PaymentIntents; there is no subscription flow to run, and an unknown flow
 *     is not something to pass through blind.
 */
router.post(
  "/v1/billing_portal/sessions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateBillingPortalSessionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      }

      const body = parsed.data;

      if (body.configuration !== undefined) {
        return res.status(400).json({
          error:
            "configuration is not accepted: this service pins the portal configuration so a session can never expose card removal",
        });
      }

      const flowType = body.flow_data?.type;
      if (flowType !== undefined && flowType !== "payment_method_update") {
        return res.status(400).json({
          error: `Unsupported flow_data.type '${String(flowType)}': only 'payment_method_update' is supported`,
        });
      }

      const params =
        flowType === "payment_method_update"
          ? cardUpdatePortalParams({ customer: body.customer, return_url: body.return_url })
          : invoiceHistoryPortalParams({ customer: body.customer, return_url: body.return_url });

      const ctx = await buildContext(req, res);
      const session = await ctx.stripe.billingPortal.sessions.create(params, stripeRequestOptions(ctx));

      res.locals.stripeObjectId = session.id;
      return res.json(session);
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
