import { describe, it, expect } from "vitest";
import {
  CreateCheckoutSessionRequestSchema,
  CreatePaymentIntentRequestSchema,
  StatsRequestSchema,
  ErrorResponseSchema,
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
