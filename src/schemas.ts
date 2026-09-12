import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- Security scheme ---
registry.registerComponent("securitySchemes", "apiKey", {
  type: "apiKey",
  in: "header",
  name: "X-API-Key",
  description: "Service-to-service API key",
});

// ===== Identity / workflow headers =====

export const IdentityHeadersSchema = z.object({
  "x-org-id": z.string().openapi({ description: "Internal org UUID (required)" }),
  "x-user-id": z.string().openapi({ description: "Internal user UUID (required)" }),
  "x-brand-id": z.string().optional().openapi({ description: "Brand ID (optional, logged)" }),
  "x-campaign-id": z.string().optional().openapi({ description: "Campaign ID (optional, logged)" }),
  "x-workflow-slug": z.string().optional().openapi({ description: "Workflow slug (optional, logged)" }),
  "idempotency-key": z.string().optional().openapi({ description: "Forwarded to Stripe verbatim" }),
});

// ===== Shared response shapes =====

export const ErrorResponseSchema = z
  .object({
    error: z.string().openapi({ description: "Error message" }),
    details: z.any().optional(),
  })
  .openapi("ErrorResponse");

export const StripeObjectSchema = z.record(z.string(), z.any()).openapi("StripeObject");
export const StripeListSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(StripeObjectSchema),
    has_more: z.boolean(),
    url: z.string(),
  })
  .openapi("StripeList");

// ===== Org payment summary (money in vs money given back) =====

export const CurrencyTotalsSchema = z
  .object({
    currency: z.string().openapi({ description: "Stripe currency code, e.g. 'usd'." }),
    amount_received: z.number().int().openapi({
      description:
        "Gross paid in, minor units: SUM(amount_received) over the org's `succeeded` PaymentIntents.",
    }),
    amount_refunded: z.number().int().openapi({
      description:
        "Minor units returned via Refunds in status `succeeded`. A refund that later fails or is canceled stops counting.",
    }),
    amount_disputed_lost: z.number().int().openapi({
      description:
        "Minor units lost to Disputes in status `lost`. Open and won disputes are not counted.",
    }),
    amount_returned: z.number().int().openapi({
      description: "amount_refunded + amount_disputed_lost — total money given back.",
    }),
    amount_net: z.number().int().openapi({
      description: "amount_received − amount_returned — money we actually still hold.",
    }),
  })
  .openapi("CurrencyTotals");

export const OrgPaymentSummarySchema = z
  .object({
    object: z.literal("payment_summary"),
    org_id: z.string(),
    customer: z.string().nullable().openapi({
      description:
        "The org's mirrored Stripe customer id, or null when it has none. Identity, not a money figure — never bounded by as_of.",
    }),
    as_of: z.number().int().nullable().openapi({
      description:
        "Echo of the requested as_of bound (Unix seconds), or null for an unbounded read. Echoed so a caller can tell a deploy that APPLIED the bound from one that predates it — otherwise the two responses are identical and the older one silently over-counts.",
    }),
    totals: z.array(CurrencyTotalsSchema).openapi({
      description:
        "One entry per currency with activity. Empty when the org has no mirrored payments — never a fabricated zero row.",
    }),
  })
  .openapi("OrgPaymentSummary");

// ===== Customers =====

export const CreateCustomerRequestSchema = z
  .object({
    email: z.string().email().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    phone: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    address: z.record(z.string(), z.any()).optional(),
    shipping: z.record(z.string(), z.any()).optional(),
    payment_method: z.string().optional(),
    invoice_settings: z.record(z.string(), z.any()).optional(),
  })
  .passthrough()
  .openapi("CreateCustomerRequest");

export const CardSetupRequestSchema = z
  .object({
    return_url: z.string().url().openapi({
      description:
        "Where a hosted flow returns the customer to. Ignored by an acquirer whose flow is embedded rather than hosted.",
    }),
    currency: z.string().min(3).optional().openapi({
      description:
        "Currency for the verification authorisation an acquirer may need to place. Never captured.",
    }),
  })
  .openapi("CardSetupRequest");

export const AcquirerRolloutRequestSchema = z
  .object({
    acquirer: z.enum(["stripe", "revolut"]).openapi({
      description:
        "Which acquirer NEW orgs are sent to. Naming the default is the same as switching the rollout off.",
    }),
    percent: z.number().int().min(0).max(100).openapi({
      description:
        "Share of eligible new orgs routed there. 0 sends everybody back to the default immediately; orgs already pinned are never moved.",
    }),
  })
  .openapi("AcquirerRolloutRequest");

export const PinAcquirerRequestSchema = z
  .object({
    acquirer: z.enum(["stripe", "revolut"]),
    customer_id: z.string().optional().openapi({
      description:
        "The acquirer's own customer id. Created automatically for Revolut when omitted.",
    }),
    email: z.string().email().optional(),
    full_name: z.string().optional(),
  })
  .openapi("PinAcquirerRequest");

