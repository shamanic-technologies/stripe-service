import { Request, Response, NextFunction } from "express";

/**
 * Middleware to require x-org-id, x-user-id, and x-run-id headers on all
 * endpoints except health, root, OpenAPI spec, and webhooks.
 */
export function requireIdentityHeaders(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health" || req.path === "/" || req.path === "/openapi.json") {
    return next();
  }

  if (req.path.startsWith("/webhooks/stripe")) {
    return next();
  }

  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];
  const runId = req.headers["x-run-id"];

  if (!orgId || typeof orgId !== "string") {
    return res.status(400).json({ error: "Missing required header: x-org-id" });
  }

  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "Missing required header: x-user-id" });
  }

  if (!runId || typeof runId !== "string") {
    return res.status(400).json({ error: "Missing required header: x-run-id" });
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;
  res.locals.runId = runId;

  next();
}
