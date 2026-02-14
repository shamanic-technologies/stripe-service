import { describe, it, expect } from "vitest";
import {
  CreateCheckoutSessionRequestSchema,
  CreatePaymentIntentRequestSchema,
  StatsRequestSchema,
  ErrorResponseSchema,
  CreateProductRequestSchema,
  UpdateProductRequestSchema,
  CreatePriceRequestSchema,
  CreateCouponRequestSchema,
  CreateCustomerRequestSchema,
  UpdateCustomerRequestSchema,
} from "../../src/schemas";

describe("CreateCheckoutSessionRequestSchema", () => {
  it("accepts valid checkout request", () => {
    const result = CreateCheckoutSessionRequestSchema.safeParse({
      lineItems: [{ priceId: "price_123", quantity: 1 }],
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    expect(result.success).toBe(true);
  });

  it("accepts checkout request with all optional fields", () => {
    const result = CreateCheckoutSessionRequestSchema.safeParse({
      orgId: "org_123",
      runId: "run_123",
      brandId: "brand_123",
      appId: "app_123",
      campaignId: "campaign_123",
      lineItems: [{ priceId: "price_123", quantity: 2 }],
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      customerId: "cus_123",
      customerEmail: "test@example.com",
      mode: "subscription",
      metadata: { key: "value" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty line items", () => {
    const result = CreateCheckoutSessionRequestSchema.safeParse({
      lineItems: [],
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid URLs", () => {
    const result = CreateCheckoutSessionRequestSchema.safeParse({
      lineItems: [{ priceId: "price_123", quantity: 1 }],
      successUrl: "not-a-url",
      cancelUrl: "https://example.com/cancel",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative quantity", () => {
    const result = CreateCheckoutSessionRequestSchema.safeParse({
      lineItems: [{ priceId: "price_123", quantity: -1 }],
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    expect(result.success).toBe(false);
  });
});

describe("CreatePaymentIntentRequestSchema", () => {
  it("accepts valid payment intent request", () => {
    const result = CreatePaymentIntentRequestSchema.safeParse({
      amountInCents: 1000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts payment intent with all optional fields", () => {
    const result = CreatePaymentIntentRequestSchema.safeParse({
      orgId: "org_123",
      runId: "run_123",
      brandId: "brand_123",
      appId: "app_123",
      campaignId: "campaign_123",
      amountInCents: 5000,
      currency: "eur",
      customerId: "cus_123",
      description: "Test payment",
      metadata: { orderId: "order_123" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects zero amount", () => {
    const result = CreatePaymentIntentRequestSchema.safeParse({
      amountInCents: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative amount", () => {
    const result = CreatePaymentIntentRequestSchema.safeParse({
      amountInCents: -100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer amount", () => {
    const result = CreatePaymentIntentRequestSchema.safeParse({
      amountInCents: 10.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("StatsRequestSchema", () => {
  it("accepts empty body", () => {
    const result = StatsRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts all filter fields", () => {
    const result = StatsRequestSchema.safeParse({
      runIds: ["run_1", "run_2"],
      clerkOrgId: "org_123",
      brandId: "brand_123",
      appId: "app_123",
      campaignId: "campaign_123",
    });
    expect(result.success).toBe(true);
  });
});

describe("ErrorResponseSchema", () => {
  it("accepts error with message", () => {
    const result = ErrorResponseSchema.safeParse({
      error: "Something went wrong",
    });
    expect(result.success).toBe(true);
  });

  it("accepts error with details", () => {
    const result = ErrorResponseSchema.safeParse({
      error: "Validation failed",
      details: { field: "amount" },
    });
    expect(result.success).toBe(true);
  });
});

describe("CreateProductRequestSchema", () => {
  it("accepts valid product", () => {
    const result = CreateProductRequestSchema.safeParse({ name: "My Product" });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = CreateProductRequestSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const result = CreateProductRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("UpdateProductRequestSchema", () => {
  it("accepts partial update", () => {
    const result = UpdateProductRequestSchema.safeParse({ active: false });
    expect(result.success).toBe(true);
  });

  it("accepts empty body", () => {
    const result = UpdateProductRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("CreatePriceRequestSchema", () => {
  it("accepts one-time price", () => {
    const result = CreatePriceRequestSchema.safeParse({
      product: "prod_123",
      unitAmountInCents: 1999,
    });
    expect(result.success).toBe(true);
  });

  it("accepts recurring price", () => {
    const result = CreatePriceRequestSchema.safeParse({
      product: "prod_123",
      unitAmountInCents: 999,
      recurring: { interval: "month" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing product", () => {
    const result = CreatePriceRequestSchema.safeParse({ unitAmountInCents: 100 });
    expect(result.success).toBe(false);
  });

  it("rejects negative amount", () => {
    const result = CreatePriceRequestSchema.safeParse({
      product: "prod_123",
      unitAmountInCents: -1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts zero amount (free)", () => {
    const result = CreatePriceRequestSchema.safeParse({
      product: "prod_123",
      unitAmountInCents: 0,
    });
    expect(result.success).toBe(true);
  });
});

describe("CreateCouponRequestSchema", () => {
  it("accepts percent-off coupon", () => {
    const result = CreateCouponRequestSchema.safeParse({
      percentOff: 25,
      duration: "once",
    });
    expect(result.success).toBe(true);
  });

  it("accepts amount-off coupon", () => {
    const result = CreateCouponRequestSchema.safeParse({
      amountOffInCents: 500,
      currency: "usd",
      duration: "forever",
    });
    expect(result.success).toBe(true);
  });

  it("rejects without percentOff or amountOff", () => {
    const result = CreateCouponRequestSchema.safeParse({
      duration: "once",
    });
    expect(result.success).toBe(false);
  });

  it("rejects percent over 100", () => {
    const result = CreateCouponRequestSchema.safeParse({
      percentOff: 101,
      duration: "once",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing duration", () => {
    const result = CreateCouponRequestSchema.safeParse({
      percentOff: 10,
    });
    expect(result.success).toBe(false);
  });
});

describe("CreateCustomerRequestSchema", () => {
  it("accepts customer with email and name", () => {
    const result = CreateCustomerRequestSchema.safeParse({
      email: "test@example.com",
      name: "Test User",
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty body (all optional)", () => {
    const result = CreateCustomerRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects invalid email", () => {
    const result = CreateCustomerRequestSchema.safeParse({
      email: "not-an-email",
    });
    expect(result.success).toBe(false);
  });
});

describe("UpdateCustomerRequestSchema", () => {
  it("accepts partial update", () => {
    const result = UpdateCustomerRequestSchema.safeParse({ name: "New Name" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid email", () => {
    const result = UpdateCustomerRequestSchema.safeParse({ email: "bad" });
    expect(result.success).toBe(false);
  });
});