export const ChargeByOrgRequestSchema = z
  .object({
    amount: z.number().int().positive().openapi({
      description: "Minor units, e.g. 50000 for $500.00.",
    }),
    currency: z.string().min(3),
    description: z.string().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .openapi("ChargeByOrgRequest");

export const ChargeResultSchema = z
  .object({
    object: z.literal("charge_result"),
    org_id: z.string(),
    acquirer: z.enum(["stripe", "revolut"]).openapi({
      description: "Which acquirer took the money. Diagnostic only — do not branch on it.",
    }),
    reference: z.string().openapi({
      description: "The acquirer's own id for this charge, for support and reconciliation.",
    }),
    status: z.enum(["succeeded", "failed"]).openapi({
      description: "`succeeded` only when the money actually moved.",
    }),
    amount: z.number().int(),
    currency: z.string(),
    hosted_document_url: z.string().nullable().openapi({
      description:
        "A hosted document for this charge when the acquirer produces one (Stripe finalizes an invoice with a PDF). Null means this acquirer has no such thing — never that the charge failed.",
    }),
  })
  .openapi("ChargeResult");

export const UpdateCustomerMetadataRequestSchema = z
  .object({
    metadata: z.record(z.string(), z.string()).openapi({
      description:
        "Forwarded verbatim to Stripe, so Stripe's semantics apply: keys are MERGED into the customer's existing metadata, and a key set to the empty string is deleted. Send the final shape you want, not a patch.",
    }),
  })
  .openapi("UpdateCustomerMetadataRequest");

export const UpdateCustomerRequestSchema = z
  .object({
    email: z.string().email().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    phone: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    address: z.record(z.string(), z.any()).optional(),
    shipping: z.record(z.string(), z.any()).optional(),
    invoice_settings: z.record(z.string(), z.any()).optional(),
  })
  .passthrough()
  .openapi("UpdateCustomerRequest");

export const ListCustomersQuerySchema = z
  .object({
    email: z.string().email().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    starting_after: z.string().optional(),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .openapi({
        description:
          "Filter by Stripe customer metadata. Use repeated query params: metadata[key]=value. AND'd across keys.",
      }),
  })
  .openapi("ListCustomersQuery");

// ===== Internal: off-session invoiced charge =====

export const CreateInvoiceByOrgRequestSchema = z
  .object({
    amount: z
      .number()
      .int()
      .positive()
      .openapi({ description: "Amount to charge, in the currency's smallest unit (e.g. cents)" }),
    currency: z
      .string()
      .min(3)
      .openapi({ description: "3-letter ISO currency code (e.g. 'usd')" }),
    description: z
      .string()
      .min(1)
      .openapi({ description: "Human-readable description — used for the invoice, its line item, AND the resulting PaymentIntent (which Stripe would otherwise label with its generic 'Payment for Invoice' fallback)." }),
    payment_method: z
      .string()
      .optional()
      .openapi({
        description:
          "Explicit PaymentMethod (pm_…) to charge off-session. Omit to use the customer's default PM. Prefer an explicit card PM — the customer default may be a Link / wallet PM that Stripe refuses to charge off_session.",
      }),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .openapi({
        description:
          "Caller provenance (e.g. {\"type\":\"auto_reload\"} / {\"reason\":\"month_end_sweep\"}). Stamped on the invoice AND on the resulting PaymentIntent, so a consumer summing payments can tell why the charge happened.",
      }),
  })
  .passthrough()
  .openapi("CreateInvoiceByOrgRequest");

// ===== Checkout sessions =====

const LineItemSchema = z
  .object({
    price: z.string().optional(),
    price_data: z.record(z.string(), z.any()).optional(),
    quantity: z.number().int().positive().optional(),
    adjustable_quantity: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

export const CreateCheckoutSessionRequestSchema = z
  .object({
    mode: z.enum(["payment", "subscription", "setup"]),
    // Required for "payment"/"subscription"; forbidden for "setup" (Stripe rejects
    // line_items in setup mode). Enforced by the cross-field refinement below.
    line_items: z.array(LineItemSchema).min(1).optional(),
    // Hosted (default) Checkout redirects the browser to a Stripe-hosted page and
    // requires success_url. Embedded Checkout renders in-page (iframe) and is created
    // WITHOUT success_url, returning a client_secret the front-end mounts. Stripe
    // rejects success_url alongside redirect_on_completion:"never", so success_url is
    // required only for the hosted case — enforced by the cross-field refinement below.
    ui_mode: z.enum(["hosted", "embedded"]).optional(),
    redirect_on_completion: z.enum(["always", "if_required", "never"]).optional(),
    success_url: z.string().url().optional(),
    cancel_url: z.string().url().optional(),
    customer: z.string().optional(),
    customer_email: z.string().email().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    payment_intent_data: z.record(z.string(), z.any()).optional(),
    payment_method_types: z.array(z.string()).optional(),
    subscription_data: z.record(z.string(), z.any()).optional(),
    discounts: z.array(z.record(z.string(), z.any())).optional(),
    expires_at: z.number().int().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (data.mode === "setup") {
      if (data.line_items !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["line_items"],
          message: "line_items is not allowed when mode is 'setup'",
        });
      }
    } else if (data.line_items === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["line_items"],
        message: "line_items is required when mode is 'payment' or 'subscription'",
      });
    }
    // success_url is required for hosted Checkout (the browser is redirected there
    // on completion). Embedded Checkout never redirects the parent page, so Stripe
    // forbids success_url and instead returns a client_secret.
    if (data.ui_mode !== "embedded" && data.success_url === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["success_url"],
        message: "success_url is required unless ui_mode is 'embedded'",
      });
    }
  })
  .openapi("CreateCheckoutSessionRequest");

export const ListCheckoutSessionsQuerySchema = z
  .object({
    customer: z.string().optional(),
    payment_intent: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    starting_after: z.string().optional(),
  })
  .openapi("ListCheckoutSessionsQuery");

// ===== Payment intents =====

