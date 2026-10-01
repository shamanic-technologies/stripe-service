import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { authHeaders, TEST_API_KEY, TEST_ORG_ID } from "../helpers/mocks";

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

const createCustomer = vi.fn();
vi.mock("../../src/lib/revolut-client", () => ({
  createOrder: vi.fn(),
  createCustomer: (...a: unknown[]) => createCustomer(...a),
  listCustomerPaymentMethods: vi.fn(),
  getOrder: vi.fn(),
  payOrderWithSavedMethod: vi.fn(),
  cancelOrder: vi.fn(),
  listOrders: vi.fn(),
  listDisputes: vi.fn(),
  RevolutApiError: class RevolutApiError extends Error {},
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();
const apiKeyOnly = { "X-API-Key": TEST_API_KEY };

const NOW = 1790000000;
const TRIAL_END = NOW + 3 * 86400;

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    object: "subscription",
    customer: "cus_org",
    status: "trialing",
    created: NOW,
    trial_start: NOW,
    trial_end: TRIAL_END,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    default_payment_method: "pm_card",
    latest_invoice: "in_trial",
    metadata: { org_id: TEST_ORG_ID, purpose: "subscription" },
    items: {
      data: [
        {
          id: "si_1",
          quantity: 1,
          current_period_start: NOW,
          current_period_end: TRIAL_END,
          price: {
            id: "price_1",
            product: "prod_1",
            currency: "usd",
            unit_amount: 9900,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    ...overrides,
  };
}

function orgCustomer() {
  dbMock.queueSelect("customers", [
    { id: "cus_org", rawJson: { invoice_settings: { default_payment_method: null } } },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  dbMock.clearCaptured();
});

describe("POST /internal/subscriptions/by-org/:orgId/checkout", () => {
  const body = {
    amount: 9900,
    currency: "usd",
    trial_period_days: 3,
    success_url: "https://app.example/billing?ok=1",
    cancel_url: "https://app.example/billing",
  };

  it("creates a monthly subscription checkout with a 3-day trial, card required, org stamped on the subscription", async () => {
    dbMock.queueSelect("org_acquirers", []); // unpinned
    orgCustomer();
    stripeMock.checkout.sessions.create.mockResolvedValueOnce({
      id: "cs_sub",
      object: "checkout.session",
      mode: "subscription",
      url: "https://checkout.stripe.com/c/pay/cs_sub",
      metadata: { org_id: TEST_ORG_ID },
    });

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/checkout`)
      .set({ ...apiKeyOnly, "x-user-id": "user_1", "Idempotency-Key": "sub-ck-1" })
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://checkout.stripe.com/c/pay/cs_sub");
    const [params, opts] = stripeMock.checkout.sessions.create.mock.calls[0];
    expect(params).toMatchObject({
      mode: "subscription",
      customer: "cus_org",
      payment_method_collection: "always",
      success_url: body.success_url,
      line_items: [
        {
          quantity: 1,
          price_data: { currency: "usd", unit_amount: 9900, recurring: { interval: "month" } },
        },
      ],
      subscription_data: {
        trial_period_days: 3,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        metadata: { org_id: TEST_ORG_ID, purpose: "subscription" },
      },
      metadata: { org_id: TEST_ORG_ID, payer_user_id: "user_1" },
    });
    expect(params.ui_mode).toBeUndefined();
    expect(opts).toEqual({ idempotencyKey: "sub-ck-1" });
    // Pinned to STRIPE (never the rollout's acquirer), and no Revolut customer.
    expect(dbMock.lastInsertValues("org_acquirers")).toMatchObject({
      orgId: TEST_ORG_ID,
      acquirer: "stripe",
    });
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it("embedded: answers client_secret and never redirects when no return_url is given", async () => {
    dbMock.queueSelect("org_acquirers", [{ acquirer: "stripe", customerId: null }]); // already pinned
    orgCustomer();
    stripeMock.checkout.sessions.create.mockResolvedValueOnce({
      id: "cs_emb",
      object: "checkout.session",
      client_secret: "cs_emb_secret",
    });

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/checkout`)
      .set(apiKeyOnly)
      .send({ amount: 9900, currency: "USD", trial_period_days: 3, ui_mode: "embedded" });

    expect(res.status).toBe(200);
    expect(res.body.client_secret).toBe("cs_emb_secret");
    const [params] = stripeMock.checkout.sessions.create.mock.calls[0];
    expect(params).toMatchObject({ ui_mode: "embedded", redirect_on_completion: "never" });
    expect(params.line_items[0].price_data.currency).toBe("usd");
    expect(params.metadata.payer_user_id).toBeUndefined();
    // Already pinned -> no second pin write.
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });

  it("refuses an org pinned to the second acquirer with 409 acquirer_not_stripe and no side effect", async () => {
    dbMock.queueSelect("org_acquirers", [{ acquirer: "revolut", customerId: "rev_cus" }]);

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/checkout`)
      .set(apiKeyOnly)
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "acquirer_not_stripe", acquirer: "revolut" });
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });

  it("refuses an org with no Stripe customer with 409 no_customer and pins nothing", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/checkout`)
      .set(apiKeyOnly)
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no_customer");
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });

  it("pins nothing when Stripe refuses the session", async () => {
    dbMock.queueSelect("org_acquirers", []);
    orgCustomer();
    stripeMock.checkout.sessions.create.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { type: "StripeAPIError" })
    );

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/checkout`)
      .set(apiKeyOnly)
      .send(body);

    expect(res.status).toBe(502);
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });

  it("400s a hosted checkout without success_url, and an amount below the minimum", async () => {
    const a = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/checkout`)
      .set(apiKeyOnly)
      .send({ amount: 9900, currency: "usd", trial_period_days: 3 });
    expect(a.status).toBe(400);
    const b = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/checkout`)
      .set(apiKeyOnly)
      .send({ ...body, amount: 10 });
    expect(b.status).toBe(400);
  });
});

describe("POST /v1/checkout/sessions mode=subscription", () => {
  const subBody = {
    mode: "subscription",
    customer: "cus_org",
    success_url: "https://app.example/ok",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 9900,
          recurring: { interval: "month" },
          product_data: { name: "Plan" },
        },
      },
    ],
    subscription_data: { trial_period_days: 3 },
  };

  it("never runs the rollout: an unpinned org at a 100% rollout stays off the second acquirer", async () => {
    dbMock.queueSelect("org_acquirers", []);
    // A 100% rollout row would be read by the rollout; it must not be.
    dbMock.queueSelect("acquirer_rollout", [{ acquirer: "revolut", percent: 100 }]);
    stripeMock.checkout.sessions.create.mockResolvedValueOnce({ id: "cs_v1", object: "checkout.session" });

    const res = await request(app).post("/v1/checkout/sessions").set(authHeaders()).send(subBody);

    expect(res.status).toBe(200);
    expect(createCustomer).not.toHaveBeenCalled();
    const [params] = stripeMock.checkout.sessions.create.mock.calls[0];
    expect(params.subscription_data).toEqual({
      trial_period_days: 3,
      metadata: { org_id: TEST_ORG_ID },
    });
    expect(dbMock.lastInsertValues("org_acquirers")).toMatchObject({ acquirer: "stripe" });
  });

  it("refuses an org pinned to the second acquirer with 409 acquirer_not_stripe", async () => {
    dbMock.queueSelect("org_acquirers", [{ acquirer: "revolut", customerId: "rev_cus" }]);

    const res = await request(app).post("/v1/checkout/sessions").set(authHeaders()).send(subBody);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("acquirer_not_stripe");
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("GET /internal/subscriptions/by-org/:orgId", () => {
  it("returns a definite none for an org with no Stripe customer, without asking Stripe", async () => {
    dbMock.queueSelect("customers", []);

    const res = await request(app).get(`/internal/subscriptions/by-org/${TEST_ORG_ID}`).set(apiKeyOnly);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ object: "list", org_id: TEST_ORG_ID, has_subscription: false, data: [] });
    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
  });

  it("returns a definite none when Stripe answers with no subscription", async () => {
    orgCustomer();
    stripeMock.subscriptions.list.mockResolvedValueOnce({ object: "list", data: [], has_more: false });

    const res = await request(app).get(`/internal/subscriptions/by-org/${TEST_ORG_ID}`).set(apiKeyOnly);

    expect(res.status).toBe(200);
    expect(res.body.has_subscription).toBe(false);
    expect(stripeMock.subscriptions.list).toHaveBeenCalledWith({
      customer: "cus_org",
      status: "all",
      limit: 100,
    });
  });

  it("returns the trialing subscription: trial end, 9900 usd, next charge date, payment method set", async () => {
    orgCustomer();
    stripeMock.subscriptions.list.mockResolvedValueOnce({
      object: "list",
      data: [subscription()],
      has_more: false,
    });

    const res = await request(app).get(`/internal/subscriptions/by-org/${TEST_ORG_ID}`).set(apiKeyOnly);

    expect(res.status).toBe(200);
    expect(res.body.has_subscription).toBe(true);
    expect(res.body.data[0]).toMatchObject({
      object: "subscription_summary",
      id: "sub_1",
      org_id: TEST_ORG_ID,
      status: "trialing",
      trial_end: TRIAL_END,
      current_period_end: TRIAL_END,
      cancel_at_period_end: false,
      amount: 9900,
      currency: "usd",
      interval: "month",
      has_payment_method: true,
      default_payment_method: "pm_card",
    });
  });

  it("falls back to the customer's default payment method", async () => {
    dbMock.queueSelect("customers", [
      { id: "cus_org", rawJson: { invoice_settings: { default_payment_method: "pm_cust" } } },
    ]);
    stripeMock.subscriptions.list.mockResolvedValueOnce({
      object: "list",
      data: [subscription({ default_payment_method: null })],
      has_more: false,
    });

    const res = await request(app).get(`/internal/subscriptions/by-org/${TEST_ORG_ID}`).set(apiKeyOnly);

    expect(res.body.data[0]).toMatchObject({ has_payment_method: true, default_payment_method: "pm_cust" });
  });

  it("502s when Stripe cannot be asked — never an empty list", async () => {
    orgCustomer();
    stripeMock.subscriptions.list.mockRejectedValueOnce(
      Object.assign(new Error("Stripe down"), { type: "StripeConnectionError" })
    );

    const res = await request(app).get(`/internal/subscriptions/by-org/${TEST_ORG_ID}`).set(apiKeyOnly);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("acquirer_unavailable");
  });
});

describe("POST /internal/subscriptions/by-org/:orgId/:id/amount", () => {
  it("re-prices for the NEXT invoice with no proration, same product and interval", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce(subscription({ status: "active" }));
    orgCustomer();
    stripeMock.subscriptions.update.mockResolvedValueOnce(
      subscription({
        status: "active",
        items: {
          data: [
            {
              ...subscription().items.data[0],
              price: { ...subscription().items.data[0].price, id: "price_2", unit_amount: 19900 },
            },
          ],
        },
      })
    );

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/sub_1/amount`)
      .set({ ...apiKeyOnly, "Idempotency-Key": "raise-1" })
      .send({ amount: 19900 });

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(19900);
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith(
      "sub_1",
      {
        items: [
          {
            id: "si_1",
            price_data: {
              currency: "usd",
              product: "prod_1",
              unit_amount: 19900,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
        proration_behavior: "none",
      },
      { idempotencyKey: "raise-1" }
    );
  });

  it("403s a subscription on another org's customer, and changes nothing", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce(
      subscription({ customer: "cus_other", metadata: {} })
    );
    orgCustomer();

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/sub_1/amount`)
      .set(apiKeyOnly)
      .send({ amount: 19900 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("subscription_not_owned");
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
  });

  it("403s a subscription stamped with another org even on a shared customer", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce(
      subscription({ metadata: { org_id: "other-org" } })
    );
    orgCustomer();

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/sub_1/amount`)
      .set(apiKeyOnly)
      .send({ amount: 19900 });

    expect(res.status).toBe(403);
  });

  it("404s an unknown subscription", async () => {
    stripeMock.subscriptions.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("No such subscription"), { statusCode: 404, type: "StripeInvalidRequestError" })
    );

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/sub_nope/amount`)
      .set(apiKeyOnly)
      .send({ amount: 19900 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("subscription_not_found");
  });

  it("409s a subscription that has ended", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce(subscription({ status: "canceled" }));
    orgCustomer();

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/sub_1/amount`)
      .set(apiKeyOnly)
      .send({ amount: 19900 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("subscription_ended");
  });
});

