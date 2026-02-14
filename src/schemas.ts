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
