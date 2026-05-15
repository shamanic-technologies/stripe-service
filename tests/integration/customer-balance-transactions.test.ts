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
    typeof e === "object" &&
    e !== null &&
    "statusCode" in (e as Record<string, unknown>) &&
    (e as { statusCode?: number }).statusCode === 404,
}));
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn().mockResolvedValue({ key: "sk_test_xxx", keySource: "platform" }),
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

describe("GET /v1/balance_transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.customers.listBalanceTransactions.mockReset();
  });

  it("returns Stripe-shape list from DB when rows present", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_X" }]);
    dbMock.queueSelect("customer_balance_transactions", [
      {
        id: "cbtxn_a",
        customer: "cus_X",
        orgId: TEST_ORG_ID,
        rawJson: {
          id: "cbtxn_a",
          object: "customer_balance_transaction",
          amount: -2500,
          currency: "usd",
          type: "adjustment",
          customer: "cus_X",
          credit_note: null,
          invoice: null,
          created: 1700000000,
        },
      },
      {
        id: "cbtxn_b",
        customer: "cus_X",
        orgId: TEST_ORG_ID,
        rawJson: {
          id: "cbtxn_b",
          object: "customer_balance_transaction",
          amount: 500,
          currency: "usd",
          type: "applied_to_invoice",
          customer: "cus_X",
          credit_note: null,
          invoice: "in_1",
          created: 1700001000,
        },
      },
    ]);

    const res = await request(app)
      .get("/v1/balance_transactions?limit=10")
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.url).toBe("/v1/balance_transactions");
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBe("cbtxn_a");
    expect(res.body.data[0].amount).toBe(-2500);
    expect(res.body.has_more).toBe(false);
    expect(stripeMock.customers.listBalanceTransactions).not.toHaveBeenCalled();
  });

  it("respects limit and sets has_more=true", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_X" }]);
    dbMock.queueSelect("customer_balance_transactions", [
      { id: "cbtxn_a", rawJson: { id: "cbtxn_a", object: "customer_balance_transaction" } },
      { id: "cbtxn_b", rawJson: { id: "cbtxn_b", object: "customer_balance_transaction" } },
      { id: "cbtxn_c", rawJson: { id: "cbtxn_c", object: "customer_balance_transaction" } },
    ]);

    const res = await request(app)
      .get("/v1/balance_transactions?limit=2")
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.has_more).toBe(true);
  });

  it("falls back to Stripe and upserts when DB miss", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_X" }]);
    dbMock.queueSelect("customer_balance_transactions", []);
    stripeMock.customers.listBalanceTransactions.mockResolvedValueOnce({
      object: "list",
      data: [
        {
          id: "cbtxn_remote",
          object: "customer_balance_transaction",
          amount: -1000,
          currency: "usd",
          type: "adjustment",
          customer: "cus_X",
          credit_note: null,
          invoice: null,
          created: 1700002000,
          livemode: false,
        },
      ],
      has_more: false,
      url: "/v1/customers/cus_X/balance_transactions",
    });

    const res = await request(app)
      .get("/v1/balance_transactions?limit=10")
      .set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("cbtxn_remote");
    expect(stripeMock.customers.listBalanceTransactions).toHaveBeenCalledWith(
      "cus_X",
      expect.objectContaining({ limit: 10 })
    );
  });

  it("returns 404 when org has no Stripe customer", async () => {
    dbMock.queueSelect("customers", []);

    const res = await request(app).get("/v1/balance_transactions").set(authHeaders());

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Stripe customer");
    expect(stripeMock.customers.listBalanceTransactions).not.toHaveBeenCalled();
  });

  it("rejects 401 when X-API-Key missing", async () => {
    const res = await request(app)
      .get("/v1/balance_transactions")
      .set("x-org-id", TEST_ORG_ID)
      .set("x-user-id", "user_test");
    expect(res.status).toBe(401);
  });

  it("rejects 403 when X-API-Key wrong", async () => {
    const res = await request(app)
      .get("/v1/balance_transactions")
      .set("X-API-Key", "wrong-key")
      .set("x-org-id", TEST_ORG_ID)
      .set("x-user-id", "user_test");
    expect(res.status).toBe(403);
  });

  it("rejects 400 when x-org-id missing", async () => {
    const res = await request(app)
      .get("/v1/balance_transactions")
      .set("X-API-Key", "test-secret-key")
      .set("x-user-id", "user_test");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });
});
