import { Router, Request, Response } from "express";
import type Stripe from "stripe";
import { constructWebhookEvent } from "../lib/stripe-client";
import { resolvePlatformKey } from "../lib/key-client";
import { processEvent } from "../lib/event-processor";

const router = Router();

// Module-level cache: the webhook signing secret is static per environment.
// Lazy-fetched on first webhook hit; never refreshed once set.
let cachedWebhookSecret: string | null = null;

async function getWebhookSecret(): Promise<string> {
  if (cachedWebhookSecret) return cachedWebhookSecret;
  const { key } = await resolvePlatformKey("stripe-webhook", {
    method: "POST",
    path: "/v1/webhooks",
  });
  cachedWebhookSecret = key;
  return key;
}

router.post("/v1/webhooks", async (req: Request, res: Response) => {
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") {
    return res.status(400).json({ error: "Missing stripe-signature header" });
  }

  let webhookSecret: string;
  try {
    webhookSecret = await getWebhookSecret();
  } catch (err) {
    console.error("[stripe-service] Failed to resolve stripe-webhook secret from key-service:", err);
    return res.status(500).json({ error: "Webhook secret unavailable" });
  }

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(req.body, signature, webhookSecret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error("[stripe-service] Webhook signature verification failed:", msg);
    return res.status(400).json({ error: "Invalid signature" });
  }

  try {
    const processed = await processEvent(event, "webhook");
    if (!processed) {
      console.log(`[stripe-service] Webhook event ${event.id} (${event.type}) already processed`);
    }
    return res.json({ received: true });
  } catch (err) {
    // Throw 5xx so Stripe retries — webhook delivery is idempotent.
    console.error(`[stripe-service] Webhook processing failed for ${event.type}:`, err);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
