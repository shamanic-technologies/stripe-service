import { getDecryptedStripeKey, DecryptKeyResponse } from "./key-client";

interface CallerContext {
  method: string;
  path: string;
}

/**
 * Resolves the Stripe secret key for a request via key-service.
 * Uses orgId + userId to resolve the key. Returns key and keySource.
 */
export async function resolveStripeKey(
  orgId: string,
  userId: string,
  caller: CallerContext
): Promise<DecryptKeyResponse> {
  return getDecryptedStripeKey(orgId, userId, caller);
}
