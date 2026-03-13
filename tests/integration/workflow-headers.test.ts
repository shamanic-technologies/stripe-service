import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app";

// Mock the stripe client
vi.mock("../../src/lib/stripe-client", () => ({
  createCheckoutSession: vi.fn().mockResolvedValue({
    success: true,
    sessionId: "cs_test_wf",
    url: "https://checkout.stripe.com/test",
  }),
  createPaymentIntent: vi.fn().mockResolvedValue({
    success: true,
    paymentIntentId: "pi_test_wf",
    clientSecret: "pi_test_wf_secret",
    status: "requires_payment_method",
  }),
  constructWebhookEvent: vi.fn(),
  createProduct: vi.fn(),
  createPrice: vi.fn(),
  createCoupon: vi.fn(),
}));

// Mock the runs client
vi.mock("../../src/lib/runs-client", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run_wf123" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

// Mock the key resolver
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn().mockResolvedValue({ key: "sk_test_key", keySource: "platform" }),
}));

// Mock the database
vi.mock("../../src/db", () => {
  const mockInsert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        { id: "payment_wf123", orgId: "org_wf", amountInCents: 1000, currency: "usd", status: "pending" },
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
const ORG_ID = "org_wf_test";
const USER_ID = "user_wf_test";
const RUN_ID = "run_caller_wf";
const CAMPAIGN_ID = "camp_wf_123";
const BRAND_ID = "brand_wf_456";
const WORKFLOW_NAME = "checkout-flow-dag";

describe("Workflow tracking headers forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards workflow headers to resolveStripeKey on checkout/create", async () => {
    const res = await request(app)
      .post("/checkout/create")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .set("x-campaign-id", CAMPAIGN_ID)
      .set("x-brand-id", BRAND_ID)
      .set("x-workflow-name", WORKFLOW_NAME)
      .send({
        lineItems: [{ priceId: "price_123", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

    expect(res.status).toBe(200);

    const { resolveStripeKey } = await import("../../src/lib/resolve-stripe-key");
    expect(resolveStripeKey).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      expect.objectContaining({
        campaignId: CAMPAIGN_ID,
        brandId: BRAND_ID,
        workflowName: WORKFLOW_NAME,
      })
    );
  });

  it("header values override body brandId/campaignId on checkout/create", async () => {
    const res = await request(app)
      .post("/checkout/create")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .set("x-campaign-id", "header-campaign")
      .set("x-brand-id", "header-brand")
      .send({
        brandId: "body-brand",
        campaignId: "body-campaign",
        lineItems: [{ priceId: "price_123", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

    expect(res.status).toBe(200);

    const { createRun } = await import("../../src/lib/runs-client");
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: "header-brand",
        campaignId: "header-campaign",
      })
    );
  });

  it("falls back to body values when headers absent on checkout/create", async () => {
    const res = await request(app)
      .post("/checkout/create")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .send({
        brandId: "body-brand",
        campaignId: "body-campaign",
        lineItems: [{ priceId: "price_123", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

    expect(res.status).toBe(200);

    const { createRun } = await import("../../src/lib/runs-client");
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: "body-brand",
        campaignId: "body-campaign",
      })
    );
  });

  it("forwards workflow headers to resolveStripeKey on payment-intent/create", async () => {
    const res = await request(app)
      .post("/payment-intent/create")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .set("x-campaign-id", CAMPAIGN_ID)
      .set("x-brand-id", BRAND_ID)
      .set("x-workflow-name", WORKFLOW_NAME)
      .send({ amountInCents: 5000 });

    expect(res.status).toBe(200);

    const { resolveStripeKey } = await import("../../src/lib/resolve-stripe-key");
    expect(resolveStripeKey).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      expect.objectContaining({
        campaignId: CAMPAIGN_ID,
        brandId: BRAND_ID,
        workflowName: WORKFLOW_NAME,
      })
    );
  });

  it("works normally without workflow headers (backward compat)", async () => {
    const res = await request(app)
      .post("/checkout/create")
      .set("X-API-Key", API_KEY)
      .set("x-org-id", ORG_ID)
      .set("x-user-id", USER_ID)
      .set("x-run-id", RUN_ID)
      .send({
        lineItems: [{ priceId: "price_123", quantity: 1 }],
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