export const CreatePaymentIntentRequestSchema = z
  .object({
    amount: z.number().int().positive(),
    currency: z.string().min(3),
    customer: z.string().optional(),
    payment_method: z.string().optional(),
    payment_method_types: z.array(z.string()).optional(),
    automatic_payment_methods: z.record(z.string(), z.any()).optional(),
    confirm: z.boolean().optional(),
    off_session: z.boolean().optional(),
    description: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    setup_future_usage: z.string().optional(),
    capture_method: z.string().optional(),
    receipt_email: z.string().email().optional(),
    statement_descriptor: z.string().optional(),
  })
  .passthrough()
  .openapi("CreatePaymentIntentRequest");

export const ListPaymentIntentsQuerySchema = z
  .object({
    customer: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    starting_after: z.string().optional(),
  })
  .openapi("ListPaymentIntentsQuery");

// ===== Payment methods =====

export const ListPaymentMethodsQuerySchema = z
  .object({
    customer: z.string().openapi({
      description:
        "Required. Customer ID (cus_…) whose payment methods to list. Must belong to the caller's org or the request 404s.",
    }),
    type: z.string().optional().openapi({
      description:
        "Optional Stripe payment method type filter (e.g. 'card'). Forwarded verbatim to Stripe.",
    }),
  })
  .openapi("ListPaymentMethodsQuery");

// ===== Public stats =====

const PublicStatsBucketSchema = z
  .object({
    period: z.string().openapi({ description: "ISO date (YYYY-MM-DD) at start of bucket" }),
    paid_cents: z.string().openapi({
      description:
        "GROSS charged in this period, minor units. Unchanged meaning — report this as revenue.",
    }),
    refunded_cents: z.string().openapi({
      description:
        "Refunds in status `succeeded` that HAPPENED in this period. A refund that later fails or is canceled stops counting.",
    }),
    disputed_lost_cents: z.string().openapi({
      description:
        "Disputes in status `lost` that HAPPENED in this period. Open and won disputes are not counted.",
    }),
    returned_cents: z.string().openapi({
      description: "refunded_cents + disputed_lost_cents — money given back in this period.",
    }),
    net_cents: z.string().openapi({
      description:
        "paid_cents − returned_cents — report this as credited. NEGATIVE when a period's refunds exceed its payments: a return is attributed to the period it happened in, never back-dated to the payment it reverses, so an already-reported bucket is never rewritten.",
    }),
    paying_accounts: z.number().int().nonnegative().openapi({
      description:
        "Distinct accounts with at least one SETTLED payment in this period, ACROSS EVERY ACQUIRER (a `succeeded` Stripe PaymentIntent or a `completed` Revolut `payment` order) — the same coverage and the same predicates as `paid_cents`, NOT the Stripe-only scope of `accounts_with_payment_method`. An account is the org, so an org that pays on both acquirers in the same period counts once. These are counts of DISTINCT accounts, so they do not sum to `total_paying_accounts` — an account that pays every month appears in every month.",
    }),
    first_time_paying_accounts: z.number().int().nonnegative().openapi({
      description:
        "Of `paying_accounts`, those with NO settled payment on ANY acquirer before this period — the numerator of a signup-to-paid conversion rate. Every account is first-time in exactly one period per grain, so summing this over all periods gives `total_paying_accounts`. A later refund never un-counts a payer: the payment happened, and the return lives in its own later period.",
    }),
  })
  .openapi("PublicStatsBucket");

export const PublicStatsBillingResponseSchema = z
  .object({
    total_paid_cents: z.string().openapi({
      description:
        "GROSS paid in across all orgs AND ALL ACQUIRERS, minor units: SUM(amount_received) over `succeeded` Stripe PaymentIntents plus every Revolut `payment` order at state `completed`. Unchanged meaning — report this as revenue. Currencies are summed together into one scalar (see the endpoint description).",
    }),
    total_refunded_cents: z.string().openapi({
      description:
        "Minor units returned across all orgs and all acquirers: Stripe Refunds in status `succeeded` plus Revolut `refund` orders in state `completed`, each attributed to a payment we mirrored. Revolut refunds count here rather than under disputes because that acquirer has no dispute mirror yet.",
    }),
    total_disputed_lost_cents: z.string().openapi({
      description:
        "Minor units lost to Stripe Disputes in status `lost`, across all orgs. Stripe-only: no Revolut dispute payload has ever been observed, so there is nothing to project or sum.",
    }),
    total_returned_cents: z.string().openapi({
      description: "total_refunded_cents + total_disputed_lost_cents — total money given back.",
    }),
    total_net_cents: z.string().openapi({
      description:
        "total_paid_cents − total_returned_cents — report this as credited. Same settled-only rule as the per-org read (GET /internal/payment_summary/by-org/{orgId}) and the same acquirer coverage, but NOT a figure you can equate to it row for row: this one merges every currency into a single scalar, and that read never merges currencies.",
    }),
    accounts_with_payment_method: z.number().int().nonnegative().openapi({
      description:
        "STRIPE-ONLY, deliberately: mirrored customers carrying a default Stripe payment method. Revolut mirrors no saved payment methods, and answering for it means one live acquirer call per org, which does not belong behind an unauthenticated public route. Read this as a Stripe-card count, not as a platform-wide 'can be charged' count.",
    }),
    total_paying_accounts: z.number().int().nonnegative().openapi({
      description:
        "Distinct accounts that have EVER paid, ACROSS EVERY ACQUIRER — `succeeded` Stripe PaymentIntents plus `completed` Revolut `payment` orders. This is who PAID, which is a different question from `accounts_with_payment_method` (who has a Stripe card saved) and a different acquirer scope: a customer who pays through a wallet, or on the second acquirer, has no Stripe card and is counted here. An account is the ORG this service maps payments to, so an org holding several acquirer customers is one account, and an org that pays on both acquirers is one account. A payment we cannot attribute to an org is excluded from this count while its money still counts in every `*_cents` figure. Equals the sum of `first_time_paying_accounts` over all buckets, on either grain.",
    }),
    monthly_growth: z.array(PublicStatsBucketSchema),
    weekly_growth: z.array(PublicStatsBucketSchema),
  })
  .openapi("PublicStatsBillingResponse");

