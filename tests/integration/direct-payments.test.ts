import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { TEST_API_KEY, TEST_ORG_ID } from "../helpers/mocks";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
vi.mock("../../src/lib/stripe-client", () => ({
  makeStripeClient: vi.fn(),
  getWebhookClient: vi.fn(),
  constructWebhookEvent: vi.fn(),
  isStripeError: () => false,
  stripeErrorStatus: () => 500,
  isResourceMissing: () => false,
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();
const PAYMENT_ID = "2b1f6f3e-8f1a-4d5e-9c1b-0a1b2c3d4e5f";
const RECORDED_AT = new Date("2026-10-02T09:00:00Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    orgId: TEST_ORG_ID,
    amount: 100000,
    currency: "usd",
    note: "October dogfooding",
    recordedBy: "kevin@example.com",
    idempotencyKey: "k-1",
    recordedAt: RECORDED_AT,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    ...overrides,
  };
}

const body = {
  amount: 100000,
  currency: "USD",
  note: "October dogfooding",
  recorded_by: "kevin@example.com",
};

function post(headers: Record<string, string> = { "Idempotency-Key": "k-1" }) {
  return request(app)
    .post(`/internal/direct_payments/by-org/${TEST_ORG_ID}`)
    .set({ "X-API-Key": TEST_API_KEY, ...headers })
    .send(body);
}

describe("POST /internal/direct_payments/by-org/:orgId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.clearQueues();
    dbMock.clearCaptured();
  });


  it("records the payment once, lowercased, never naming an acquirer object", async () => {
    dbMock.queueInsert("direct_payments", [row()]);

    const res = await post();

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      object: "direct_payment",
      id: PAYMENT_ID,
      org_id: TEST_ORG_ID,
      acquirer: "direct",
      amount: 100000,
      currency: "usd",
      note: "October dogfooding",
      recorded_by: "kevin@example.com",
      recorded_at: Math.floor(RECORDED_AT.getTime() / 1000),
      voided_at: null,
      voided_by: null,
      void_reason: null,
    });
    expect(dbMock.lastInsertValues("direct_payments")).toMatchObject({
      orgId: TEST_ORG_ID,
      amount: 100000,
      currency: "usd",
      idempotencyKey: "k-1",
    });
  });

  it("a replay with the same key returns the first record and records nothing new", async () => {
    dbMock.queueInsert("direct_payments", []); // ON CONFLICT DO NOTHING
    dbMock.queueSelect("direct_payments", [row()]);

    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PAYMENT_ID);
  });

  it("refuses the same key for a different amount (409), never merging it", async () => {
    dbMock.queueInsert("direct_payments", []);
    dbMock.queueSelect("direct_payments", [row({ amount: 5000 })]);

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("idempotency_key_reused");
  });

  it("requires an Idempotency-Key", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(dbMock.lastInsertValues("direct_payments")).toBeUndefined();
  });

  it("rejects a zero amount, a bad currency and a missing staff email", async () => {
    for (const bad of [
      { ...body, amount: 0 },
      { ...body, amount: 10.5 },
      { ...body, currency: "dollars" },
      { ...body, recorded_by: undefined },
      { ...body, note: "  " },
    ]) {
      const res = await request(app)
        .post(`/internal/direct_payments/by-org/${TEST_ORG_ID}`)
        .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "k" })
        .send(bad);
      expect(res.status).toBe(400);
    }
    expect(dbMock.lastInsertValues("direct_payments")).toBeUndefined();
  });

  it("requires the service key", async () => {
    const res = await request(app)
      .post(`/internal/direct_payments/by-org/${TEST_ORG_ID}`)
      .set({ "Idempotency-Key": "k" })
      .send(body);
    expect(res.status).toBe(401);
  });
});

