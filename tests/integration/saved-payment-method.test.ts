import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { TEST_API_KEY, TEST_ORG_ID } from "../helpers/mocks";

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
vi.mock("../../src/lib/key-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/key-client")>();
  return {
    ...actual,
    resolvePlatformKey: vi.fn().mockResolvedValue({ key: "sk_test_platform" }),
  };
});

const revolutMock = vi.hoisted(() => ({
  createOrder: vi.fn(),
  listCustomerPaymentMethods: vi.fn(),
}));
vi.mock("../../src/lib/revolut-client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/lib/revolut-client")
  >();
  return { ...actual, ...revolutMock };
});

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();
const headers = { "X-API-Key": TEST_API_KEY };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  stripeMock.paymentMethods.list.mockReset();
});

function pinnedToRevolut(customerId: string | null = "cus-rev-1") {
  dbMock.queueSelect("org_acquirers", [{ acquirer: "revolut", customerId }]);
}

describe("GET /internal/saved_payment_method/by-org/:orgId", () => {
  it("reports a saved card, with the method a later charge would name", async () => {
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods.mockResolvedValue([
      { id: "pm-rev-1", type: "card", saved_for: "merchant" },
    ]);

    const res = await request(app)
      .get(`/internal/saved_payment_method/by-org/${TEST_ORG_ID}`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "saved_payment_method",
      org_id: TEST_ORG_ID,
      acquirer: "revolut",
      saved: true,
      method: { id: "pm-rev-1", type: "card", saved_for: "merchant" },
    });
  });

  it("reports NO saved card with a reason, and it is a 200 — the acquirer answered", async () => {
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods.mockResolvedValue([]);

    const res = await request(app)
      .get(`/internal/saved_payment_method/by-org/${TEST_ORG_ID}`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      saved: false,
      method: null,
      reason: "no_saved_method",
    });
  });

  it("does NOT answer 'no card' when it could not ask", async () => {
    // The distinction this endpoint exists for. A 200 saying `saved:false`
    // here would tell a caller to go ask the customer for a card they have
    // already given us.
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods.mockRejectedValue(
      new Error("acquirer unreachable")
    );

    const res = await request(app)
      .get(`/internal/saved_payment_method/by-org/${TEST_ORG_ID}`)
      .set(headers);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.saved).toBeUndefined();
  });

  it("answers for a Stripe org from the same read the charge uses", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    stripeMock.paymentMethods.list.mockResolvedValueOnce({
      object: "list",
      data: [{ id: "pm_card_1", object: "payment_method", type: "card" }],
    });

    const res = await request(app)
      .get(`/internal/saved_payment_method/by-org/${TEST_ORG_ID}`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      acquirer: "stripe",
      saved: true,
      method: { id: "pm_card_1" },
    });
    expect(revolutMock.listCustomerPaymentMethods).not.toHaveBeenCalled();
  });

  it("reads a customer the acquirer no longer has as NO CARD, not as an outage", async () => {
    // The acquirer answered, and its answer was definitive. An org whose
    // mirrored customer is gone therefore has no card and nothing to strand.
    // Production, 2026-09-08: this read (and the pin that depends on it) came
    // back 400 `No such customer`, which made the org unmovable forever.
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_gone" }]);
    stripeMock.paymentMethods.list.mockRejectedValueOnce(
      Object.assign(new Error("No such customer: 'cus_gone'"), {
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        statusCode: 400,
      })
    );

    const res = await request(app)
      .get(`/internal/saved_payment_method/by-org/${TEST_ORG_ID}`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      acquirer: "stripe",
      saved: false,
      method: null,
      reason: "no_customer",
    });
  });

  it("reads a Revolut 404 on the customer the same way", async () => {
    pinnedToRevolut();
    const { RevolutApiError } = await import("../../src/lib/revolut-client");
    revolutMock.listCustomerPaymentMethods.mockRejectedValue(
      new RevolutApiError(404, "{}", "Revolut GET /customers/x failed: 404 {}")
    );

    const res = await request(app)
      .get(`/internal/saved_payment_method/by-org/${TEST_ORG_ID}`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ saved: false, reason: "no_customer" });
  });

  it("still refuses to answer when the acquirer is genuinely down", async () => {
    // The never-fail-soft rule is untouched: only the ONE definitive answer
    // above was reclassified. A 500 that is not `resource_missing` is still an
    // unknown, and an unknown is never reported as 'no card'.
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    stripeMock.paymentMethods.list.mockRejectedValueOnce(
      Object.assign(new Error("Stripe is down"), {
        type: "StripeAPIError",
        statusCode: 503,
      })
    );

    const res = await request(app)
      .get(`/internal/saved_payment_method/by-org/${TEST_ORG_ID}`)
      .set(headers);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.saved).toBeUndefined();
  });

  it("answers an unanswerable read as JSON, with no stack and no file paths", async () => {
    // What production returned instead: Express's default HTML error page,
    // carrying a stack with container paths, under the VENDOR's 400 — which
    // told the caller its own request was malformed when it was fine.
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods.mockRejectedValue(
      new Error("socket hang up\n    at Foo (/app/node_modules/x/y.js:11:20)")
    );

    const res = await request(app)
      .get(`/internal/saved_payment_method/by-org/${TEST_ORG_ID}`)
      .set(headers);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(typeof res.body.error).toBe("string");
    expect(res.text).not.toMatch(/node_modules/);
    expect(res.text).not.toMatch(/\bat \w+ \(/);
  });

  it("is server-to-server: X-API-Key, no end-user identity", async () => {
    const res = await request(app).get(
      `/internal/saved_payment_method/by-org/${TEST_ORG_ID}`
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /internal/recurring_charges/by-org/:orgId/authorize", () => {
  it("REFUSES to arm automatic charges for an org with no saved card", async () => {
    // The invariant. An org that pays once and then cannot be charged again is
    // worse than one we never routed to that acquirer: its campaigns stop and
    // nothing reports why.
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods.mockResolvedValue([]);

    const res = await request(app)
      .post(`/internal/recurring_charges/by-org/${TEST_ORG_ID}/authorize`)
      .set(headers);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "no_saved_payment_method",
      reason: "no_saved_method",
      authorized: false,
    });
  });

  it("REFUSES when the only card cannot be charged with nobody present", async () => {
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods.mockResolvedValue([
      { id: "pm-rev-1", type: "card", saved_for: "customer" },
    ]);

    const res = await request(app)
      .post(`/internal/recurring_charges/by-org/${TEST_ORG_ID}/authorize`)
      .set(headers);

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("not_saved_for_merchant");
  });

  it("does not authorize, and does not refuse either, when it could not ask", async () => {
    // A 409 here would read as a decision. It is not one: the answer is
    // unknown, and an unknown answer is not a yes.
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods.mockRejectedValue(
      new Error("timeout")
    );

    const res = await request(app)
      .post(`/internal/recurring_charges/by-org/${TEST_ORG_ID}/authorize`)
      .set(headers);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.authorized).toBeUndefined();
  });

  it("authorizes when a merchant-chargeable card is actually saved", async () => {
    pinnedToRevolut();
    revolutMock.listCustomerPaymentMethods.mockResolvedValue([
      { id: "pm-rev-1", type: "card", saved_for: "merchant" },
    ]);

    const res = await request(app)
      .post(`/internal/recurring_charges/by-org/${TEST_ORG_ID}/authorize`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "recurring_charge_authorization",
      org_id: TEST_ORG_ID,
      acquirer: "revolut",
      authorized: true,
      method: { id: "pm-rev-1", type: "card", saved_for: "merchant" },
    });
  });

  it("leaves the Stripe path exactly as it was", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    stripeMock.paymentMethods.list.mockResolvedValueOnce({
      object: "list",
      data: [{ id: "pm_card_1", object: "payment_method", type: "card" }],
    });

    const res = await request(app)
      .post(`/internal/recurring_charges/by-org/${TEST_ORG_ID}/authorize`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ acquirer: "stripe", authorized: true });
  });
});

describe("POST /internal/card_setup/by-org/:orgId — what the browser gets", () => {
  it("hands over the per-order public token and no merchant credential", async () => {
    pinnedToRevolut();
    revolutMock.createOrder.mockResolvedValue({ id: "ord-1", token: "tok-1" });

    const res = await request(app)
      .post(`/internal/card_setup/by-org/${TEST_ORG_ID}`)
      .set(headers)
      .send({ return_url: "https://dashboard.example/billing" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "card_setup",
      mode: "embedded_widget",
      script_url: "https://merchant.revolut.com/embed.js",
      environment: "prod",
      token: "tok-1",
      save_payment_method_for: "merchant",
    });
    // Nothing secret, and nothing broader than this one setup attempt.
    expect(JSON.stringify(res.body)).not.toContain("sk_test_platform");
  });
});
