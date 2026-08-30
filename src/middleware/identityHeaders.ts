import { Request, Response, NextFunction } from "express";

const PUBLIC_PATHS = new Set(["/", "/health", "/openapi.json"]);

/**
 * x-org-id and x-user-id are mandatory on Stripe-touching routes
 * because the Stripe key is resolved per-org via key-service.
 *
 * x-brand-id, x-campaign-id, x-workflow-slug are optional context — logged
 * to api_call_log when present.
 *
 * Webhooks (both acquirers) and public paths skip this check.
 *
 * `/internal/*` routes are server-to-server (X-API-Key still required via
 * serviceAuth) and key the org off the path, so they skip identity headers.
 */
export function requireIdentityHeaders(req: Request, res: Response, next: NextFunction) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/v1/webhooks")) return next();
  // A second acquirer signs with its own scheme and cannot send our API key or
  // an end-user identity, exactly like the Stripe webhook above. Note the path
  // does NOT match the prefix on the line above — an acquirer added under
  // /v1/<name>/webhooks needs its own exemption or it 401s, and a webhook that
  // keeps 401ing gets the endpoint DISABLED by the sender.
  if (req.path.startsWith("/v1/revolut/webhooks")) return next();
  if (req.path.startsWith("/public/")) return next();
  if (req.path.startsWith("/internal/")) return next();

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
