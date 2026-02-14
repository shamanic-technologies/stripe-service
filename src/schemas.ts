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
    discounts: z
      .array(
        z.object({
          coupon: z.string().optional().openapi({ description: "Stripe Coupon ID" }),
          promotionCode: z
            .string()
            .optional()
            .openapi({ description: "Stripe Promotion Code ID" }),
        })
      )
      .optional()
      .openapi({ description: "Discounts to apply to the checkout session" }),
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

// ===== Create Product =====

export const CreateProductRequestSchema = z
  .object({
    id: z.string().optional().openapi({ description: "Custom Stripe Product ID for idempotent creates" }),
    name: z.string().min(1).openapi({ description: "Product name" }),
    description: z
      .string()
      .optional()
      .openapi({ description: "Product description" }),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .openapi({ description: "Custom metadata" }),
  })
  .openapi("CreateProductRequest");

export type CreateProductRequest = z.infer<typeof CreateProductRequestSchema>;

export const CreateProductResponseSchema = z
  .object({
    success: z.boolean(),
    productId: z.string().openapi({ description: "Stripe Product ID" }),
    name: z.string().openapi({ description: "Product name" }),
    description: z.string().nullable().optional().openapi({ description: "Product description" }),
  })
  .openapi("CreateProductResponse");

export const GetProductResponseSchema = z
  .object({
    success: z.boolean(),
    productId: z.string().openapi({ description: "Stripe Product ID" }),
    name: z.string().openapi({ description: "Product name" }),
    description: z.string().nullable().openapi({ description: "Product description" }),
  })
  .openapi("GetProductResponse");

// ===== Create Price =====

export const CreatePriceRequestSchema = z
  .object({
    productId: z
      .string()
      .min(1)
      .openapi({ description: "Stripe Product ID to attach the price to" }),
    unitAmountInCents: z
      .number()
      .int()
      .positive()
      .openapi({ description: "Price amount in cents" }),
    currency: z
      .string()
      .optional()
      .default("usd")
      .openapi({ description: "Currency code (default: usd)" }),
    recurring: z
      .object({
        interval: z
          .enum(["day", "week", "month", "year"])
          .openapi({ description: "Billing interval" }),
        intervalCount: z
          .number()
          .int()
          .positive()
          .optional()
          .default(1)
          .openapi({ description: "Number of intervals between billings" }),
      })
      .optional()
      .openapi({
        description:
          "Recurring pricing configuration. Omit for one-time prices.",
      }),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .openapi({ description: "Custom metadata" }),
  })
  .openapi("CreatePriceRequest");

export type CreatePriceRequest = z.infer<typeof CreatePriceRequestSchema>;

export const CreatePriceResponseSchema = z
  .object({
    success: z.boolean(),
    priceId: z.string().openapi({ description: "Stripe Price ID" }),
    productId: z
      .string()
      .openapi({ description: "Associated Stripe Product ID" }),
    unitAmountInCents: z
      .number()
      .openapi({ description: "Price amount in cents" }),
    currency: z.string().openapi({ description: "Currency code" }),
  })
  .openapi("CreatePriceResponse");

const PriceItemSchema = z.object({
  priceId: z.string().openapi({ description: "Stripe Price ID" }),
  productId: z.string().openapi({ description: "Associated Stripe Product ID" }),
  unitAmountInCents: z.number().nullable().openapi({ description: "Price amount in cents" }),
  currency: z.string().openapi({ description: "Currency code" }),
  active: z.boolean().openapi({ description: "Whether the price is active" }),
});

export const GetPriceResponseSchema = z
  .object({
    success: z.boolean(),
  })
  .merge(PriceItemSchema)
  .openapi("GetPriceResponse");

export const ListPricesResponseSchema = z
  .object({
    success: z.boolean(),
    prices: z.array(PriceItemSchema),
  })
  .openapi("ListPricesResponse");

// ===== Create Coupon =====

export const CreateCouponRequestSchema = z
  .object({
    id: z.string().optional().openapi({ description: "Custom Stripe Coupon ID for idempotent creates" }),
    name: z
      .string()
      .optional()
      .openapi({ description: "Display name for the coupon" }),
    percentOff: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .openapi({ description: "Percentage discount (1-100). Provide this OR amountOffInCents." }),
    amountOffInCents: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: "Fixed amount discount in cents. Provide this OR percentOff." }),
    currency: z
      .string()
      .optional()
      .openapi({ description: "Currency code. Required if amountOffInCents is provided." }),
    duration: z
      .enum(["once", "repeating", "forever"])
      .optional()
      .default("once")
      .openapi({ description: "How long the coupon applies (default: once)" }),
    durationInMonths: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: "Number of months (required if duration is repeating)" }),
    maxRedemptions: z
      .number()
      .int()
      .positive()
      .optional()
      .openapi({ description: "Maximum number of times the coupon can be redeemed" }),
    redeemBy: z
      .string()
      .datetime()
      .optional()
      .openapi({ description: "ISO 8601 date after which the coupon can no longer be redeemed" }),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .openapi({ description: "Custom metadata" }),
  })
  .refine((data) => data.percentOff != null || data.amountOffInCents != null, {
    message: "Either percentOff or amountOffInCents must be provided",
  })
  .refine(
    (data) => !(data.amountOffInCents != null && !data.currency),
    { message: "currency is required when amountOffInCents is provided" }
  )
  .openapi("CreateCouponRequest");

