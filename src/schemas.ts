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

// ===== Shared schemas =====

export const ErrorResponseSchema = z
  .object({
    error: z.string().openapi({ description: "Error message" }),
    details: z.any().optional().openapi({ description: "Additional error details" }),
  })
  .openapi("ErrorResponse");

// ===== Create Checkout Session =====

export const CreateCheckoutSessionRequestSchema = z
  .object({
    orgId: z.string().optional().openapi({ description: "Clerk organization ID" }),
    runId: z.string().optional().openapi({ description: "Parent run ID" }),
    brandId: z.string().optional().openapi({ description: "Brand ID" }),
    appId: z.string().optional().openapi({ description: "App ID" }),
    campaignId: z.string().optional().openapi({ description: "Campaign ID" }),
    lineItems: z
      .array(
        z.object({
          priceId: z.string().openapi({ description: "Stripe Price ID" }),
          quantity: z.number().int().positive().openapi({ description: "Quantity" }),
        })
      )
      .min(1)
      .openapi({ description: "Line items for checkout" }),
    successUrl: z.string().url().openapi({ description: "Redirect URL on success" }),
    cancelUrl: z.string().url().openapi({ description: "Redirect URL on cancel" }),
    customerId: z.string().optional().openapi({ description: "Stripe Customer ID" }),
    customerEmail: z.string().email().optional().openapi({ description: "Customer email" }),
    mode: z
      .enum(["payment", "subscription"])
      .optional()
      .default("payment")
      .openapi({ description: "Checkout mode" }),
    metadata: z.record(z.string(), z.string()).optional().openapi({ description: "Custom metadata" }),
  })
  .openapi("CreateCheckoutSessionRequest");

export type CreateCheckoutSessionRequest = z.infer<typeof CreateCheckoutSessionRequestSchema>;

export const CreateCheckoutSessionResponseSchema = z
  .object({
    success: z.boolean(),
    paymentId: z.string().uuid().openapi({ description: "Internal payment record ID" }),
    sessionId: z.string().optional().openapi({ description: "Stripe Checkout Session ID" }),
    url: z.string().optional().openapi({ description: "Stripe Checkout URL" }),
  })
  .openapi("CreateCheckoutSessionResponse");

// ===== Create Payment Intent =====

export const CreatePaymentIntentRequestSchema = z
  .object({
    orgId: z.string().optional().openapi({ description: "Clerk organization ID" }),
    runId: z.string().optional().openapi({ description: "Parent run ID" }),
    brandId: z.string().optional().openapi({ description: "Brand ID" }),
    appId: z.string().optional().openapi({ description: "App ID" }),
    campaignId: z.string().optional().openapi({ description: "Campaign ID" }),
    amountInCents: z.number().int().positive().openapi({ description: "Amount in cents" }),
    currency: z.string().optional().default("usd").openapi({ description: "Currency code" }),
    customerId: z.string().optional().openapi({ description: "Stripe Customer ID" }),
    description: z.string().optional().openapi({ description: "Payment description" }),
    metadata: z.record(z.string(), z.string()).optional().openapi({ description: "Custom metadata" }),
  })
  .openapi("CreatePaymentIntentRequest");

export type CreatePaymentIntentRequest = z.infer<typeof CreatePaymentIntentRequestSchema>;

export const CreatePaymentIntentResponseSchema = z
  .object({
    success: z.boolean(),
    paymentId: z.string().uuid().openapi({ description: "Internal payment record ID" }),
    paymentIntentId: z.string().optional().openapi({ description: "Stripe Payment Intent ID" }),
    clientSecret: z.string().optional().openapi({ description: "Client secret for frontend" }),
    status: z.string().optional().openapi({ description: "Payment intent status" }),
  })
  .openapi("CreatePaymentIntentResponse");

// ===== Payment Status =====

