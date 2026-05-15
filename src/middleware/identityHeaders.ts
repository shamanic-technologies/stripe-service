import { Request, Response, NextFunction } from "express";

const PUBLIC_PATHS = new Set(["/", "/health", "/openapi.json"]);

/**
 * x-org-id and x-user-id are mandatory on Stripe-touching routes
 * because the Stripe key is resolved per-org via key-service.
 *
 * x-brand-id, x-campaign-id, x-workflow-slug are optional context — logged
 * to api_call_log when present.
 *
 * Webhooks and public paths skip this check.
 */
export function requireIdentityHeaders(req: Request, res: Response, next: NextFunction) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/v1/webhooks")) return next();

  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];

  if (!orgId || typeof orgId !== "string") {
    return res.status(400).json({ error: "Missing required header: x-org-id" });
  }
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "Missing required header: x-user-id" });
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;

  const brandId = req.headers["x-brand-id"];
  const campaignId = req.headers["x-campaign-id"];
  const workflowSlug = req.headers["x-workflow-slug"];

  if (typeof brandId === "string") res.locals.brandId = brandId;
  if (typeof campaignId === "string") res.locals.campaignId = campaignId;
  if (typeof workflowSlug === "string") res.locals.workflowSlug = workflowSlug;

  next();
}
