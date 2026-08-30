import crypto from "crypto";
import { Router, Request, Response } from "express";
import { resolvePlatformKey } from "../lib/key-client";
import { mirrorOrderById } from "../lib/revolut-processor";

const router = Router();

/**
 * Revolut webhook receiver.
 *
 * **The body is a TRIGGER, never the record.** Revolut tells us which order
 * changed; we then GET that order and mirror what Revolut authoritatively says.
 * Two things fall out of that, both deliberate: the mirror never depends on the
 * shape of a webhook payload (the one Revolut shape we have still not observed
 * on a real delivery), and a replayed or reordered delivery cannot write a
 * stale state, because the fetch always returns the current one.
 *
 * Signature: HMAC-SHA256 over `v1.{timestamp}.{raw body}` keyed with the
 * signing secret Revolut returns when the webhook is registered, presented as
 * `v1=<hex>` in `Revolut-Signature`. The secret lives in key-service as the
 * platform provider `revolut-webhook`, mirroring `stripe-webhook`.
 *
 * An invalid signature is rejected. That is not negotiable — accepting an
 * unsigned body would let anyone move money-shaped rows into the mirror. But it
 * carries a real operational risk worth naming: Revolut disables an endpoint
 * that keeps failing, and a 4xx counts toward that exactly like a 5xx. So the
 * rejection is LOUD in the logs, and registering this endpoint must be followed
 * immediately by confirming a real delivery verifies — not left to discover
 * itself days later as silence.
 */

const TOLERANCE_SECONDS = 60 * 5;

let cachedSecret: string | null = null;
async function signingSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const { key } = await resolvePlatformKey("revolut-webhook", {
    method: "POST",
    path: "/v1/revolut/webhooks",
  });
  cachedSecret = key;
  return key;
}

/** Reset the memoised signing secret. Tests only. */
export function resetRevolutWebhookSecretCache(): void {
  cachedSecret = null;
}

/**
 * Constant-time comparison of the presented signature against ours.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — and that comparison is safe to do in variable time because the length
 * of a hex digest is not a secret.
 */
export function verifyRevolutSignature(params: {
  rawBody: string;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  secret: string;
  nowSeconds?: number;
}): boolean {
  const { rawBody, timestamp, signatureHeader, secret } = params;
  if (!timestamp || !signatureHeader) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Revolut sends milliseconds; accept either rather than guess wrong.
  const tsSeconds = ts > 1e11 ? Math.floor(ts / 1000) : ts;
  if (Math.abs(now - tsSeconds) > TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`v1.${timestamp}.${rawBody}`)
    .digest("hex");

  // The header may carry several comma-separated versions; any match wins.
  for (const part of signatureHeader.split(",")) {
    const presented = part.trim().replace(/^v1=/, "");
    const a = Buffer.from(presented, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** The order id a Revolut delivery refers to, whatever it chose to call it. */
export function orderIdFromWebhook(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const key of ["order_id", "orderId", "id"]) {
    const value = b[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

router.post("/v1/revolut/webhooks", async (req: Request, res: Response) => {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : JSON.stringify(req.body ?? {});

  let secret: string;
  try {
    secret = await signingSecret();
  } catch (err) {
    console.error("[stripe-service] Revolut webhook secret unavailable:", err);
    return res.status(500).json({ error: "Webhook secret unavailable" });
  }

  const ok = verifyRevolutSignature({
    rawBody,
    timestamp: req.headers["revolut-request-timestamp"] as string | undefined,
    signatureHeader: req.headers["revolut-signature"] as string | undefined,
    secret,
  });
  if (!ok) {
    console.error(
      "[stripe-service] Revolut webhook REJECTED: signature did not verify. " +
        "If this repeats, Revolut will disable the endpoint — check the signing secret."
    );
    return res.status(401).json({ error: "Invalid signature" });
  }

  let parsed: unknown;
  try {
    parsed = Buffer.isBuffer(req.body) ? JSON.parse(rawBody) : req.body;
  } catch {
    console.error("[stripe-service] Revolut webhook body was not JSON:", rawBody.slice(0, 200));
    // Signed by Revolut but unparseable: acknowledge so the endpoint is not
    // disabled over a shape we cannot act on, and shout about it.
    return res.json({ received: true, ignored: "unparseable body" });
  }

  const orderId = orderIdFromWebhook(parsed);
  if (!orderId) {
    console.error(
      "[stripe-service] Revolut webhook carried no order id, ignoring:",
      JSON.stringify(parsed).slice(0, 300)
    );
    return res.json({ received: true, ignored: "no order id" });
  }

  try {
    await mirrorOrderById(orderId, "webhook");
  } catch (err) {
    // Fail loud: Revolut retries a 5xx, and the 5-minute poller is the backstop
    // if the retries also fail. Swallowing here would lose the change silently.
    console.error(`[stripe-service] Revolut mirror failed for order ${orderId}:`, err);
    return res.status(500).json({ error: "Mirror failed" });
  }

  return res.json({ received: true });
});

export default router;
