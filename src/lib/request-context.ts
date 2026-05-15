import type { Request, Response } from "express";
import { resolveStripeKey } from "./resolve-stripe-key";
import { makeStripeClient } from "./stripe-client";
import type Stripe from "stripe";

export interface RequestContext {
  orgId: string;
  userId: string;
  brandId?: string;
  campaignId?: string;
  workflowSlug?: string;
  idempotencyKey?: string;
  stripe: Stripe;
  keySource: "platform" | "org";
}

/**
 * Pull identity context from res.locals (set by identityHeaders middleware),
 * resolve the per-org Stripe key, and construct a Stripe client.
 */
export async function buildContext(req: Request, res: Response): Promise<RequestContext> {
  const orgId = res.locals.orgId as string;
  const userId = res.locals.userId as string;
  const brandId = res.locals.brandId as string | undefined;
  const campaignId = res.locals.campaignId as string | undefined;
  const workflowSlug = res.locals.workflowSlug as string | undefined;

  const idempotencyHeader = req.headers["idempotency-key"];
  const idempotencyKey =
    typeof idempotencyHeader === "string" ? idempotencyHeader : undefined;

  const { key, keySource } = await resolveStripeKey(orgId, userId, {
    method: req.method,
    path: req.path,
    brandId,
    campaignId,
    workflowSlug,
  });

  return {
    orgId,
    userId,
    brandId,
    campaignId,
    workflowSlug,
    idempotencyKey,
    stripe: makeStripeClient(key),
    keySource,
  };
}

export function stripeRequestOptions(ctx: RequestContext): Stripe.RequestOptions | undefined {
  if (!ctx.idempotencyKey) return undefined;
  return { idempotencyKey: ctx.idempotencyKey };
}
