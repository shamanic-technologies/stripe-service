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
      .openapi({ description: "Human-readable description — used for both the invoice line item and the invoice." }),
    payment_method: z
      .string()
      .optional()
      .openapi({
        description:
          "Explicit PaymentMethod (pm_…) to charge off-session. Omit to use the customer's default PM. Prefer an explicit card PM — the customer default may be a Link / wallet PM that Stripe refuses to charge off_session.",
      }),
    metadata: z.record(z.string(), z.string()).optional(),
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
    paid_cents: z.string(),
  })
  .openapi("PublicStatsBucket");

export const PublicStatsBillingResponseSchema = z
  .object({
    total_paid_cents: z.string(),
    accounts_with_payment_method: z.number().int().nonnegative(),
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
  path: "/internal/payment_intents/by-org/{orgId}",
  summary: "List an org's PaymentIntents (user-less)",
  description:
    "Server-to-server. Returns every PaymentIntent mirrored for the org as a Stripe list (no limit — caller sums succeeded top-ups across the full set). DB-mirror read, no Stripe call. X-API-Key only — no identity headers (orgId is in the path). Backs billing-service sumSucceededTopupsForCustomer (org<->customer is 1:1).",
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
    "Server-to-server. Creates a one-line Stripe invoice for the org's customer, finalizes it, and pays it OFF-SESSION against the customer's stored card (explicit `payment_method` or the customer default). The result is a finalized, paid Stripe invoice (hosted invoice + PDF, visible in the customer's billing portal). Requires the `Idempotency-Key` header — it is derived per Stripe step (invoice / item / finalize / pay) so a retry never double-charges or creates a duplicate invoice. Uses the platform Stripe key (single-account model). X-API-Key only — no identity headers (orgId is in the path). Returns the paid Stripe Invoice object verbatim.",
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

// --- Checkout sessions ---

registry.registerPath({
  method: "post",
  path: "/v1/checkout/sessions",
  summary: "Create a Checkout Session",
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
    "Aggregate Stripe-side payment stats across all orgs. Public endpoint — no X-API-Key, no identity headers.",
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
