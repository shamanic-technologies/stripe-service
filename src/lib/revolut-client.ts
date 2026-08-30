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

/** A Revolut customer. Payment methods are saved against one of these. */
export interface RevolutCustomer {
  id: string;
  email?: string;
  full_name?: string;
  [key: string]: unknown;
}

/** A payment method saved against a customer, chargeable off-session. */
export interface RevolutPaymentMethod {
  id: string;
  type?: string;
  /** Revolut invalidates merchant-initiated use once a method is updated. */
  saved_for?: string;
  method_details?: Record<string, unknown>;
  [key: string]: unknown;
}

export function createCustomer(body: {
  email?: string;
  full_name?: string;
}): Promise<RevolutCustomer> {
  return request<RevolutCustomer>("POST", "/customers", body);
}

/**
 * The customer's saved payment methods. This is the Revolut answer to "does
 * this org have a chargeable card", and it is a LIVE read for the same reason
 * the Stripe one is: a method can be removed or invalidated without an event we
 * would see, so a local cache would drift.
 */
export async function listCustomerPaymentMethods(
  customerId: string
): Promise<RevolutPaymentMethod[]> {
  const res = await request<{ payment_methods?: RevolutPaymentMethod[] }>(
    "GET",
    `/customers/${encodeURIComponent(customerId)}/payment-methods`
  );
  return res.payment_methods ?? [];
}

/**
 * Create an order. An order is an INTENT — it moves no money until it is paid,
 * which is what makes a save-card flow free.
 *
 * ⚠️ Revolut SILENTLY IGNORES unknown fields on this endpoint: sending a
 * misspelled parameter returns 201 with the parameter dropped, and the order
 * comes back without echoing it. Verified against production. So a typo here
 * does not fail, it just does not do the thing — never assume a field took
 * effect because the call succeeded; check the effect instead.
 */
export function createOrder(body: {
  amount: number;
  currency: string;
  description?: string;
  customer_id?: string;
  /**
   * `manual` authorises without capturing, so the order can be cancelled and
   * the hold released. Unlike most fields here it is VALIDATED and echoed back,
   * which is how you can tell it takes effect.
   */
  capture_mode?: "automatic" | "manual";
  metadata?: Record<string, string>;
}): Promise<RevolutOrder> {
  return request<RevolutOrder>("POST", "/orders", body);
}

/**
 * Charge an order against a card the customer already saved — the
 * merchant-initiated transaction, with nobody on the checkout page.
 *
 * Shape established against the live API, not documentation: the endpoint
 * requires `saved_payment_method` with BOTH `type` and a UUID `id`, and answers
 * `400 Either 'payment_method' or 'saved_payment_method' must be set` when
 * neither is given.
 */
export function payOrderWithSavedMethod(
  orderId: string,
  savedPaymentMethodId: string,
  type = "card"
): Promise<RevolutOrder> {
  return request<RevolutOrder>(
    "POST",
    `/orders/${encodeURIComponent(orderId)}/payments`,
    { saved_payment_method: { type, id: savedPaymentMethodId } }
  );
}

/** Cancel an unpaid order. */
export function cancelOrder(orderId: string): Promise<RevolutOrder> {
  return request<RevolutOrder>(
    "POST",
    `/orders/${encodeURIComponent(orderId)}/cancel`
  );
}
