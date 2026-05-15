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
  })
  .openapi("ListCustomersQuery");

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
    line_items: z.array(LineItemSchema).min(1),
    success_url: z.string().url(),
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
