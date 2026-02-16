import { getDecryptedStripeKey } from "./key-client";

/**
 * Resolves the Stripe secret key for a request.
 * If appId is provided, fetches the key from key-service.
 * Otherwise returns undefined (stripe-client will use STRIPE_SECRET_KEY env var).
 */
export async function resolveStripeKey(
  appId?: string
): Promise<string | undefined> {
  if (!appId) return undefined;
  return getDecryptedStripeKey(appId);
}
