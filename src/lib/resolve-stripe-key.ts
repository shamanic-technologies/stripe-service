import { getDecryptedStripeKey } from "./key-client";

/**
 * Resolves the Stripe secret key for a request.
 * - If appId is provided → fetches from key-service
 * - If no appId → uses STRIPE_SECRET_KEY env var
 * Always returns a key string or throws a descriptive error.
 */
export async function resolveStripeKey(
  appId?: string
): Promise<string> {
  if (appId) {
    return getDecryptedStripeKey(appId);
  }

  const envKey = process.env.STRIPE_SECRET_KEY;
  if (!envKey) {
    throw new Error(
      "No Stripe key available: provide appId or configure STRIPE_SECRET_KEY"
    );
  }
  return envKey;
}
