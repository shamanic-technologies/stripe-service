import { getDecryptedStripeKey, DecryptKeyResponse } from "./key-client";

interface CallerContext {
  method: string;
  path: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
}

/**
 * Resolves the Stripe secret key for a request via key-service.
 * Uses orgId + userId to resolve the key.
 */
export async function resolveStripeKey(
  orgId: string,
  userId: string,
  caller: CallerContext
): Promise<DecryptKeyResponse> {
  return getDecryptedStripeKey(orgId, userId, caller);
}
