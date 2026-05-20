import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { TEST_ORG_ID } from "../helpers/mocks";

const { dbMock, constructWebhookEventMock, platformStripeMock, makeStripeClientMock } =
  vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeDbMock, makeStripeMock } = require("../helpers/mocks-factory.cjs");
    const stripe = makeStripeMock(vi);
    // Augment with setupIntents + paymentMethods — promote-default-pm uses both.
    stripe.setupIntents = { retrieve: vi.fn() };
    stripe.paymentMethods = { retrieve: vi.fn(), attach: vi.fn() };
    return {
      dbMock: makeDbMock(vi),
      constructWebhookEventMock: vi.fn(),
      platformStripeMock: stripe,
      makeStripeClientMock: vi.fn(() => stripe),
    };
  });

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
vi.mock("../../src/lib/stripe-client", () => ({
  makeStripeClient: (...args: unknown[]) => makeStripeClientMock(...args),
  getWebhookClient: vi.fn(),
  constructWebhookEvent: (...args: unknown[]) => constructWebhookEventMock(...args),
  isStripeError: (e: unknown) => e instanceof Error,
  stripeErrorStatus: () => 500,
  isResourceMissing: () => false,
}));
vi.mock("../../src/lib/key-client", () => ({
  resolvePlatformKey: vi.fn(async (provider: string) => ({
    provider,
    key: provider === "stripe-webhook" ? "whsec_test_fake" : "sk_test_platform_fake",
  })),
  getDecryptedStripeKey: vi.fn(),
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

beforeEach(() => {
  vi.clearAllMocks();
  constructWebhookEventMock.mockReset();
  platformStripeMock.customers.retrieve.mockReset();
  platformStripeMock.customers.update.mockReset();
  platformStripeMock.paymentIntents.retrieve.mockReset();
  platformStripeMock.setupIntents.retrieve.mockReset();
  platformStripeMock.paymentMethods.retrieve.mockReset();
  platformStripeMock.paymentMethods.attach.mockReset();
});

describe("POST /v1/webhooks", () => {
  it("rejects when signature header is missing", async () => {
    const res = await request(app)
      .post("/v1/webhooks")
      .set("Content-Type", "application/json")
      .send({ foo: "bar" });
    expect(res.status).toBe(400);
  });

  it("rejects when signature verification fails", async () => {
    constructWebhookEventMock.mockImplementationOnce(() => {
      throw new Error("Webhook signature verification failed");
    });

    const res = await request(app)
      .post("/v1/webhooks")
      .set("stripe-signature", "bad-sig")
      .set("Content-Type", "application/json")
      .send({ foo: "bar" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid signature");
  });

  it("processes a valid webhook and persists event row", async () => {
    constructWebhookEventMock.mockReturnValueOnce({
      id: "evt_test_1",
      type: "customer.created",
      api_version: "2024-12-18",
      livemode: false,
      created: 1700000000,
      data: {
        object: {
          id: "cus_evt_1",
          object: "customer",
          email: "evt@example.com",
          metadata: { org_id: TEST_ORG_ID },
          created: 1700000000,
          livemode: false,
        },
      },
    });
    dbMock.queueInsert("events", [{ id: "evt_test_1" }]);

    const res = await request(app)
      .post("/v1/webhooks")
      .set("stripe-signature", "t=123,v1=abc")
      .set("Content-Type", "application/json")
      .send({ id: "evt_test_1" });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(dbMock.db.insert).toHaveBeenCalled();
  });

  it("idempotent: duplicate event yields no second processing", async () => {
    constructWebhookEventMock.mockReturnValueOnce({
      id: "evt_dup",
      type: "customer.updated",
      api_version: "2024-12-18",
      livemode: false,
      created: 1700000001,
      data: {
        object: {
          id: "cus_dup",
          object: "customer",
          metadata: { org_id: TEST_ORG_ID },
          created: 1700000001,
          livemode: false,
        },
      },
    });
    // ON CONFLICT DO NOTHING returns empty when row already exists
    dbMock.queueInsert("events", []);

    const res = await request(app)
      .post("/v1/webhooks")
      .set("stripe-signature", "t=123,v1=abc")
      .set("Content-Type", "application/json")
      .send({ id: "evt_dup" });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it("checkout.session.completed promotes default PM when customer has none", async () => {
    constructWebhookEventMock.mockReturnValueOnce({
      id: "evt_promote",
      type: "checkout.session.completed",
      api_version: "2024-12-18",
      livemode: false,
      created: 1700000002,
      data: {
        object: {
          id: "cs_promote",
          object: "checkout.session",
          mode: "payment",
          customer: "cus_promote",
          payment_intent: "pi_promote",
          metadata: { org_id: TEST_ORG_ID },
          livemode: false,
          created: 1700000002,
        },
      },
    });
    dbMock.queueInsert("events", [{ id: "evt_promote" }]);
    platformStripeMock.paymentIntents.retrieve.mockResolvedValueOnce({
      id: "pi_promote",
      payment_method: "pm_promote",
    });
    platformStripeMock.customers.retrieve.mockResolvedValueOnce({
      id: "cus_promote",
      object: "customer",
      deleted: false,
      invoice_settings: { default_payment_method: null },
      metadata: { org_id: TEST_ORG_ID },
    });
    platformStripeMock.paymentMethods.retrieve.mockResolvedValueOnce({
      id: "pm_promote",
      customer: "cus_promote",
    });
    platformStripeMock.customers.update.mockResolvedValueOnce({
      id: "cus_promote",
      object: "customer",
      email: null,
      name: null,
      description: null,
      phone: null,
      metadata: { org_id: TEST_ORG_ID },
      livemode: false,
      created: 1700000002,
      invoice_settings: { default_payment_method: "pm_promote" },
    });

    const res = await request(app)
      .post("/v1/webhooks")
      .set("stripe-signature", "t=123,v1=abc")
      .set("Content-Type", "application/json")
      .send({ id: "evt_promote" });

    expect(res.status).toBe(200);
    expect(platformStripeMock.paymentIntents.retrieve).toHaveBeenCalledWith("pi_promote");
    expect(platformStripeMock.customers.retrieve).toHaveBeenCalledWith("cus_promote");
    expect(platformStripeMock.customers.update).toHaveBeenCalledWith("cus_promote", {
      invoice_settings: { default_payment_method: "pm_promote" },
    });
  });

  it("checkout.session.completed is a no-op when default PM already set", async () => {
    constructWebhookEventMock.mockReturnValueOnce({
      id: "evt_noop",
      type: "checkout.session.completed",
      api_version: "2024-12-18",
      livemode: false,
      created: 1700000003,
      data: {
        object: {
          id: "cs_noop",
          object: "checkout.session",
          mode: "payment",
          customer: "cus_noop",
          payment_intent: "pi_noop",
          metadata: { org_id: TEST_ORG_ID },
          livemode: false,
          created: 1700000003,
        },
      },
    });
    dbMock.queueInsert("events", [{ id: "evt_noop" }]);
    platformStripeMock.paymentIntents.retrieve.mockResolvedValueOnce({
      id: "pi_noop",
      payment_method: "pm_noop",
    });
    platformStripeMock.customers.retrieve.mockResolvedValueOnce({
      id: "cus_noop",
      object: "customer",
      deleted: false,
      invoice_settings: { default_payment_method: "pm_existing" },
      metadata: { org_id: TEST_ORG_ID },
    });

    const res = await request(app)
      .post("/v1/webhooks")
      .set("stripe-signature", "t=123,v1=abc")
      .set("Content-Type", "application/json")
      .send({ id: "evt_noop" });

    expect(res.status).toBe(200);
    expect(platformStripeMock.customers.update).not.toHaveBeenCalled();
  });
});
