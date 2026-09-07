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
  isResourceMissing: () => false,
}));
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn().mockResolvedValue({ key: "sk_test_xxx", keySource: "platform" }),
}));
vi.mock("../../src/lib/key-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/key-client")>();
  return { ...actual, resolvePlatformKey: vi.fn().mockResolvedValue({ key: "sk_test_platform" }) };
});

const createOrder = vi.fn();
const createCustomer = vi.fn();
const listCustomerPaymentMethods = vi.fn();
vi.mock("../../src/lib/revolut-client", () => ({
  createOrder: (...a: unknown[]) => createOrder(...a),
  createCustomer: (...a: unknown[]) => createCustomer(...a),
  listCustomerPaymentMethods: (...a: unknown[]) => listCustomerPaymentMethods(...a),
  getOrder: vi.fn(),
  payOrderWithSavedMethod: vi.fn(),
  cancelOrder: vi.fn(),
  listOrders: vi.fn(),
  listDisputes: vi.fn(),
}));

const mirrorOrderById = vi.fn();
vi.mock("../../src/lib/revolut-processor", () => ({
  mirrorOrderById: (...a: unknown[]) => mirrorOrderById(...a),
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

const TOPUP = {
  mode: "payment",
  success_url: "https://dashboard.example/billing?done=1",
  cancel_url: "https://dashboard.example/billing",
  customer: "cus_stripe_1",
  metadata: { org_id: TEST_ORG_ID },
  line_items: [
    {
      price_data: {
        currency: "usd",
        product_data: { name: "Distribute credit top-up" },
        unit_amount: 5000,
      },
      quantity: 1,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  dbMock.clearCaptured();
  createOrder.mockResolvedValue({
    id: "ord-1",
    state: "pending",
    checkout_url: "https://checkout.revolut.com/payment-link/tok-1",
  });
  mirrorOrderById.mockResolvedValue(undefined);
});

describe("POST /v1/checkout/sessions dispatches on the org's acquirer", () => {
  it("is untouched for an org nobody has moved — a verbatim Stripe session", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("acquirer_rollout", []);
    stripeMock.checkout.sessions.create.mockResolvedValueOnce({
      id: "cs_test_123",
      object: "checkout.session",
      mode: "payment",
      url: "https://checkout.stripe.com/x",
      customer: "cus_stripe_1",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send(TOPUP);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "cs_test_123", object: "checkout.session" });
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("hands a pinned org a hosted checkout on its own acquirer", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);

    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send(TOPUP);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "checkout",
      acquirer: "revolut",
      id: "ord-1",
      // The one field a caller redirecting a browser reads, named as it always was.
      url: "https://checkout.revolut.com/payment-link/tok-1",
      mode: "payment",
      amount: 5000,
      currency: "USD",
      status: "pending",
    });
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("does the $0 card imprint on that acquirer too", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);

    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send({
        mode: "setup",
        currency: "usd",
        success_url: "https://dashboard.example/billing?done=1",
        cancel_url: "https://dashboard.example/billing",
        customer: "cus_stripe_1",
        metadata: { org_id: TEST_ORG_ID },
      });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("setup");
    expect(res.body.url).toContain("checkout.revolut.com");
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        capture_mode: "manual",
        metadata: expect.objectContaining({ purpose: "card-setup" }),
      })
    );
  });

  it("answers 422 rather than guessing when the acquirer cannot do what was asked", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);

    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send({ ...TOPUP, line_items: [{ price: "price_1", quantity: 1 }] });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/price_data/);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("moves a NEW org when the rollout says so, and never one holding a card", async () => {
    // Selected: no pin, no saved method, inside the share.
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("acquirer_rollout", [{ acquirer: "revolut", percent: 100 }]);
    listCustomerPaymentMethods.mockResolvedValue([]);
    stripeMock.paymentMethods.list.mockResolvedValue({ data: [] });
    dbMock.queueSelect("customers", []); // no Stripe customer -> no card to strand
    dbMock.queueSelect("customers", [{ email: "buyer@example.com", name: "Buyer" }]);
    createCustomer.mockResolvedValue({ id: "cus-rev-new" });

    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send(TOPUP);

    expect(res.status).toBe(200);
    expect(res.body.acquirer).toBe("revolut");
    expect(dbMock.lastInsertValues("org_acquirers")).toMatchObject({
      acquirer: "revolut",
      acquirerCustomerId: "cus-rev-new",
    });
  });

  it("leaves an org that already has a card on Stripe, whatever the rollout says", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("acquirer_rollout", [{ acquirer: "revolut", percent: 100 }]);
    // A live card at the acquirer the org is on today.
    dbMock.queueSelect("customers", [{ id: "cus_stripe_1" }]);
    stripeMock.paymentMethods.list.mockResolvedValue({ data: [{ id: "pm_1", type: "card" }] });
    stripeMock.checkout.sessions.create.mockResolvedValueOnce({
      id: "cs_test_123",
      object: "checkout.session",
      mode: "payment",
      url: "https://checkout.stripe.com/x",
      metadata: { org_id: TEST_ORG_ID },
      created: 1700000000,
      livemode: false,
    });

    const res = await request(app)
      .post("/v1/checkout/sessions")
      .set(authHeaders())
      .send(TOPUP);

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("checkout.session");
    expect(createCustomer).not.toHaveBeenCalled();
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });
});

describe("the rollout control", () => {
  it("reads 0% until somebody sets one", async () => {
    dbMock.queueSelect("acquirer_rollout", []);
    const res = await request(app).get("/internal/acquirer_rollout").set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "acquirer_rollout",
      acquirer: "stripe",
      percent: 0,
    });
  });

  it("is set, and reversed, without a deploy", async () => {
    const on = await request(app)
      .put("/internal/acquirer_rollout")
      .set(authHeaders())
      .send({ acquirer: "revolut", percent: 20 });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ acquirer: "revolut", percent: 20 });

    const off = await request(app)
      .put("/internal/acquirer_rollout")
      .set(authHeaders())
      .send({ acquirer: "revolut", percent: 0 });
    expect(off.status).toBe(200);
    expect(dbMock.lastInsertValues("acquirer_rollout")).toMatchObject({
      id: 1,
      percent: 0,
    });
  });

  it("rejects a share that is not a share", async () => {
    const res = await request(app)
      .put("/internal/acquirer_rollout")
      .set(authHeaders())
      .send({ acquirer: "revolut", percent: 140 });
    expect(res.status).toBe(400);
  });
});