describe("POST /internal/direct_payments/by-org/:orgId/:id/void", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.clearQueues();
  });

  const voidIt = (id = PAYMENT_ID) =>
    request(app)
      .post(`/internal/direct_payments/by-org/${TEST_ORG_ID}/${id}/void`)
      .set({ "X-API-Key": TEST_API_KEY })
      .send({ voided_by: "kevin@example.com", reason: "test entry" });

  it("voids a standing payment", async () => {
    const voidedAt = new Date("2026-10-02T10:00:00Z");
    dbMock.queueUpdate("direct_payments", [
      row({ voidedAt, voidedBy: "kevin@example.com", voidReason: "test entry" }),
    ]);

    const res = await voidIt();

    expect(res.status).toBe(200);
    expect(res.body.voided_at).toBe(Math.floor(voidedAt.getTime() / 1000));
    expect(res.body.void_reason).toBe("test entry");
  });

  it("is idempotent: an already-voided payment comes back unchanged", async () => {
    const voidedAt = new Date("2026-10-02T10:00:00Z");
    dbMock.queueUpdate("direct_payments", []);
    dbMock.queueSelect("direct_payments", [row({ voidedAt, voidedBy: "first@example.com" })]);

    const res = await voidIt();

    expect(res.status).toBe(200);
    expect(res.body.voided_by).toBe("first@example.com");
  });

  it("404s a payment the org does not have", async () => {
    dbMock.queueUpdate("direct_payments", []);
    dbMock.queueSelect("direct_payments", []);
    expect((await voidIt()).status).toBe(404);
  });

  it("400s an id that is not a uuid", async () => {
    expect((await voidIt("pi_123")).status).toBe(400);
  });
});

describe("a direct payment counts like any settled payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.clearQueues();
  });

  it("raises the org's payment summary net by exactly its amount", async () => {
    dbMock.queueSelect("payment_intents", [
      { id: "pi_1", currency: "usd", status: "succeeded", amountReceived: 2500, latestCharge: null },
    ]);
    dbMock.queueSelect("customers", [{ id: "cus_1" }]);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);
    dbMock.queueSelect("direct_payments", [{ currency: "usd", total: "100000" }]);

    const res = await request(app)
      .get(`/internal/payment_summary/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY });

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual([
      {
        currency: "usd",
        amount_received: 102500,
        amount_refunded: 0,
        amount_disputed_lost: 0,
        amount_returned: 0,
        amount_net: 102500,
      },
    ]);
  });

  it("appears in the payment history as a settled `direct` payment", async () => {
    dbMock.queueSelect("direct_payments", [row()]);

    const res = await request(app)
      .get(`/internal/payments/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        id: PAYMENT_ID,
        acquirer: "direct",
        amount: 100000,
        currency: "usd",
        status: "succeeded",
        created: Math.floor(RECORDED_AT.getTime() / 1000),
        description: "Direct payment",
        amount_returned: 0,
      },
    ]);
  });

  it("is revenue and credit in the month it was recorded on the public stats", async () => {
    dbMock.queueSelect("payment_intents", [{ total: "0" }]);
    dbMock.queueSelect("customers", [{ count: "0" }]);
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("direct_payments", [
      { month: new Date("2026-10-01T00:00:00Z"), week: new Date("2026-09-28T00:00:00Z"), cents: "100000" },
    ]);
    dbMock.queueExecute([
      { grain: "total", period: null, paying: 1, first_time: 1, first_paid_unix: null },
      { grain: "month", period: new Date("2026-10-01T00:00:00Z"), paying: 1, first_time: 1, first_paid_unix: null },
      { grain: "week", period: new Date("2026-09-28T00:00:00Z"), paying: 1, first_time: 1, first_paid_unix: null },
      { grain: "first", period: null, paying: null, first_time: null, first_paid_unix: 1790931600 },
    ]);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_paid_cents).toBe("100000");
    expect(res.body.total_net_cents).toBe("100000");
    expect(res.body.total_paying_accounts).toBe(1);
    expect(res.body.monthly_growth).toEqual([
      {
        period: "2026-10-01",
        paid_cents: "100000",
        refunded_cents: "0",
        disputed_lost_cents: "0",
        returned_cents: "0",
        net_cents: "100000",
        paying_accounts: 1,
        first_time_paying_accounts: 1,
      },
    ]);
  });
});
