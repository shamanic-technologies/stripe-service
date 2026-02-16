/**
 * HTTP client for key-service
 * Resolves decrypted Stripe API keys for apps
 */

const KEY_SERVICE_URL =
  process.env.KEY_SERVICE_URL || "https://key.mcpfactory.org";
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "";

interface DecryptAppKeyResponse {
  provider: string;
  key: string;
}

/**
 * Fetches the decrypted Stripe secret key for a given appId from key-service.
 * Calls GET /internal/app-keys/stripe/decrypt?appId=xxx
 */
export async function getDecryptedStripeKey(appId: string): Promise<string> {
  const url = `${KEY_SERVICE_URL}/internal/app-keys/stripe/decrypt?appId=${encodeURIComponent(appId)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": KEY_SERVICE_API_KEY,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `key-service GET /internal/app-keys/stripe/decrypt failed: ${response.status} - ${errorText}`
    );
  }

  const data = (await response.json()) as DecryptAppKeyResponse;
  return data.key;
}
