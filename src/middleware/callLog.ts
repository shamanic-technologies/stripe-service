import { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { apiCallLog } from "../db/schema";

const SKIP_PATHS = new Set(["/", "/health", "/openapi.json"]);

/**
 * Append a row to api_call_log for every request after the response is sent.
 * Captures identity headers when present, the resolved stripe_object_id
 * (set by route handlers via res.locals.stripeObjectId), and request duration.
 */
export function callLog(req: Request, res: Response, next: NextFunction) {
  if (SKIP_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/v1/webhooks")) return next();

  const start = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - start;
    db.insert(apiCallLog)
      .values({
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        orgId: (res.locals.orgId as string) ?? null,
        userId: (res.locals.userId as string) ?? null,
        brandId: (res.locals.brandId as string) ?? null,
        campaignId: (res.locals.campaignId as string) ?? null,
        workflowSlug: (res.locals.workflowSlug as string) ?? null,
        stripeObjectId: (res.locals.stripeObjectId as string) ?? null,
        durationMs,
      })
      .catch((err) => {
        console.error("[stripe-service] api_call_log insert failed:", err);
      });
  });

  next();
}
