import { getDecryptedStripeKey } from "./key-client";

interface CallerContext {
  method: string;
  path: string;
}

/**
 * Resolves the Stripe secret key for a request via key-service.
 * Always requires an appId — this service serves multiple apps by design.
 */
export async function resolveStripeKey(appId: string, caller: CallerContext): Promise<string> {
  return getDecryptedStripeKey(appId, caller);
}
