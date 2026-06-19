/**
 * HTTP client for client-service. Resolves an end-user's identity (email, name)
 * from the internal user UUID carried on `x-user-id`.
 *
 * Used by `POST /v1/customers` to stamp the authenticated user's email + name on
 * the Stripe customer it creates — stripe-service has no email of its own, the
 * same way it has no Stripe key of its own (resolved from key-service). This
 * keeps the email-attachment transparent to every caller (billing-service today,
 * future subscription-service) instead of each caller having to remember to pass
 * an email in the create body.
 *
 * Fail-loud: an infra failure (network / 5xx) propagates so the customer create
 * returns 5xx and the caller retries (safe — the create is idempotent per org).
 * A 404 (no such user on record) is NOT a failure: it means there is genuinely
 * no email to attach, so it resolves to `null` and the customer is created
 * without an email rather than blocking the org's billing setup.
 */

const CLIENT_SERVICE_URL =
  process.env.CLIENT_SERVICE_URL || "https://client.mcpfactory.org";
const CLIENT_SERVICE_API_KEY = process.env.CLIENT_SERVICE_API_KEY || "";

export interface UserIdentity {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

interface GetUserResponse {
  user: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  };
}

/**
 * Resolve a user's identity by internal UUID via client-service
 * `GET /internal/users/:userId`. Returns `null` when the user is not on record
 * (404). Throws on any other non-2xx (fail loud).
 */
export async function getUserById(userId: string): Promise<UserIdentity | null> {
  const url = `${CLIENT_SERVICE_URL}/internal/users/${encodeURIComponent(userId)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": CLIENT_SERVICE_API_KEY },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `client-service GET /internal/users/${userId} failed: ${response.status} - ${errorText}`
    );
  }

  const body = (await response.json()) as GetUserResponse;
  return {
    email: body.user.email ?? null,
    firstName: body.user.firstName ?? null,
    lastName: body.user.lastName ?? null,
  };
}

/** Join first + last into a single Stripe `name`, or null when neither present. */
export function joinName(identity: UserIdentity): string | null {
  const name = [identity.firstName, identity.lastName]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ");
  return name.length > 0 ? name : null;
}