export const PaymentStatusResponseSchema = z
  .object({
    payment: z.object({
      id: z.string().uuid(),
      orgId: z.string().nullable(),
      runId: z.string().nullable(),
      brandId: z.string().nullable(),
      appId: z.string().nullable(),
      campaignId: z.string().nullable(),
      stripePaymentIntentId: z.string().nullable(),
      stripeCheckoutSessionId: z.string().nullable(),
      stripeCustomerId: z.string().nullable(),
      amountInCents: z.number(),
      currency: z.string(),
      status: z.string(),
      description: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
    events: z.object({
      successes: z.array(z.any()),
      failures: z.array(z.any()),
      refunds: z.array(z.any()),
      disputes: z.array(z.any()),
    }),
  })
  .openapi("PaymentStatusResponse");

// ===== Stats =====

export const StatsRequestSchema = z
  .object({
    runIds: z.array(z.string()).optional().openapi({ description: "Filter by run IDs" }),
    clerkOrgId: z.string().optional().openapi({ description: "Filter by org ID" }),
    brandId: z.string().optional().openapi({ description: "Filter by brand ID" }),
    appId: z.string().optional().openapi({ description: "Filter by app ID" }),
    campaignId: z.string().optional().openapi({ description: "Filter by campaign ID" }),
  })
  .openapi("StatsRequest");

export const StatsResponseSchema = z
  .object({
    totalPayments: z.number(),
    totalAmountInCents: z.number(),
    successCount: z.number(),
    failureCount: z.number(),
    refundCount: z.number(),
    disputeCount: z.number(),
  })
  .openapi("StatsResponse");

// ===== Products =====

export const CreateProductRequestSchema = z
  .object({
    name: z.string().min(1).openapi({ description: "Product name" }),
    description: z.string().optional().openapi({ description: "Product description" }),
    metadata: z.record(z.string(), z.string()).optional().openapi({ description: "Custom metadata" }),
    active: z.boolean().optional().default(true).openapi({ description: "Whether the product is active" }),
  })
  .openapi("CreateProductRequest");

export const UpdateProductRequestSchema = z
  .object({
    name: z.string().min(1).optional().openapi({ description: "Product name" }),
    description: z.string().optional().openapi({ description: "Product description" }),
    active: z.boolean().optional().openapi({ description: "Whether the product is active" }),
    metadata: z.record(z.string(), z.string()).optional().openapi({ description: "Custom metadata" }),
  })
  .openapi("UpdateProductRequest");

// ===== Prices =====

export const CreatePriceRequestSchema = z
  .object({
    product: z.string().min(1).openapi({ description: "Stripe Product ID" }),
    unitAmountInCents: z.number().int().min(0).openapi({ description: "Unit amount in cents" }),
    currency: z.string().optional().default("usd").openapi({ description: "Currency code" }),
    recurring: z
      .object({
        interval: z.enum(["day", "week", "month", "year"]).openapi({ description: "Billing interval" }),
        intervalCount: z.number().int().positive().optional().openapi({ description: "Number of intervals" }),
      })
      .optional()
      .openapi({ description: "Recurring billing config (omit for one-time prices)" }),
    metadata: z.record(z.string(), z.string()).optional().openapi({ description: "Custom metadata" }),
  })
  .openapi("CreatePriceRequest");

// ===== Coupons =====

export const CreateCouponRequestSchema = z
  .object({
    percentOff: z.number().min(1).max(100).optional().openapi({ description: "Percent discount (1-100)" }),
    amountOffInCents: z.number().int().positive().optional().openapi({ description: "Fixed discount in cents" }),
    currency: z.string().optional().openapi({ description: "Currency for amount_off" }),
    duration: z.enum(["once", "repeating", "forever"]).openapi({ description: "How long the coupon applies" }),
    durationInMonths: z.number().int().positive().optional().openapi({ description: "Months for repeating duration" }),
    name: z.string().optional().openapi({ description: "Display name" }),
    metadata: z.record(z.string(), z.string()).optional().openapi({ description: "Custom metadata" }),
  })
  .refine((data) => data.percentOff || data.amountOffInCents, {
    message: "Either percentOff or amountOffInCents is required",
  })
  .openapi("CreateCouponRequest");

// ===== Customers =====

export const CreateCustomerRequestSchema = z
  .object({
    email: z.string().email().optional().openapi({ description: "Customer email" }),
    name: z.string().optional().openapi({ description: "Customer name" }),
    metadata: z.record(z.string(), z.string()).optional().openapi({ description: "Custom metadata" }),
  })
  .openapi("CreateCustomerRequest");

export const UpdateCustomerRequestSchema = z
  .object({
    email: z.string().email().optional().openapi({ description: "Customer email" }),
    name: z.string().optional().openapi({ description: "Customer name" }),
    metadata: z.record(z.string(), z.string()).optional().openapi({ description: "Custom metadata" }),
  })
  .openapi("UpdateCustomerRequest");

// ================================================================
// Register all API paths
// ================================================================

// --- Health ---

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  tags: ["Health"],
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: z.object({
            status: z.string(),
            service: z.string(),
          }),
        },
      },
    },
  },
});

// --- Create Checkout Session ---

