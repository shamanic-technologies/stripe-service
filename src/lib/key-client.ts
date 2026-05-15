/**
 * HTTP client for key-service. Resolves decrypted Stripe API keys per org.
 */

const KEY_SERVICE_URL =
  process.env.KEY_SERVICE_URL || "https://key.mcpfactory.org";
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "";

export interface DecryptKeyResponse {
  key: string;
  keySource: "platform" | "org";
}

interface CallerContext {
  method: string;
  path: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
}

export async function getDecryptedStripeKey(
  orgId: string,
  userId: string,
  caller: CallerContext
): Promise<DecryptKeyResponse> {
  const url = `${KEY_SERVICE_URL}/keys/stripe/decrypt?orgId=${encodeURIComponent(orgId)}&userId=${encodeURIComponent(userId)}`;

  const headers: Record<string, string> = {
    "x-api-key": KEY_SERVICE_API_KEY,
    "x-org-id": orgId,
    "x-user-id": userId,
    "x-caller-service": "stripe",
    "x-caller-method": caller.method,
    "x-caller-path": caller.path,
  };
  if (caller.campaignId) headers["x-campaign-id"] = caller.campaignId;
  if (caller.brandId) headers["x-brand-id"] = caller.brandId;
  if (caller.workflowSlug) headers["x-workflow-slug"] = caller.workflowSlug;

  const response = await fetch(url, { method: "GET", headers });

  if (response.status === 404) {
    throw new Error(`No Stripe key configured for org '${orgId}'`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `key-service GET /keys/stripe/decrypt failed: ${response.status} - ${errorText}`
    );
  }

  return (await response.json()) as DecryptKeyResponse;
}
