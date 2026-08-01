import crypto from "crypto";

/**
 * HTTP client for transactional-email-service.
 *
 * stripe-service sends exactly one kind of mail: a STAFF notification that an
 * organisation lost a payment method. There is no customer-facing mail here and
 * no acting end user — the customer removes the card inside Stripe's own billing
 * portal, so nobody of ours is on the request. The send therefore carries
 * `x-org-id` and `x-run-id` and deliberately NO `x-user-id`; the receiving
 * service routes `payment_method_removed` to the internal staff recipient list.
 *
 * Both calls are bounded by an AbortSignal so a slow or unreachable email
 * service can never hold a Stripe webhook open.
 */

/**
 * The event key. Frozen across this service and transactional-email-service:
 * the template is resolved by `name == eventType`, and the staff-routing table
 * keys on the same string. A drift here silently mails the customer instead of
 * staff.
 */
export const PAYMENT_METHOD_REMOVED_EVENT_TYPE = "payment_method_removed";

const REQUEST_TIMEOUT_MS = 8_000;

export interface EmailTemplate {
  name: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}

const CELL = "padding:6px 10px;border:1px solid #e5e5e5";
const LABEL_CELL = `${CELL};background:#fafafa;color:#555;white-space:nowrap`;

function row(label: string, value: string): string {
  return `<tr><td style="${LABEL_CELL}">${label}</td><td style="${CELL}">${value}</td></tr>`;
}

const PAYMENT_METHOD_REMOVED_TEMPLATE: EmailTemplate = {
  name: PAYMENT_METHOD_REMOVED_EVENT_TYPE,
  subject: "{{orgLabel}} removed a payment method, {{cardsRemainingLabel}}",
  htmlBody: [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111">`,
    `<p><strong>{{orgLabel}}</strong> removed a payment method in Stripe.</p>`,
    `<p>{{impact}}</p>`,
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0">`,
    row("Organisation", "{{orgId}}"),
    row("Stripe customer", "{{customerLabel}} ({{customerId}})"),
    row("Removed", "{{paymentMethodLabel}}"),
    row("Payment method id", "{{paymentMethodId}}"),
    row("Chargeable cards left", "{{cardsRemaining}}"),
    row("Removed at", "{{removedAt}}"),
    `</table>`,
    `<p style="color:#777;font-size:13px">Stripe event {{eventId}}</p>`,
    `</div>`,
  ].join(""),
  textBody: [
    "{{orgLabel}} removed a payment method in Stripe.",
    "",
    "{{impact}}",
    "",
    "Organisation: {{orgId}}",
    "Stripe customer: {{customerLabel}} ({{customerId}})",
    "Removed: {{paymentMethodLabel}}",
    "Payment method id: {{paymentMethodId}}",
    "Chargeable cards left: {{cardsRemaining}}",
    "Removed at: {{removedAt}}",
    "",
    "Stripe event {{eventId}}",
  ].join("\n"),
};

interface EmailServiceConfig {
  url: string;
  apiKey: string;
}

/**
 * Read at call time, not module load, so a test (or a late-injected Railway
 * variable) is seen. Returns null when the service is not configured — the
 * caller logs and moves on rather than throwing at boot.
 */
function readConfig(): EmailServiceConfig | null {
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ""), apiKey };
}

export interface SendStaffEmailInput {
  eventType: string;
  orgId: string;
  metadata: Record<string, string>;
}

/**
 * Send one staff notification. Throws on any non-2xx or transport failure —
 * the fire-and-forget boundary lives in the caller (see
 * `notify-payment-method-removed.ts`), not here, so a failure is never
 * invisible at this layer.
 */
export async function sendStaffEmail(input: SendStaffEmailInput): Promise<void> {
  const config = readConfig();
  if (!config) {
    throw new Error(
      "transactional-email-service is not configured (TRANSACTIONAL_EMAIL_SERVICE_URL / TRANSACTIONAL_EMAIL_SERVICE_API_KEY)"
    );
  }

  // `/platform-send`, NOT `/send`. The customer-facing `/send` is guarded by
  // `requireIdentityHeaders` and 400s when `x-user-id` is absent, and we have no
  // end user to give it: the customer removed the card inside Stripe's own
  // billing portal. Never invent a sentinel user id to satisfy that guard
  // (stripe-service#77) — `/platform-send` is the user-less path that exists for
  // exactly this case. Because the send is fire-and-forget, targeting the wrong
  // one fails SILENTLY: no mail, no alert, and the feature reads as shipped.
  const response = await fetch(`${config.url}/platform-send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "x-org-id": input.orgId,
      "x-run-id": crypto.randomUUID(),
    },
    body: JSON.stringify({
      eventType: input.eventType,
      metadata: input.metadata,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `transactional-email-service POST /platform-send failed: ${response.status} - ${errorText}`
    );
  }
}

/**
 * Register every template this service can send, at boot.
 *
 * Upsert-by-name on the receiving side, so this is idempotent and safe on every
 * cold start. It never throws and it is never awaited before `app.listen()`:
 * transactional-email-service sits on a Neon compute that can be suspended, and
 * a registration failure must not block port-bind or crash the process. A
 * failure logs loudly and the templates land on the next restart.
 */
export async function deployEmailTemplates(): Promise<void> {
  const config = readConfig();
  if (!config) {
    console.error(
      "[stripe-service] transactional-email-service not configured — payment_method_removed template NOT registered and staff notifications will not send. Set TRANSACTIONAL_EMAIL_SERVICE_URL + TRANSACTIONAL_EMAIL_SERVICE_API_KEY."
    );
    return;
  }

  try {
    // `/platform-templates`, NOT `/templates` — same reason as the send above:
    // `/templates` requires a full identity and boot has none of it (no org, no
    // acting user, no run). `/platform-templates` is `x-api-key`-only, so this
    // call carries no identity at all rather than a fabricated one.
    const response = await fetch(`${config.url}/platform-templates`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify({ templates: [PAYMENT_METHOD_REMOVED_TEMPLATE] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(
        `[stripe-service] Email template registration failed: ${response.status} - ${errorText}`
      );
      return;
    }

    console.log(
      `[stripe-service] Registered email template '${PAYMENT_METHOD_REMOVED_TEMPLATE.name}' with transactional-email-service`
    );
  } catch (err) {
    console.error("[stripe-service] Email template registration failed:", err);
  }
}

// Exported for tests: asserts the template we ship is the one the send resolves.
export const EMAIL_TEMPLATES: ReadonlyArray<EmailTemplate> = [
  PAYMENT_METHOD_REMOVED_TEMPLATE,
];
