/**
 * HTTP client for billing-service.
 *
 * One call, one purpose: tell billing the moment an organisation is left with
 * no chargeable payment method. billing-service owns what that means — it
 * no-ops when the org owes nothing, and stops spend + mails the customer when
 * it does. This service decides nothing about the consequence; it reports the
 * fact it is the only one that can observe (the card is removed inside Stripe's
 * own portal, so no write path of ours sees it).
 *
 * The endpoint shape is LOCKED by billing-service (deployed, it owns it):
 *   POST {BILLING_SERVICE_URL}/internal/payment-methods/lost
 *   x-api-key: $BILLING_SERVICE_API_KEY
 *   {"orgId": "<internal org uuid>"}
 *
 * Bounded by an AbortSignal so a slow or unreachable billing-service can never
 * hold a Stripe webhook open.
 */

const REQUEST_TIMEOUT_MS = 8_000;

function billingServiceUrl(): string {
  return process.env.BILLING_SERVICE_URL || "";
}

function billingServiceApiKey(): string {
  return process.env.BILLING_SERVICE_API_KEY || "";
}

/**
 * Throws on any failure — the caller is responsible for swallowing it, because
 * the caller is the one that knows a Stripe webhook is on the other end.
 */
export async function reportPaymentMethodLost(orgId: string): Promise<void> {
  const url = billingServiceUrl();
  const apiKey = billingServiceApiKey();
  if (!url || !apiKey) {
    throw new Error(
      "billing-service is not configured: BILLING_SERVICE_URL and BILLING_SERVICE_API_KEY must both be set"
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${url}/internal/payment-methods/lost`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ orgId }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `billing-service POST /internal/payment-methods/lost failed: ${response.status} - ${body}`
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
