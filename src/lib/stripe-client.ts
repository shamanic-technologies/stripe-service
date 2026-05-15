import Stripe from "stripe";

/**
 * Construct a Stripe client for a given org's secret key.
 * Per-request instances — multi-tenant, no global state.
 */
export function makeStripeClient(stripeSecretKey: string): Stripe {
  return new Stripe(stripeSecretKey, {
    apiVersion: "2025-09-30.clover" as Stripe.LatestApiVersion,
    maxNetworkRetries: 3,
  });
}

/**
 * Webhook signature verification needs a Stripe instance, but no API calls
 * are made. Use a placeholder key — verification uses the webhook secret only.
 */
let webhookClient: Stripe | null = null;
export function getWebhookClient(): Stripe {
  if (!webhookClient) {
    webhookClient = new Stripe("webhook-verification-only", {
      apiVersion: "2025-09-30.clover" as Stripe.LatestApiVersion,
    });
  }
  return webhookClient;
}

export function constructWebhookEvent(
  payload: string | Buffer,
  signature: string,
  secret: string
): Stripe.Event {
  return getWebhookClient().webhooks.constructEvent(payload, signature, secret);
}

export function isStripeError(err: unknown): err is Stripe.errors.StripeError {
  return err instanceof Stripe.errors.StripeError;
}

export function stripeErrorStatus(err: Stripe.errors.StripeError): number {
  return err.statusCode ?? 500;
}

export function isResourceMissing(err: unknown): boolean {
  return (
    err instanceof Stripe.errors.StripeError && err.statusCode === 404
  );
}
