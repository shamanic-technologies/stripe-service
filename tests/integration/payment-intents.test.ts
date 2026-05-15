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

describe("POST /v1/payment_intents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.paymentIntents.create.mockReset();
  });

  it("creates a payment intent and stamps org_id metadata", async () => {
    stripeMock.paymentIntents.create.mockResolvedValueOnce({
      id: "pi_test_1",
      object: "payment_intent",
      amount: 2500,
      currency: "usd",
      status: "requires_payment_method",
      customer: "cus_x",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app)
      .post("/v1/payment_intents")
      .set(authHeaders())
      .send({ amount: 2500, currency: "usd", customer: "cus_x" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("pi_test_1");
    expect(stripeMock.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2500,
        currency: "usd",
        customer: "cus_x",
        metadata: expect.objectContaining({ org_id: TEST_ORG_ID }),
      }),
      undefined
    );
  });

  it("forwards Idempotency-Key header to Stripe SDK", async () => {
    stripeMock.paymentIntents.create.mockResolvedValueOnce({
      id: "pi_idem",
      object: "payment_intent",
      amount: 5000,
      currency: "usd",
      status: "requires_payment_method",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    await request(app)
      .post("/v1/payment_intents")
      .set(authHeaders())
      .set("Idempotency-Key", "pi-idem-xyz")
      .send({ amount: 5000, currency: "usd", customer: "cus_x" });

    expect(stripeMock.paymentIntents.create).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ idempotencyKey: "pi-idem-xyz" })
    );
  });

  it("returns 400 when amount missing", async () => {
    const res = await request(app)
      .post("/v1/payment_intents")
      .set(authHeaders())
      .send({ currency: "usd" });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/payment_intents/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.paymentIntents.retrieve.mockReset();
  });

  it("returns DB hit", async () => {
    dbMock.queueSelect("payment_intents", [
      { id: "pi_db", orgId: TEST_ORG_ID, rawJson: { id: "pi_db", object: "payment_intent" } },
    ]);

    const res = await request(app).get("/v1/payment_intents/pi_db").set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("pi_db");
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("falls back to Stripe on miss", async () => {
    dbMock.queueSelect("payment_intents", []);
    stripeMock.paymentIntents.retrieve.mockResolvedValueOnce({
      id: "pi_remote",
      object: "payment_intent",
      amount: 1000,
      currency: "usd",
      status: "succeeded",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app).get("/v1/payment_intents/pi_remote").set(authHeaders());
    expect(res.status).toBe(200);
    expect(stripeMock.paymentIntents.retrieve).toHaveBeenCalledWith("pi_remote");
  });
});

describe("GET /v1/payment_intents (list)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns list filtered by customer for billing-service reload check", async () => {
    dbMock.queueSelect("payment_intents", [
      {
        id: "pi_a",
        rawJson: { id: "pi_a", object: "payment_intent", amount: 1000, status: "requires_payment_method" },
      },
      {
        id: "pi_b",
        rawJson: { id: "pi_b", object: "payment_intent", amount: 2500, status: "succeeded" },
      },
    ]);

    const res = await request(app)
      .get("/v1/payment_intents?customer=cus_x&limit=20")
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.url).toBe("/v1/payment_intents");
    expect(res.body.data).toHaveLength(2);
  });
});
