import { resolvePlatformKey } from "./key-client";

/**
 * Thin HTTP client for the Revolut Merchant API.
 *
 * The secret key lives in key-service as the platform provider `revolut` — the
 * same single-account model as the Stripe platform key, and for the same
 * reason: there is one merchant account, so there is no per-org key to resolve
 * and no end user to resolve it against.
 *
 * `Revolut-Api-Version` is pinned. The API is versioned by date and older
 * versions disappear (`2023-09-01` already 404s), so leaving it unset would let
 * the shape of every response drift underneath the projector without a deploy.
 */
const BASE_URL = "https://merchant.revolut.com/api";
const API_VERSION = "2024-09-01";

let cachedKey: string | null = null;

async function apiKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const { key } = await resolvePlatformKey("revolut", {
    method: "INTERNAL",
    path: "/lib/revolut-client",
  });
  cachedKey = key;
  return key;
}

/** Reset the memoised key. Tests only. */
export function resetRevolutKeyCache(): void {
  cachedKey = null;
}

export class RevolutApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string
  ) {
    super(message);
    this.name = "RevolutApiError";
  }
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const key = await apiKey();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Revolut-Api-Version": API_VERSION,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RevolutApiError(
      res.status,
      text,
      `Revolut ${method} ${path} failed: ${res.status} ${text}`
    );
  }
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * A Revolut order. Both a payment and a refund are orders — `type` is the
 * discriminator, and it is the ONLY safe one: ids are bare UUIDs with no
 * prefix, and there is no `object` field to read.
 *
 * Typed loosely on purpose. Only the fields the projector actually reads are
 * named; everything else rides along in the verbatim payload we store, so a
 * field we have not seen yet is preserved rather than dropped.
 */
export interface RevolutOrder {
  id: string;
  type?: string;
  state?: string;
  amount?: number;
  currency?: string;
  outstanding_amount?: number;
  refunded_amount?: number;
  description?: string | null;
  metadata?: Record<string, string> | null;
  related_order_id?: string | null;
  created_at?: string;
  updated_at?: string;
  payments?: Array<{
    id?: string;
    state?: string;
    amount?: number;
    settled_amount?: number;
    settled_currency?: string;
    fees?: Array<{ type?: string; amount?: number; currency?: string }>;
    payment_method?: { type?: string; fingerprint?: string };
    payer?: { email?: string; phone?: string };
  }>;
  [key: string]: unknown;
}

export interface RevolutOrderList {
  orders?: RevolutOrder[];
}

/** Retrieve one order (payment OR refund) by id. */
export function getOrder(orderId: string): Promise<RevolutOrder> {
  return request<RevolutOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);
}

/**
 * List orders, newest first. Revolut returns `{ orders: [...] }` and pages with
 * `created_before`, so the caller walks backwards in time by feeding the oldest
 * `created_at` it received back in.
 */
export function listOrders(params: {
  limit?: number;
  createdBefore?: string;
}): Promise<RevolutOrderList> {
  const q = new URLSearchParams();
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  if (params.createdBefore) q.set("created_before", params.createdBefore);
  const qs = q.toString();
  return request<RevolutOrderList>("GET", `/orders${qs ? `?${qs}` : ""}`);
}

/** List disputes. Captured into bronze only — see the schema comment. */
export function listDisputes(): Promise<unknown[]> {
  return request<unknown[]>("GET", "/disputes");
}
