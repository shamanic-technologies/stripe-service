import { Router, Request, Response, NextFunction } from "express";
import {
  SubscriptionAmountRequestSchema,
  SubscriptionCheckoutRequestSchema,
} from "../schemas";
import {
  SubscriptionAcquirerNotStripe,
  SubscriptionEnded,
  SubscriptionNoCustomer,
  SubscriptionNotFound,
  SubscriptionNotOwned,
  SubscriptionShapeUnsupported,
  changeSubscriptionAmount,
  createSubscriptionCheckout,
  listOrgSubscriptions,
  setCancelAtPeriodEnd,
} from "../lib/subscriptions";

/**
 * `/internal/subscriptions/*` — org-scoped Stripe subscriptions, user-less
 * (X-API-Key only, org in the path), platform key. See src/lib/subscriptions.ts.
 */
const router = Router();

function headerString(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** The definite refusals, each with its own code. Anything else is next(err). */
function answerRefusal(err: unknown, res: Response): boolean {
  if (err instanceof SubscriptionAcquirerNotStripe) {
    res.status(409).json({ error: err.message, code: "acquirer_not_stripe", acquirer: err.acquirer });
    return true;
  }
  if (err instanceof SubscriptionNoCustomer) {
    res.status(409).json({ error: err.message, code: "no_customer" });
    return true;
  }
  if (err instanceof SubscriptionNotFound) {
    res.status(404).json({ error: err.message, code: "subscription_not_found" });
    return true;
  }
  if (err instanceof SubscriptionNotOwned) {
    res.status(403).json({ error: err.message, code: "subscription_not_owned" });
    return true;
  }
  if (err instanceof SubscriptionEnded) {
    res.status(409).json({ error: err.message, code: "subscription_ended", status: err.status });
    return true;
  }
  if (err instanceof SubscriptionShapeUnsupported) {
    res.status(409).json({ error: err.message, code: "subscription_shape_unsupported" });
    return true;
  }
  return false;
}

router.post(
  "/internal/subscriptions/by-org/:orgId/checkout",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;
      const parsed = SubscriptionCheckoutRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid request", details: parsed.error.flatten() });
      }
      const payerUserId = headerString(req, "x-user-id") ?? null;
      if (payerUserId) res.locals.userId = payerUserId;
      const b = parsed.data;
      const session = await createSubscriptionCheckout({
        orgId,
        amount: b.amount,
        currency: b.currency,
        trialPeriodDays: b.trial_period_days,
        uiMode: b.ui_mode ?? "hosted",
        successUrl: b.success_url,
        cancelUrl: b.cancel_url,
        returnUrl: b.return_url,
        productName: b.product_name,
        metadata: b.metadata,
        payerUserId,
        idempotencyKey: headerString(req, "idempotency-key"),
      });
      res.locals.stripeObjectId = session.id;
      return res.json(session);
    } catch (err) {
      if (answerRefusal(err, res)) return;
      return next(err);
    }
  }
);

router.get(
  "/internal/subscriptions/by-org/:orgId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.params.orgId;
      res.locals.orgId = orgId;
      const data = await listOrgSubscriptions(orgId);
      return res.json({
        object: "list",
        org_id: orgId,
        has_subscription: data.length > 0,
        data,
      });
    } catch (err) {
      return next(err);
    }
  }
);

router.post(
  "/internal/subscriptions/by-org/:orgId/:subscriptionId/amount",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, subscriptionId } = req.params;
      res.locals.orgId = orgId;
      res.locals.stripeObjectId = subscriptionId;
      const parsed = SubscriptionAmountRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid request", details: parsed.error.flatten() });
      }
      const summary = await changeSubscriptionAmount({
        orgId,
        subscriptionId,
        amount: parsed.data.amount,
        idempotencyKey: headerString(req, "idempotency-key"),
      });
      return res.json(summary);
    } catch (err) {
      if (answerRefusal(err, res)) return;
      return next(err);
    }
  }
);

async function cancellation(
  req: Request,
  res: Response,
  next: NextFunction,
  cancelAtPeriodEnd: boolean
) {
  try {
    const { orgId, subscriptionId } = req.params;
    res.locals.orgId = orgId;
    res.locals.stripeObjectId = subscriptionId;
    const summary = await setCancelAtPeriodEnd({ orgId, subscriptionId, cancelAtPeriodEnd });
    return res.json(summary);
  } catch (err) {
    if (answerRefusal(err, res)) return;
    return next(err);
  }
}

router.post("/internal/subscriptions/by-org/:orgId/:subscriptionId/cancellation", (req, res, next) =>
  cancellation(req, res, next, true)
);
router.delete("/internal/subscriptions/by-org/:orgId/:subscriptionId/cancellation", (req, res, next) =>
  cancellation(req, res, next, false)
);

export default router;
