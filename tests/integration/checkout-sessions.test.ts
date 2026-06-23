import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { authHeaders, TEST_ORG_ID } from "../helpers/mocks";

const { dbMock, stripeMock } = vi.hoisted(() => {
  const { makeDbMock, makeStripeMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi), stripeMock: makeStripeMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
vi.mock("../../src/lib/stripe-client", () => ({
  makeStripeClient: () => stripeMock,
  getWebhookClient: vi.fn(),
  constructWebhookEvent: vi.fn(),
  isStripeError: (e: unknown) => e instanceof Error,
  stripeErrorStatus: () => 500,
  isResourceMissing: (e: unknown) =>
    typeof e === "object" && e !== null && (e as { statusCode?: number }).statusCode === 404,
}));
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn().mockResolvedValue({ key: "sk_test_xxx", keySource: "platform" }),
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

describe("POST /v1/checkout/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.checkout.sessions.create.mockReset();
  });

  it("creates a checkout session", async () => {
    stripeMock.checkout.sessions.create.mockResolvedValueOnce({
      id: "cs_test_123",
      object: "checkout.session",
      mode: "payment",
      url: "https://checkout.stripe.com/x",
      customer: "cus_x",
      payment_intent: null,
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send({
        mode: "payment",
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        customer: "cus_x",
        line_items: [{ price: "price_1", quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("cs_test_123");
    expect(res.body.url).toBe("https://checkout.stripe.com/x");
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        customer: "cus_x",
        metadata: expect.objectContaining({ org_id: TEST_ORG_ID }),
      }),
      undefined
    );
  });

  it("creates a setup-mode session with no line_items (card capture)", async () => {
    stripeMock.checkout.sessions.create.mockResolvedValueOnce({
      id: "cs_setup_1",
      object: "checkout.session",
      mode: "setup",
      url: "https://checkout.stripe.com/setup",
      customer: "cus_x",
      setup_intent: "seti_123",
      payment_intent: null,
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send({
        mode: "setup",
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        customer: "cus_x",
        metadata: { purpose: "auto_topup_card_capture" },
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("cs_setup_1");
    expect(res.body.setup_intent).toBe("seti_123");

    const [params] = stripeMock.checkout.sessions.create.mock.calls[0];
    expect(params.mode).toBe("setup");
    expect(params).not.toHaveProperty("line_items");
    expect(params.metadata).toEqual(
      expect.objectContaining({ org_id: TEST_ORG_ID, purpose: "auto_topup_card_capture" })
    );
  });

  it("creates an embedded session without success_url and returns client_secret", async () => {
    stripeMock.checkout.sessions.create.mockResolvedValueOnce({
      id: "cs_embedded_1",
      object: "checkout.session",
      mode: "payment",
      ui_mode: "embedded",
      url: null,
      client_secret: "cs_embedded_1_secret_abc",
      customer: "cus_x",
      payment_intent: "pi_123",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send({
        mode: "payment",
        ui_mode: "embedded",
        redirect_on_completion: "never",
        payment_intent_data: { setup_future_usage: "off_session" },
        customer: "cus_x",
        line_items: [{ price: "price_1", quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("cs_embedded_1");
    expect(res.body.client_secret).toBe("cs_embedded_1_secret_abc");
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        ui_mode: "embedded",
        redirect_on_completion: "never",
        payment_intent_data: { setup_future_usage: "off_session" },
        customer: "cus_x",
        metadata: expect.objectContaining({ org_id: TEST_ORG_ID }),
      }),
      undefined
    );
    const [params] = stripeMock.checkout.sessions.create.mock.calls[0];
    expect(params).not.toHaveProperty("success_url");
  });

  it("rejects hosted (non-embedded) mode without success_url", async () => {
    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send({
        mode: "payment",
        customer: "cus_x",
        line_items: [{ price: "price_1", quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects payment mode without line_items (unchanged)", async () => {
    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send({
        mode: "payment",
        success_url: "https://example.com/success",
        customer: "cus_x",
      });

    expect(res.status).toBe(400);
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("rejects setup mode with line_items (Stripe forbids it)", async () => {
    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send({
        mode: "setup",
        success_url: "https://example.com/success",
        customer: "cus_x",
        line_items: [{ price: "price_1", quantity: 1 }],
      });

    expect(res.status).toBe(400);
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("GET /v1/checkout/sessions/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.checkout.sessions.retrieve.mockReset();
  });

  it("returns DB hit", async () => {
    dbMock.queueSelect("checkout_sessions", [
      { id: "cs_db", orgId: TEST_ORG_ID, rawJson: { id: "cs_db", object: "checkout.session" } },
    ]);

    const res = await request(app).get("/v1/checkout/sessions/cs_db").set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("cs_db");
    expect(stripeMock.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  it("falls back to Stripe on miss", async () => {
    dbMock.queueSelect("checkout_sessions", []);
    stripeMock.checkout.sessions.retrieve.mockResolvedValueOnce({
      id: "cs_remote",
      object: "checkout.session",
      mode: "payment",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app).get("/v1/checkout/sessions/cs_remote").set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("cs_remote");
    expect(stripeMock.checkout.sessions.retrieve).toHaveBeenCalledWith("cs_remote");
  });
});

describe("GET /v1/checkout/sessions (list)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns Stripe-shape list filtered by customer", async () => {
    dbMock.queueSelect("checkout_sessions", [
      { id: "cs_a", rawJson: { id: "cs_a", object: "checkout.session" } },
    ]);

    const res = await request(app)
      .get("/v1/checkout/sessions?customer=cus_x&limit=10")
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.data).toHaveLength(1);
  });
});