describe("cancellation at period end", () => {
  it("POST sets cancel_at_period_end true", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce(subscription({ status: "active" }));
    orgCustomer();
    stripeMock.subscriptions.update.mockResolvedValueOnce(
      subscription({ status: "active", cancel_at_period_end: true })
    );

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/sub_1/cancellation`)
      .set(apiKeyOnly);

    expect(res.status).toBe(200);
    expect(res.body.cancel_at_period_end).toBe(true);
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
  });

  it("DELETE undoes it", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce(
      subscription({ status: "active", cancel_at_period_end: true })
    );
    orgCustomer();
    stripeMock.subscriptions.update.mockResolvedValueOnce(subscription({ status: "active" }));

    const res = await request(app)
      .delete(`/internal/subscriptions/by-org/${TEST_ORG_ID}/sub_1/cancellation`)
      .set(apiKeyOnly);

    expect(res.status).toBe(200);
    expect(res.body.cancel_at_period_end).toBe(false);
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: false });
  });

  it("is idempotent: already in the asked state -> no Stripe write", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce(
      subscription({ status: "active", cancel_at_period_end: true })
    );
    orgCustomer();

    const res = await request(app)
      .post(`/internal/subscriptions/by-org/${TEST_ORG_ID}/sub_1/cancellation`)
      .set(apiKeyOnly);

    expect(res.status).toBe(200);
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
  });

  it("403s another org's subscription", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce(subscription({ customer: "cus_other", metadata: {} }));
    orgCustomer();

    const res = await request(app)
      .delete(`/internal/subscriptions/by-org/${TEST_ORG_ID}/sub_1/cancellation`)
      .set(apiKeyOnly);

    expect(res.status).toBe(403);
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
  });
});