// ===== Billing portal sessions =====

export const CreateBillingPortalSessionRequestSchema = z
  .object({
    customer: z.string(),
    return_url: z.string().url().optional(),
    configuration: z.string().optional(),
    flow_data: z.record(z.string(), z.any()).optional(),
  })
  .passthrough()
  .openapi("CreateBillingPortalSessionRequest");

// ===== Health =====

const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.string(),
  })
  .openapi("HealthResponse");

// ================================================================
// Path registrations
// ================================================================

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  tags: ["Health"],
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

const apiKeySec = [{ apiKey: [] }];

// --- Customers ---

registry.registerPath({
  method: "post",
  path: "/v1/customers",
  summary: "Create a Stripe customer",
  description:
    "Thin Stripe wrapper. Body forwarded to Stripe verbatim. Response is the Stripe Customer object.",
  tags: ["Customers"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    body: { content: { "application/json": { schema: CreateCustomerRequestSchema } } },
  },
  responses: {
    200: { description: "Customer created", content: { "application/json": { schema: StripeObjectSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/customers/{id}",
  summary: "Retrieve a Stripe customer",
  description: "Returns the cached row if present, falls back to Stripe and upserts otherwise.",
  tags: ["Customers"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Customer", content: { "application/json": { schema: StripeObjectSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/customers/{id}",
  summary: "Update a Stripe customer",
  tags: ["Customers"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: UpdateCustomerRequestSchema } } },
  },
  responses: {
    200: { description: "Customer updated", content: { "application/json": { schema: StripeObjectSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/customers",
  summary: "List Stripe customers (DB-backed mirror)",
  tags: ["Customers"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    query: ListCustomersQuerySchema,
  },
  responses: {
    200: { description: "Customer list", content: { "application/json": { schema: StripeListSchema } } },
  },
});

// --- Internal: org teardown ---

const DeleteCustomersByOrgResponseSchema = z
  .object({
    deleted: z.number().openapi({ description: "Number of Stripe customers deleted for the org" }),
    customer_ids: z.array(z.string()).openapi({ description: "IDs of the deleted Stripe customers" }),
  })
  .openapi("DeleteCustomersByOrgResponse");

registry.registerPath({
  method: "delete",
  path: "/internal/customers/by-org/{orgId}",
  summary: "Delete an org's Stripe customer (org teardown)",
  description:
    "Server-to-server. Resolves the org's Stripe customer, deletes it online at Stripe (platform key), and tombstones the local mirror. Idempotent: absent customer = 200, nothing deleted. Stripe-side deletion error propagates (fail loud). X-API-Key only — no identity headers (orgId is in the path).",
  tags: ["Customers"],
  security: apiKeySec,
  request: {
    params: z.object({ orgId: z.string() }),
  },
  responses: {
    200: {
      description: "Customer deleted, or nothing to delete (idempotent)",
      content: { "application/json": { schema: DeleteCustomersByOrgResponseSchema } },
    },
  },
});

// --- Internal: user-less org-scoped balance reads ---
//
// X-API-Key only, org keyed off the path, platform Stripe key. Back
// billing-service's machine-triggered balance composition (affordability +
// dunning schedulers) with no end-user and no x-user-id.

registry.registerPath({
  method: "get",
  path: "/internal/customers/by-org/{orgId}",
  summary: "Get an org's Stripe customer (user-less)",
  description:
    "Server-to-server. Returns the org's mirrored Stripe customer (verbatim raw_json), 404 when absent. DB-mirror read, no Stripe call. X-API-Key only — no identity headers (orgId is in the path). Backs billing-service getCustomerByOrg.",
  tags: ["Internal"],
  security: apiKeySec,
  request: {
    params: z.object({ orgId: z.string() }),
  },
  responses: {
    200: { description: "Customer", content: { "application/json": { schema: StripeObjectSchema } } },
    404: { description: "No customer for org", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/customers/by-org/{orgId}/all",
  summary: "List EVERY Stripe customer mirrored for an org (user-less)",
  description:
    "Server-to-server. Every customer mirrored for the org, as a Stripe list. The sibling GET /internal/customers/by-org/{orgId} returns the ONE customer the 1:1 org<->customer invariant promises; this returns all of them, because orgs predating the idempotent POST /v1/customers can hold more than one. A caller reassigning an org's customers must see all of them or it silently strands the ones it never listed. Resolved from the org_id column — the mapping this service owns — not from a metadata filter. DB-mirror read, no Stripe call, no pagination. X-API-Key only, no identity headers (orgId is in the path). An org with no customers gets an empty list, not a 404.",
  tags: ["Internal"],
  security: apiKeySec,
  request: { params: z.object({ orgId: z.string() }) },
  responses: {
    200: {
      description: "Stripe list of the org's mirrored customers",
      content: { "application/json": { schema: StripeListSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/customers/{id}/metadata",
  summary: "Rewrite a customer's Stripe metadata (user-less)",
  description:
    "Server-to-server. Updates a Stripe customer's metadata with no end-user identity, via the platform key. The /v1 twin resolves a per-org-per-user Stripe key, so a machine caller cannot reach it — and the workaround for that was a zero-uuid x-user-id, which this tier exists to make unnecessary. Deliberately metadata-only: a user-less write surface stays as narrow as the need, and the need is the org<->customer mapping. `metadata` is forwarded verbatim, so Stripe's semantics apply — keys are MERGED and a key set to the empty string is deleted. Re-mirrors immediately, resolving the org from the UPDATED object, so a metadata.org_id rewrite (a tenant move) lands the silver row on the new owner in the same request rather than on the next webhook. Fail loud: unknown customer -> 404, any other Stripe error propagates. X-API-Key only, no identity headers.",
  tags: ["Internal"],
  security: apiKeySec,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: UpdateCustomerMetadataRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "The updated Stripe customer, verbatim",
      content: { "application/json": { schema: z.any() } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Customer not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/payment_intents/by-org/{orgId}",
  summary: "List an org's PaymentIntents (user-less)",
  description:
    "Server-to-server. Returns every PaymentIntent mirrored for the org as a Stripe list (no limit — caller sums succeeded top-ups across the full set). DB-mirror read, no Stripe call. X-API-Key only — no identity headers (orgId is in the path). Backs billing-service sumSucceededTopupsForCustomer (org<->customer is 1:1) and, via api-service GET /v1/billing/payments, the dashboard payment history. Each entry is the verbatim Stripe PaymentIntent PLUS derived `amount_refunded`, `amount_disputed_lost` and `amount_returned` (minor units): Stripe leaves a refunded payment `succeeded` at full `amount_received`, so these fields are the only way to tell a live top-up from a returned one.",
  tags: ["Internal"],
  security: apiKeySec,
  request: {
    params: z.object({ orgId: z.string() }),
  },
  responses: {
    200: { description: "PaymentIntent list", content: { "application/json": { schema: StripeListSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/payment_summary/by-org/{orgId}",
  summary: "Org payment summary: paid in, given back, net (user-less)",
  description:
    "Server-to-server. Per-currency Stripe money movement for one org: `amount_received` (gross paid in — SUM(amount_received) over succeeded PaymentIntents, the same predicate billing already uses), `amount_refunded` (succeeded Refunds), `amount_disputed_lost` (Disputes we LOST), `amount_returned` (refunded + disputed_lost) and `amount_net` (received − returned). Stripe never mutates a payment when money goes back out — the PaymentIntent stays succeeded at full amount and the return lives on a separate Refund/Dispute object — so summing payments alone over-reports what the org still holds. Computed live from the DB mirrors, so partial refunds, refunds that later fail/cancel, and dispute outcomes are all correct with no reconciliation step. This is Stripe money movement ONLY, NOT a credit balance: promo grants and usage remain billing-service's business. DB-mirror read, no Stripe call. X-API-Key only — no identity headers (orgId is in the path). An org with no mirrored payments returns `totals: []` and `customer: null`.\n\nPass `as_of=<unix seconds>` for the same answer AS OF a moment: what the org had paid, net of what had come back, at that second. BOTH sides of the subtraction are bounded — payments AND returns Stripe created strictly before it — so the reply is the one this endpoint would itself have given then, and `as_of` at the current second is the unbounded reply. A return is attributed to the moment it HAPPENED and is never back-dated onto the payment it reverses, the same attribution `GET /public/stats/billing` uses for its buckets; back-dating would rewrite a figure a consumer has already read. The bound is EXCLUSIVE, so a launch instant T splits history cleanly and a payment made at T itself counts as after it. An object with no `created_stripe` cannot be placed in time and is excluded from a bounded read (an unbounded read still counts it) — the same rule for payments and for returns, so the two sides of `amount_net` are never drawn from different populations. An `as_of` that is not a positive integer is a 400, never a silently ignored filter.",
  tags: ["Internal"],
  security: apiKeySec,
  request: {
    params: z.object({ orgId: z.string() }),
    query: z.object({
      as_of: z.coerce.number().int().positive().optional().openapi({
        description:
          "Unix seconds. Bounds both payments and returns to those Stripe created strictly before this second. Omit for the all-time answer.",
      }),
    }),
  },
  responses: {
    200: {
      description: "Org payment summary",
      content: { "application/json": { schema: OrgPaymentSummarySchema } },
    },
    400: {
      description: "as_of is not a positive integer number of Unix seconds",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/payment_methods/by-org/{orgId}",
  summary: "List an org customer's PaymentMethods (user-less)",
  description:
    "Server-to-server. Live Stripe paymentMethods.list for the org's customer via the platform key (single-account model). Customer resolved from the mirror; 404 when the org has none. X-API-Key only — no identity headers (orgId is in the path). Backs billing-service hasAttachedCardPm.",
  tags: ["Internal"],
  security: apiKeySec,
  request: {
    params: z.object({ orgId: z.string() }),
    query: z.object({
      type: z.string().optional().openapi({
        description: "Optional Stripe payment method type filter (e.g. 'card'). Forwarded verbatim to Stripe.",
      }),
    }),
  },
  responses: {
    200: { description: "PaymentMethod list", content: { "application/json": { schema: StripeListSchema } } },
    404: { description: "No customer for org", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// --- Internal: off-session invoiced charge ---
//
// X-API-Key only, org keyed off the path, platform Stripe key. Lets
// billing-service charge an org's customer OFF-SESSION for a top-up in a way
// that produces a FINALIZED, PAID Stripe invoice (hosted invoice + PDF, shows
// up in the customer's billing-portal invoice list). Idempotent per the
// mandatory Idempotency-Key header (derived per Stripe step — no double charge
// on retry).

registry.registerPath({
  method: "post",
  path: "/internal/invoices/by-org/{orgId}",
  summary: "Create + pay an off-session invoice for an org's customer",
  description:
    "Server-to-server. Creates a one-line Stripe invoice for the org's customer, finalizes it, and pays it OFF-SESSION against the customer's stored card (explicit `payment_method` or the customer default). The result is a finalized, paid Stripe invoice (hosted invoice + PDF, visible in the customer's billing portal). Requires the `Idempotency-Key` header — it is derived per Stripe step (invoice / item / finalize / pay) so a retry never double-charges or creates a duplicate invoice. Uses the platform Stripe key (single-account model). X-API-Key only — no identity headers (orgId is in the path). Returns the paid Stripe Invoice object verbatim (with `payments` expanded). Provenance: the `metadata` you send is stamped on the invoice AND, after payment, on the resulting PaymentIntent together with `org_id` and `invoice_id` — Stripe copies neither, and a consumer summing PaymentIntents (billing) needs it there to tell an automatic platform-initiated charge from a customer-initiated top-up. It is readable on the PaymentIntent reads (`GET /internal/payment_intents/by-org/{orgId}`, `GET /v1/payment_intents`).",
  tags: ["Internal"],
  security: apiKeySec,
  request: {
    params: z.object({ orgId: z.string() }),
    headers: z.object({
      "idempotency-key": z
        .string()
        .openapi({ description: "Required. Stable per-logical-top-up key. Derived per Stripe step to guarantee no double-charge on retry." }),
    }),
    body: { content: { "application/json": { schema: CreateInvoiceByOrgRequestSchema } } },
  },
  responses: {
    200: { description: "Finalized, paid Stripe Invoice", content: { "application/json": { schema: StripeObjectSchema } } },
    400: { description: "Invalid request or missing Idempotency-Key header", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No customer for org", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// --- Internal: vendor-neutral charge ---
//
// The charge surface a caller uses when it wants MONEY TAKEN rather than a
// document. It resolves the org's acquirer itself and answers in one shape
// whatever it resolved, so no consumer ever learns a second acquirer exists.

registry.registerPath({
  method: "post",
  path: "/internal/charges/by-org/{orgId}",
  summary: "Charge an org off-session, whichever acquirer holds its card",
  description:
    "Server-to-server. Takes money from the org off-session and answers in ONE vendor-neutral shape whichever acquirer it resolved — the caller never names one. An org on Stripe gets the same finalized, paid invoice it always did, with its hosted invoice URL reported as `hosted_document_url`; an org on an acquirer with no invoice object gets `hosted_document_url: null`, which means \"this acquirer does not produce one\" and never \"the charge failed\" — `status` is the only thing that says whether the money moved. Requires the `Idempotency-Key` header: on Stripe it is derived per Stripe step, on Revolut it is stamped on the order so a retry resumes it instead of charging twice. X-API-Key only — no identity headers (orgId is in the path).",
  tags: ["Internal"],
  security: apiKeySec,
  request: {
    params: z.object({ orgId: z.string() }),
    headers: z.object({
      "idempotency-key": z.string().openapi({
        description:
          "Required. Stable per-logical-top-up key, so a retry never takes money twice on either acquirer.",
      }),
    }),
    body: { content: { "application/json": { schema: ChargeByOrgRequestSchema } } },
  },
  responses: {
    200: { description: "Charge result", content: { "application/json": { schema: ChargeResultSchema } } },
    400: { description: "Invalid request or missing Idempotency-Key header", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "No customer for org on its acquirer", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "No chargeable saved payment method", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// --- Checkout sessions ---

registry.registerPath({
  method: "post",
  path: "/v1/checkout/sessions",
  summary:
    "Create a checkout. A Stripe org gets its verbatim Checkout Session; an org the rollout has moved to another acquirer gets a neutral checkout carrying the same `url`.",
  tags: ["Checkout"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    body: { content: { "application/json": { schema: CreateCheckoutSessionRequestSchema } } },
  },
  responses: {
    200: { description: "Session created", content: { "application/json": { schema: StripeObjectSchema } } },
  },
});

// --- Internal: adding a card, and confirming one is actually there ---
//
// The two halves of the same job. `card_setup` DESCRIBES how this org's
// customer adds a card (the acquirers genuinely do not do it the same way);
// `saved_payment_method` answers whether one is now saved, keeping "no card"
// and "we could not ask" apart; `recurring_charges/.../authorize` is the gate a
// caller passes before it starts charging with nobody present.

export const CardSetupSchema = z
  .object({
    object: z.literal("card_setup"),
    mode: z.enum(["hosted_redirect", "embedded_widget"]).openapi({
      description:
        "Which MECHANISM this org's acquirer offers. `hosted_redirect` — send the customer to `url`. `embedded_widget` — load `script_url`, initialise the SDK with `token`, mount its card field, and pass `save_payment_method_for` when submitting it.",
    }),
    url: z.string().optional().openapi({
      description: "hosted_redirect only. Where to send the customer.",
    }),
    script_url: z.string().optional().openapi({
      description:
        "embedded_widget only. The acquirer's browser SDK to load in the page.",
    }),
    environment: z.enum(["prod", "sandbox"]).optional().openapi({
      description: "embedded_widget only. The SDK's environment argument.",
    }),
    token: z.string().optional().openapi({
      description:
        "embedded_widget only. The PER-ORDER PUBLIC identifier the SDK is initialised with. Scoped to this one setup attempt and safe to put in a page — it is not a merchant key and grants nothing beyond this order.",
    }),
    save_payment_method_for: z.literal("merchant").optional().openapi({
      description:
        "embedded_widget only. Pass this when submitting the card field. Saving for MERCHANT use is what makes the card chargeable later with nobody present; a card saved for the customer's own checkouts cannot be used by automatic top-up.",
    }),
  })
  .openapi("CardSetup");

export const SavedPaymentMethodSchema = z
  .object({
    object: z.literal("saved_payment_method"),
    org_id: z.string(),
    acquirer: z.enum(["stripe", "revolut"]),
    saved: z.boolean().openapi({
      description:
        "Whether a card is saved AND chargeable with nobody present. `false` means the acquirer answered and there is none — it never means we failed to ask, which is a non-2xx.",
    }),
    method: z
      .object({
        id: z.string(),
        type: z.string(),
        saved_for: z.string().nullable(),
      })
      .nullable(),
    reason: z
      .enum(["no_customer", "no_saved_method", "not_saved_for_merchant"])
      .optional()
      .openapi({ description: "Present only when `saved` is false." }),
  })
  .openapi("SavedPaymentMethod");

registry.registerPath({
  method: "post",
  path: "/internal/card_setup/by-org/{orgId}",
  summary: "How this org's customer adds a card (described, not performed)",
  description:
    "Server-to-server. Returns a DESCRIPTOR of the mechanism the org's acquirer offers, because the acquirers genuinely differ: one hosts a portal we redirect to, the other has no portal at all and saves a card only through a browser card field the page mounts itself. The caller switches on `mode` — a UI concern it owns anyway — and never names an acquirer, never resolves a key and never receives a secret: the only credential handed over is a PER-ORDER public token scoped to this one setup attempt. Card details are entered inside an iframe the acquirer hosts, so they never touch the calling page or this service. The widget flow AUTHORISES a small amount with capture disabled and the poller releases the hold ten minutes later; nobody is charged for adding a card. 409 when the org has no customer at its acquirer — there would be nothing to attach a card to. X-API-Key only — no identity headers (orgId is in the path).",
  tags: ["Internal"],
  security: apiKeySec,
  request: {
    params: z.object({ orgId: z.string() }),
    body: { content: { "application/json": { schema: CardSetupRequestSchema } } },
  },
  responses: {
    200: { description: "Card-setup descriptor", content: { "application/json": { schema: CardSetupSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "The org has no customer at its acquirer", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/saved_payment_method/by-org/{orgId}",
  summary: "Is a chargeable card saved for this org, on whichever acquirer holds it",
  description:
    "Server-to-server. Answers whether the org has a card that can be charged LATER with nobody present, read LIVE from whichever acquirer holds its cards (never cached — a method can be removed or made ineligible with no event we would see). THREE answers, kept apart on purpose: `200 {saved:true, method}` there is one; `200 {saved:false, reason}` the acquirer answered and there is none; a NON-2XX when we could not ask at all. The last two are never merged — a caller that cannot tell them apart would arm automatic top-up off a timeout, for an org that cannot be charged. X-API-Key only — no identity headers (orgId is in the path).",
  tags: ["Internal"],
  security: apiKeySec,
  request: { params: z.object({ orgId: z.string() }) },
  responses: {
    200: { description: "Saved-method confirmation", content: { "application/json": { schema: SavedPaymentMethodSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/recurring_charges/by-org/{orgId}/authorize",
  summary: "May automatic charges be armed for this org?",
  description:
    "Server-to-server. The gate a caller passes through BEFORE it starts charging an org with nobody present. `200` yes, with the method that will be charged; `409 {code:\"no_saved_payment_method\", reason}` no, the acquirer holds no card we could charge; a non-2xx when the acquirer could not be asked, in which case nothing may be armed — an unknown answer is not a yes. Writes nothing and takes no money: it confirms, or it refuses. An org that pays once and then cannot be charged again is worse than one we never routed to that acquirer, because its campaigns stop with nothing reporting why. X-API-Key only — no identity headers (orgId is in the path).",
  tags: ["Internal"],
  security: apiKeySec,
  request: { params: z.object({ orgId: z.string() }) },
  responses: {
    200: { description: "Authorized — a saved, chargeable method exists", content: { "application/json": { schema: StripeObjectSchema } } },
    409: { description: "Refused — no saved payment method", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/acquirer_rollout",
  summary: "Read the acquirer rollout (share of NEW orgs sent to a second acquirer)",
  tags: ["Internal"],
  security: apiKeySec,
  responses: {
    200: { description: "Rollout", content: { "application/json": { schema: StripeObjectSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/internal/acquirer_rollout",
  summary: "Set the acquirer rollout. percent 0 reverses it with no deploy.",
  tags: ["Internal"],
  security: apiKeySec,
  request: {
    body: { content: { "application/json": { schema: AcquirerRolloutRequestSchema } } },
  },
  responses: {
    200: { description: "Rollout", content: { "application/json": { schema: StripeObjectSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/checkout/sessions/{id}",
  summary: "Retrieve a Checkout Session",
  tags: ["Checkout"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Session", content: { "application/json": { schema: StripeObjectSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/checkout/sessions",
  summary: "List Checkout Sessions (DB-backed mirror)",
  tags: ["Checkout"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    query: ListCheckoutSessionsQuerySchema,
  },
  responses: {
    200: { description: "Session list", content: { "application/json": { schema: StripeListSchema } } },
  },
});

// --- Payment intents ---

registry.registerPath({
  method: "post",
  path: "/v1/payment_intents",
  summary: "Create a PaymentIntent",
  tags: ["PaymentIntents"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    body: { content: { "application/json": { schema: CreatePaymentIntentRequestSchema } } },
  },
  responses: {
    200: { description: "PaymentIntent created", content: { "application/json": { schema: StripeObjectSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/payment_intents/{id}",
  summary: "Retrieve a PaymentIntent",
  tags: ["PaymentIntents"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "PaymentIntent", content: { "application/json": { schema: StripeObjectSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/payment_intents",
  summary: "List PaymentIntents (DB-backed mirror)",
  description:
    "Returns DB-cached PaymentIntents. Status is webhook-updated. Callers use this to inspect in-flight reloads per customer before triggering new payments.",
  tags: ["PaymentIntents"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    query: ListPaymentIntentsQuerySchema,
  },
  responses: {
    200: { description: "PaymentIntent list", content: { "application/json": { schema: StripeListSchema } } },
  },
});

// --- Payment methods ---

registry.registerPath({
  method: "get",
  path: "/v1/payment_methods",
  summary: "List a customer's PaymentMethods (live Stripe)",
  description:
    "Live passthrough to Stripe `paymentMethods.list({ customer, type? })`. The customer must belong to the caller's org (looked up via the customers mirror) or the request 404s — prevents cross-org PM enumeration. Used by billing-service to pick an explicit `payment_method` for off_session reload PaymentIntents instead of relying on `customer.invoice_settings.default_payment_method` (which may be a Link / wallet PM that Stripe refuses to charge off_session).",
  tags: ["PaymentMethods"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    query: ListPaymentMethodsQuerySchema,
  },
  responses: {
    200: { description: "PaymentMethod list", content: { "application/json": { schema: StripeListSchema } } },
    404: { description: "Customer not found in caller's org", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// --- Public stats ---

registry.registerPath({
  method: "get",
  path: "/public/stats/billing",
  summary: "Public aggregate billing stats (no auth, cross-org)",
  description:
    "Aggregate money movement across all orgs AND EVERY ACQUIRER this service takes money through (Stripe and Revolut). Public endpoint — no X-API-Key, no identity headers. GROSS (`*paid_cents`) and NET (`*net_cents`) are both published and must not be conflated: report gross as revenue and net as credited. Money in is a `succeeded` Stripe PaymentIntent or a `completed` Revolut `payment` order; money out is a `succeeded` Stripe Refund, a `lost` Stripe Dispute, or a `completed` Revolut `refund` order attributed to the payment it reverses — the same settled-only rule every other read here applies, so a return that failed drops out on its own. Nothing is excluded for looking like a test.\n\nCURRENCIES ARE SUMMED TOGETHER into one scalar. That is deliberate: this is a single cross-org figure with no currency dimension, and it is why the totals here are NOT claimed to equal the sum of the per-org `amount_net` figures, which are per-currency. `accounts_with_payment_method` is Stripe-only — see its own description.\n\nBuckets carry the same gross/net distinction and sum to the all-time totals on both grains; a return is attributed to the period it happened in, so a period whose returns exceed its payments reports a negative `net_cents`.\n\nHOW MANY ACCOUNTS PAID rides the same buckets as how much they paid: `paying_accounts` (distinct accounts with a settled payment in the period) and `first_time_paying_accounts` (those with no earlier settled payment on ANY acquirer), plus `total_paying_accounts` for the platform. ACQUIRER COVERAGE OF THE COUNTS IS BOTH ACQUIRERS, identical to the money and NOT the Stripe-only scope of `accounts_with_payment_method` — do not assume they share a scope. They count who PAID, never who has a card on file, so a wallet payment and a second-acquirer payment are both counted. An account is the ORG, so an org paying on both acquirers is one account. A refund never un-counts a payer. A payment with no resolvable org is excluded from the counts but still counted in the money.",
  tags: ["Public"],
  responses: {
    200: {
      description: "Aggregate stats",
      content: { "application/json": { schema: PublicStatsBillingResponseSchema } },
    },
  },
});

// --- Billing portal sessions ---

registry.registerPath({
  method: "post",
  path: "/v1/billing_portal/sessions",
  summary: "Create a Billing Portal Session",
  tags: ["BillingPortal"],
  security: apiKeySec,
  request: {
    headers: IdentityHeadersSchema,
    body: { content: { "application/json": { schema: CreateBillingPortalSessionRequestSchema } } },
  },
  responses: {
    200: { description: "Session created", content: { "application/json": { schema: StripeObjectSchema } } },
  },
});

// --- Webhooks ---

registry.registerPath({
  method: "post",
  path: "/v1/webhooks",
  summary: "Stripe webhook handler",
  description:
    "Verifies signature, persists event, upserts target object. No auth — uses Stripe signature only.",
  tags: ["Webhooks"],
  request: {
    body: { content: { "application/json": { schema: z.any() } } },
  },
  responses: {
    200: { description: "Event processed", content: { "application/json": { schema: z.object({ received: z.boolean() }) } } },
    400: { description: "Invalid signature", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});