export type CreateCouponRequest = z.infer<typeof CreateCouponRequestSchema>;

export const CreateCouponResponseSchema = z
  .object({
    success: z.boolean(),
    couponId: z.string().openapi({ description: "Stripe Coupon ID" }),
    name: z.string().nullable().openapi({ description: "Coupon display name" }),
    percentOff: z
      .number()
      .nullable()
      .openapi({ description: "Percentage discount" }),
    amountOffInCents: z
      .number()
      .nullable()
      .openapi({ description: "Fixed amount discount in cents" }),
    currency: z
      .string()
      .nullable()
      .openapi({ description: "Currency code" }),
    duration: z.string().openapi({ description: "Coupon duration" }),
  })
  .openapi("CreateCouponResponse");

export const GetCouponResponseSchema = z
  .object({
    success: z.boolean(),
    couponId: z.string().openapi({ description: "Stripe Coupon ID" }),
    name: z.string().nullable().openapi({ description: "Coupon display name" }),
    percentOff: z.number().nullable().openapi({ description: "Percentage discount" }),
    amountOffInCents: z.number().nullable().openapi({ description: "Fixed amount discount in cents" }),
    currency: z.string().nullable().openapi({ description: "Currency code" }),
    duration: z.string().openapi({ description: "Coupon duration" }),
    valid: z.boolean().openapi({ description: "Whether the coupon is still valid" }),
  })
  .openapi("GetCouponResponse");

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

// --- Create Product ---

registry.registerPath({
  method: "post",
  path: "/products/create",
  summary: "Create a Stripe product",
  description:
    "Creates a product in Stripe. Pass an optional id for idempotent creates — if the product already exists, it will be returned.",
  tags: ["Products"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: CreateProductRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Product created",
      content: {
        "application/json": { schema: CreateProductResponseSchema },
      },
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

// --- Create Price ---

registry.registerPath({
  method: "post",
  path: "/prices/create",
  summary: "Create a Stripe price for a product",
  description:
    "Creates a price attached to a Stripe product. Use the returned priceId in checkout sessions.",
  tags: ["Products"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: CreatePriceRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Price created",
      content: {
        "application/json": { schema: CreatePriceResponseSchema },
      },
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

// --- Create Coupon ---

registry.registerPath({
  method: "post",
  path: "/coupons/create",
  summary: "Create a Stripe coupon",
  description:
    "Creates a coupon in Stripe. Pass an optional id for idempotent creates — if the coupon already exists, it will be returned.",
  tags: ["Products"],
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: CreateCouponRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Coupon created",
      content: {
        "application/json": { schema: CreateCouponResponseSchema },
      },
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

// --- Get Product ---

registry.registerPath({
  method: "get",
  path: "/products/{productId}",
  summary: "Get a Stripe product by ID",
  tags: ["Products"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ productId: z.string() }),
  },
  responses: {
    200: {
      description: "Product found",
      content: { "application/json": { schema: GetProductResponseSchema } },
    },
    404: {
      description: "Product not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Get Price ---

registry.registerPath({
  method: "get",
  path: "/prices/{priceId}",
  summary: "Get a Stripe price by ID",
  tags: ["Products"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ priceId: z.string() }),
  },
  responses: {
    200: {
      description: "Price found",
      content: { "application/json": { schema: GetPriceResponseSchema } },
    },
    404: {
      description: "Price not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- List Prices by Product ---

registry.registerPath({
  method: "get",
  path: "/prices/by-product/{productId}",
  summary: "List active prices for a product",
  tags: ["Products"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ productId: z.string() }),
  },
  responses: {
    200: {
      description: "Prices for product",
      content: { "application/json": { schema: ListPricesResponseSchema } },
    },
  },
});

// --- Get Coupon ---

registry.registerPath({
  method: "get",
  path: "/coupons/{couponId}",
  summary: "Get a Stripe coupon by ID",
  tags: ["Products"],
  security: [{ apiKey: [] }],
  request: {
    params: z.object({ couponId: z.string() }),
  },
  responses: {
    200: {
      description: "Coupon found",
      content: { "application/json": { schema: GetCouponResponseSchema } },
    },
    404: {
      description: "Coupon not found",
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
