import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app";

// Mock the stripe client
vi.mock("../../src/lib/stripe-client", () => ({
  createCheckoutSession: vi.fn().mockResolvedValue({
    success: true,
    sessionId: "cs_test_mock123",
    url: "https://checkout.stripe.com/test",
  }),
  createPaymentIntent: vi.fn().mockResolvedValue({
    success: true,
    paymentIntentId: "pi_test_mock123",
    clientSecret: "pi_test_mock123_secret_abc",
    status: "requires_payment_method",
  }),
  constructWebhookEvent: vi.fn(),
  createProduct: vi.fn(),
  createPrice: vi.fn(),
  createCoupon: vi.fn(),
}));

// Mock the runs client
vi.mock("../../src/lib/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run_mock123" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

// Mock the key resolver — always returns a key by default
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn().mockResolvedValue("sk_test_resolved_key"),
}));

// Mock the database
vi.mock("../../src/db", () => {
  const mockInsert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        { id: "payment_mock123", orgId: "org_123", amountInCents: 1000, currency: "usd", status: "pending" },
      ]),
    }),
  });
  return {
    db: {
      insert: mockInsert,
      query: {},
    },
  };
});

const app = createTestApp();
const API_KEY = "test-secret-key";

describe("POST /checkout/create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a checkout session successfully", async () => {
    const res = await request(app)
      .post("/checkout/create")
      .set("X-API-Key", API_KEY)
      .send({
        appId: "app_test",
        lineItems: [{ priceId: "price_123", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sessionId).toBe("cs_test_mock123");
    expect(res.body.url).toBe("https://checkout.stripe.com/test");
    expect(res.body.paymentId).toBe("payment_mock123");
  });

  it("returns 400 for invalid request", async () => {
    const res = await request(app)
      .post("/checkout/create")
      .set("X-API-Key", API_KEY)
      .send({
        appId: "app_test",
        lineItems: [],
        successUrl: "not-a-url",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .post("/checkout/create")
      .send({
        appId: "app_test",
        lineItems: [{ priceId: "price_123", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

    expect(res.status).toBe(401);
  });

  it("creates a checkout session with discounts", async () => {
    const res = await request(app)
      .post("/checkout/create")
      .set("X-API-Key", API_KEY)
      .send({
        appId: "app_test",
        lineItems: [{ priceId: "price_123", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        discounts: [{ coupon: "coupon_abc" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { createCheckoutSession } = await import(
      "../../src/lib/stripe-client"
    );
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        discounts: [{ coupon: "coupon_abc" }],
      }),
      "sk_test_resolved_key"
    );
  });

  it("returns 403 with wrong API key", async () => {
    const res = await request(app)
      .post("/checkout/create")
      .set("X-API-Key", "wrong-key")
      .send({
        appId: "app_test",
        lineItems: [{ priceId: "price_123", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

    expect(res.status).toBe(403);
  });

  it("resolves Stripe key via key-service when appId is provided", async () => {
    const res = await request(app)
      .post("/checkout/create")
      .set("X-API-Key", API_KEY)
      .send({
        appId: "app_custom_123",
        lineItems: [{ priceId: "price_123", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { resolveStripeKey } = await import(
      "../../src/lib/resolve-stripe-key"
    );
    expect(resolveStripeKey).toHaveBeenCalledWith("app_custom_123");

    const { createCheckoutSession } = await import(
      "../../src/lib/stripe-client"
    );
    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.any(Object),
      "sk_test_resolved_key"
    );
  });

  it("returns 400 when appId is missing", async () => {
    const res = await request(app)
      .post("/checkout/create")
      .set("X-API-Key", API_KEY)
      .send({
        lineItems: [{ priceId: "price_123", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 400 with clear error when key resolution fails", async () => {
    const { resolveStripeKey } = await import(
      "../../src/lib/resolve-stripe-key"
    );
    (resolveStripeKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("No Stripe key configured for appId 'app_missing'")
    );

    const res = await request(app)
      .post("/checkout/create")
      .set("X-API-Key", API_KEY)
      .send({
        appId: "app_missing",
        lineItems: [{ priceId: "price_123", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "No Stripe key configured for appId 'app_missing'"
    );
  });

});

describe("POST /payment-intent/create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a payment intent successfully", async () => {
    const res = await request(app)
      .post("/payment-intent/create")
      .set("X-API-Key", API_KEY)
      .send({
        appId: "app_test",
        amountInCents: 5000,
        currency: "usd",
        description: "Test payment",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.paymentIntentId).toBe("pi_test_mock123");
    expect(res.body.clientSecret).toBe("pi_test_mock123_secret_abc");
    expect(res.body.paymentId).toBe("payment_mock123");
  });

  it("returns 400 for zero amount", async () => {
    const res = await request(app)
      .post("/payment-intent/create")
      .set("X-API-Key", API_KEY)
      .send({
        appId: "app_test",
        amountInCents: 0,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("returns 400 for missing amount", async () => {
    const res = await request(app)
      .post("/payment-intent/create")
      .set("X-API-Key", API_KEY)
      .send({ appId: "app_test" });

    expect(res.status).toBe(400);
  });

  it("resolves Stripe key via key-service when appId is provided", async () => {
    const res = await request(app)
      .post("/payment-intent/create")
      .set("X-API-Key", API_KEY)
      .send({
        appId: "app_custom_456",
        amountInCents: 3000,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { resolveStripeKey } = await import(
      "../../src/lib/resolve-stripe-key"
    );
    expect(resolveStripeKey).toHaveBeenCalledWith("app_custom_456");

    const { createPaymentIntent } = await import(
      "../../src/lib/stripe-client"
    );
    expect(createPaymentIntent).toHaveBeenCalledWith(
      expect.any(Object),
      "sk_test_resolved_key"
    );
  });

  it("returns 400 with clear error when key resolution fails", async () => {
    const { resolveStripeKey } = await import(
      "../../src/lib/resolve-stripe-key"
    );
    (resolveStripeKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("No Stripe key configured for appId 'app_failing'")
    );

    const res = await request(app)
      .post("/payment-intent/create")
      .set("X-API-Key", API_KEY)
      .send({
        appId: "app_failing",
        amountInCents: 3000,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "No Stripe key configured for appId 'app_failing'"
    );
  });
});
