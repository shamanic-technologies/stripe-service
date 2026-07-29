import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock, makeStripeMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi), stripeMock: makeStripeMock(vi) };
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
vi.mock("../../src/lib/resolve-stripe-key", () => ({
  resolveStripeKey: vi.fn(),
}));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

/** A (month, week, cents) row as the grouped returns query yields it. */
function returnRow(month: string, week: string, cents: string) {
  return {
    month: new Date(`${month}T00:00:00Z`),
    week: new Date(`${week}T00:00:00Z`),
    cents,
  };
}

describe("GET /public/stats/billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 without any auth or identity headers", async () => {
    // total_paid_cents aggregate (single row)
    dbMock.queueSelect("payment_intents", [{ total: "12500" }]);
    // accounts_with_payment_method count
    dbMock.queueSelect("customers", [{ count: "3" }]);
    // monthly_growth
    dbMock.queueSelect("payment_intents", [
      { period: new Date("2026-04-01T00:00:00Z"), paid_cents: "5000" },
      { period: new Date("2026-05-01T00:00:00Z"), paid_cents: "7500" },
    ]);
    // weekly_growth
    dbMock.queueSelect("payment_intents", [
      { period: new Date("2026-05-04T00:00:00Z"), paid_cents: "2500" },
      { period: new Date("2026-05-11T00:00:00Z"), paid_cents: "5000" },
    ]);
    // no refunds, no disputes
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total_paid_cents: "12500",
      total_refunded_cents: "0",
      total_disputed_lost_cents: "0",
      total_returned_cents: "0",
      // Nothing returned: net is byte-identical to gross, no regression.
      total_net_cents: "12500",
      accounts_with_payment_method: 3,
      monthly_growth: [
        {
          period: "2026-04-01",
          paid_cents: "5000",
          refunded_cents: "0",
          disputed_lost_cents: "0",
          returned_cents: "0",
          net_cents: "5000",
        },
        {
          period: "2026-05-01",
          paid_cents: "7500",
          refunded_cents: "0",
          disputed_lost_cents: "0",
          returned_cents: "0",
          net_cents: "7500",
        },
      ],
      weekly_growth: [
        {
          period: "2026-05-04",
          paid_cents: "2500",
          refunded_cents: "0",
          disputed_lost_cents: "0",
          returned_cents: "0",
          net_cents: "2500",
        },
        {
          period: "2026-05-11",
          paid_cents: "5000",
          refunded_cents: "0",
          disputed_lost_cents: "0",
          returned_cents: "0",
          net_cents: "5000",
        },
      ],
    });
  });

  it("nets refunds and lost disputes out of the total and the buckets", async () => {
    dbMock.queueSelect("payment_intents", [{ total: "12500" }]);
    dbMock.queueSelect("customers", [{ count: "3" }]);
    dbMock.queueSelect("payment_intents", [
      { period: new Date("2026-04-01T00:00:00Z"), paid_cents: "5000" },
      { period: new Date("2026-05-01T00:00:00Z"), paid_cents: "7500" },
    ]);
    dbMock.queueSelect("payment_intents", [
      { period: new Date("2026-05-04T00:00:00Z"), paid_cents: "2500" },
      { period: new Date("2026-05-11T00:00:00Z"), paid_cents: "5000" },
    ]);
    // A 1500 refund in the week of 2026-05-11, and a 1000 lost dispute in the
    // week of 2026-05-04 — both inside May.
    dbMock.queueSelect("refunds", [returnRow("2026-05-01", "2026-05-11", "1500")]);
    dbMock.queueSelect("disputes", [returnRow("2026-05-01", "2026-05-04", "1000")]);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    // Gross is untouched — revenue still reports the full charged amount.
    expect(res.body.total_paid_cents).toBe("12500");
    expect(res.body.total_refunded_cents).toBe("1500");
    expect(res.body.total_disputed_lost_cents).toBe("1000");
    expect(res.body.total_returned_cents).toBe("2500");
    expect(res.body.total_net_cents).toBe("10000");

    expect(res.body.monthly_growth).toEqual([
      {
        period: "2026-04-01",
        paid_cents: "5000",
        refunded_cents: "0",
        disputed_lost_cents: "0",
        returned_cents: "0",
        net_cents: "5000",
      },
      {
        period: "2026-05-01",
        paid_cents: "7500",
        refunded_cents: "1500",
        disputed_lost_cents: "1000",
        returned_cents: "2500",
        net_cents: "5000",
      },
    ]);
    expect(res.body.weekly_growth).toEqual([
      {
        period: "2026-05-04",
        paid_cents: "2500",
        refunded_cents: "0",
        disputed_lost_cents: "1000",
        returned_cents: "1000",
        net_cents: "1500",
      },
      {
        period: "2026-05-11",
        paid_cents: "5000",
        refunded_cents: "1500",
        disputed_lost_cents: "0",
        returned_cents: "1500",
        net_cents: "3500",
      },
    ]);
  });

  it("puts a refund in ITS OWN period, leaving the reversed payment's bucket intact", async () => {
    dbMock.queueSelect("payment_intents", [{ total: "5000" }]);
    dbMock.queueSelect("customers", [{ count: "1" }]);
    // April took the payment; nothing was charged in May.
    dbMock.queueSelect("payment_intents", [
      { period: new Date("2026-04-01T00:00:00Z"), paid_cents: "5000" },
    ]);
    dbMock.queueSelect("payment_intents", [
      { period: new Date("2026-04-06T00:00:00Z"), paid_cents: "5000" },
    ]);
    dbMock.queueSelect("refunds", [returnRow("2026-05-01", "2026-05-04", "5000")]);
    dbMock.queueSelect("disputes", []);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_net_cents).toBe("0");
    expect(res.body.monthly_growth).toEqual([
      {
        period: "2026-04-01",
        paid_cents: "5000",
        refunded_cents: "0",
        disputed_lost_cents: "0",
        returned_cents: "0",
        net_cents: "5000",
      },
      {
        period: "2026-05-01",
        paid_cents: "0",
        refunded_cents: "5000",
        disputed_lost_cents: "0",
        returned_cents: "5000",
        net_cents: "-5000",
      },
    ]);
  });

  it("returns zero values when no data", async () => {
    dbMock.queueSelect("payment_intents", [{ total: null }]);
    dbMock.queueSelect("customers", [{ count: "0" }]);
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_paid_cents).toBe("0");
    expect(res.body.total_returned_cents).toBe("0");
    expect(res.body.total_net_cents).toBe("0");
    expect(res.body.accounts_with_payment_method).toBe(0);
    expect(res.body.monthly_growth).toEqual([]);
    expect(res.body.weekly_growth).toEqual([]);
  });
});
