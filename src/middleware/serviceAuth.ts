import { Request, Response, NextFunction } from "express";

const PUBLIC_PATHS = new Set(["/", "/health", "/openapi.json"]);

export function serviceAuth(req: Request, res: Response, next: NextFunction) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/v1/webhooks")) return next();
  if (req.path.startsWith("/public/")) return next();

  const apiKey = req.headers["x-api-key"];
  const validSecret = process.env.STRIPE_SERVICE_API_KEY;

  if (!validSecret) {
    console.error("[stripe-service] STRIPE_SERVICE_API_KEY not configured");
    return res.status(500).json({ error: "Server configuration error" });
  }

  if (!apiKey) {
    return res.status(401).json({ error: "Missing X-API-Key header" });
  }

  if (apiKey !== validSecret) {
    return res.status(403).json({ error: "Invalid API key" });
  }

  next();
}