registry.registerPath({
  method: "post",
  path: "/checkout/create",
  summary: "Create a Stripe checkout session",
  description:
    "Creates a Stripe Checkout Session and records the payment in the database. Runs-service integration is BLOCKING.",
  tags: ["Payments"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: CreateCheckoutSessionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Checkout session created",
      content: { "application/json": { schema: CreateCheckoutSessionResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Create Payment Intent ---

registry.registerPath({
  method: "post",
  path: "/payment-intent/create",
  summary: "Create a Stripe payment intent",
  description:
    "Creates a Stripe Payment Intent and records the payment in the database. Runs-service integration is BLOCKING.",
  tags: ["Payments"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: CreatePaymentIntentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Payment intent created",
      content: { "application/json": { schema: CreatePaymentIntentResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Payment Status ---

registry.registerPath({
  method: "get",
  path: "/status/{paymentId}",
  summary: "Get payment status with events",
  tags: ["Payment Status"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({
      paymentId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "Payment status with events",
      content: { "application/json": { schema: PaymentStatusResponseSchema } },
    },
    404: {
      description: "Payment not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/status/by-org/{orgId}",
  summary: "List payments by organization",
  tags: ["Payment Status"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({
      orgId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "List of payments",
      content: {
        "application/json": {
          schema: z.object({
            payments: z.array(z.any()),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/status/by-run/{runId}",
  summary: "List payments by run",
  tags: ["Payment Status"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({
      runId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "List of payments",
      content: {
        "application/json": {
          schema: z.object({
            payments: z.array(z.any()),
          }),
        },
      },
    },
  },
});

// --- Stats ---

registry.registerPath({
  method: "post",
  path: "/stats",
  summary: "Get aggregated payment stats",
  tags: ["Payment Status"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: { "application/json": { schema: StatsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Aggregated stats",
      content: { "application/json": { schema: StatsResponseSchema } },
    },
  },
});

// --- Products ---

registry.registerPath({
  method: "post",
  path: "/products",
  summary: "Create a product",
  description: "Creates a product in Stripe. Stripe is the source of truth - no local DB storage.",
  tags: ["Products"],
  security: [{ apiKey: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateProductRequestSchema } } },
  },
  responses: {
    200: { description: "Product created", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/products",
  summary: "List products",
  tags: ["Products"],
  security: [{ apiKey: [] }],
  responses: {
    200: {
      description: "List of products",
      content: { "application/json": { schema: z.object({ products: z.array(z.any()), hasMore: z.boolean() }) } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/products/{id}",
  summary: "Get a product",
  tags: ["Products"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Product details", content: { "application/json": { schema: z.any() } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/products/{id}",
  summary: "Update a product",
  tags: ["Products"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: UpdateProductRequestSchema } } },
  },
  responses: {
    200: { description: "Product updated", content: { "application/json": { schema: z.any() } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// --- Prices ---

registry.registerPath({
  method: "post",
  path: "/prices",
  summary: "Create a price",
  description: "Creates a price for a product in Stripe.",
  tags: ["Prices"],
  security: [{ apiKey: [] }],
  request: {
    body: { content: { "application/json": { schema: CreatePriceRequestSchema } } },
  },
  responses: {
    200: { description: "Price created", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/prices",
  summary: "List prices",
  tags: ["Prices"],
  security: [{ apiKey: [] }],
  responses: {
    200: {
      description: "List of prices",
      content: { "application/json": { schema: z.object({ prices: z.array(z.any()), hasMore: z.boolean() }) } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/prices/{id}",
  summary: "Get a price",
  tags: ["Prices"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Price details", content: { "application/json": { schema: z.any() } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// --- Coupons ---

registry.registerPath({
  method: "post",
  path: "/coupons",
  summary: "Create a coupon",
  description: "Creates a coupon in Stripe. Requires either percentOff or amountOffInCents.",
  tags: ["Coupons"],
  security: [{ apiKey: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateCouponRequestSchema } } },
  },
  responses: {
    200: { description: "Coupon created", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/coupons",
  summary: "List coupons",
  tags: ["Coupons"],
  security: [{ apiKey: [] }],
  responses: {
    200: {
      description: "List of coupons",
      content: { "application/json": { schema: z.object({ coupons: z.array(z.any()), hasMore: z.boolean() }) } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/coupons/{id}",
  summary: "Get a coupon",
  tags: ["Coupons"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Coupon details", content: { "application/json": { schema: z.any() } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "delete",
  path: "/coupons/{id}",
  summary: "Delete a coupon",
  tags: ["Coupons"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Coupon deleted", content: { "application/json": { schema: z.any() } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// --- Customers ---

registry.registerPath({
  method: "post",
  path: "/customers",
  summary: "Create a customer",
  description: "Creates a customer in Stripe.",
  tags: ["Customers"],
  security: [{ apiKey: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateCustomerRequestSchema } } },
  },
  responses: {
    200: { description: "Customer created", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/customers",
  summary: "List customers",
  tags: ["Customers"],
  security: [{ apiKey: [] }],
  responses: {
    200: {
      description: "List of customers",
      content: { "application/json": { schema: z.object({ customers: z.array(z.any()), hasMore: z.boolean() }) } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/customers/{id}",
  summary: "Get a customer",
  tags: ["Customers"],
  security: [{ apiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Customer details", content: { "application/json": { schema: z.any() } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "patch",
  path: "/customers/{id}",
  summary: "Update a customer",
  tags: ["Customers"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: UpdateCustomerRequestSchema } } },
  },
  responses: {
    200: { description: "Customer updated", content: { "application/json": { schema: z.any() } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

// --- Webhooks ---

registry.registerPath({
  method: "post",
  path: "/webhooks/stripe",
  summary: "Handle Stripe webhook events",
  description:
    "Receives and processes Stripe webhook events. Uses Stripe signature verification.",
  tags: ["Webhooks"],
  request: {
    body: {
      content: { "application/json": { schema: z.any() } },
    },
  },
  responses: {
    200: {
      description: "Webhook processed",
      content: { "application/json": { schema: z.object({ received: z.boolean() }) } },
    },
    400: {
      description: "Invalid signature",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});
