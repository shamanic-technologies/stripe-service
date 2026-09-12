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
      total_paying_accounts: 0,
      monthly_growth: [
        {
          period: "2026-04-01",
          paid_cents: "5000",
          refunded_cents: "0",
          disputed_lost_cents: "0",
          returned_cents: "0",
          net_cents: "5000",
          paying_accounts: 0,
          first_time_paying_accounts: 0,
        },
        {
          period: "2026-05-01",
          paid_cents: "7500",
          refunded_cents: "0",
          disputed_lost_cents: "0",
          returned_cents: "0",
          net_cents: "7500",
          paying_accounts: 0,
          first_time_paying_accounts: 0,
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
          paying_accounts: 0,
          first_time_paying_accounts: 0,
        },
        {
          period: "2026-05-11",
          paid_cents: "5000",
          refunded_cents: "0",
          disputed_lost_cents: "0",
          returned_cents: "0",
          net_cents: "5000",
          paying_accounts: 0,
          first_time_paying_accounts: 0,
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
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
      {
        period: "2026-05-01",
        paid_cents: "7500",
        refunded_cents: "1500",
        disputed_lost_cents: "1000",
        returned_cents: "2500",
        net_cents: "5000",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
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
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
      {
        period: "2026-05-11",
        paid_cents: "5000",
        refunded_cents: "1500",
        disputed_lost_cents: "0",
        returned_cents: "1500",
        net_cents: "3500",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
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
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
      {
        period: "2026-05-01",
        paid_cents: "0",
        refunded_cents: "5000",
        disputed_lost_cents: "0",
        returned_cents: "5000",
        net_cents: "-5000",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
    ]);
  });

  /**
   * Queue the two Revolut reads in the order they are consumed.
   *
   * Both hit `revolut_orders`, so the mock serves them FIFO. The route awaits
   * `platformReturns()` (whose own Promise.all fires the refund read first) and
   * `revolutPlatformPaid()` together, so returns come out before payments.
   */
  function queueRevolut(
    refundRows: ReturnType<typeof returnRow>[],
    paymentRows: ReturnType<typeof returnRow>[]
  ) {
    dbMock.queueSelect("revolut_orders", refundRows);
    dbMock.queueSelect("revolut_orders", paymentRows);
  }

  it("counts money taken through EVERY acquirer, not only the first one", async () => {
    // Stripe: 12500 gross, of which 1500 came back as a settled refund.
    dbMock.queueSelect("payment_intents", [{ total: "12500" }]);
    dbMock.queueSelect("customers", [{ count: "3" }]);
    dbMock.queueSelect("payment_intents", [
      { period: new Date("2026-08-01T00:00:00Z"), paid_cents: "12500" },
    ]);
    dbMock.queueSelect("payment_intents", [
      { period: new Date("2026-08-24T00:00:00Z"), paid_cents: "12500" },
    ]);
    dbMock.queueSelect("refunds", [returnRow("2026-08-01", "2026-08-24", "1500")]);
    dbMock.queueSelect("disputes", []);
    // Revolut: a 50000 completed payment in the same month, no return.
    queueRevolut([], [returnRow("2026-08-01", "2026-08-31", "50000")]);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    // Gross spans both acquirers; the Revolut money is no longer invisible.
    expect(res.body.total_paid_cents).toBe("62500");
    expect(res.body.total_refunded_cents).toBe("1500");
    expect(res.body.total_returned_cents).toBe("1500");
    expect(res.body.total_net_cents).toBe("61000");

    // Buckets still sum to the all-time totals, on both grains.
    const sum = (rows: { paid_cents: string }[]) =>
      rows.reduce((acc, r) => acc + BigInt(r.paid_cents), 0n).toString();
    expect(sum(res.body.monthly_growth)).toBe("62500");
    expect(sum(res.body.weekly_growth)).toBe("62500");

    // Both acquirers' August payments land in the SAME month bucket.
    expect(res.body.monthly_growth).toEqual([
      {
        period: "2026-08-01",
        paid_cents: "62500",
        refunded_cents: "1500",
        disputed_lost_cents: "0",
        returned_cents: "1500",
        net_cents: "61000",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
    ]);
    expect(res.body.weekly_growth).toEqual([
      {
        period: "2026-08-24",
        paid_cents: "12500",
        refunded_cents: "1500",
        disputed_lost_cents: "0",
        returned_cents: "1500",
        net_cents: "11000",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
      {
        period: "2026-08-31",
        paid_cents: "50000",
        refunded_cents: "0",
        disputed_lost_cents: "0",
        returned_cents: "0",
        net_cents: "50000",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
    ]);
  });

  it("gives a period with a second-acquirer return and no payment a negative net", async () => {
    dbMock.queueSelect("payment_intents", [{ total: "0" }]);
    dbMock.queueSelect("customers", [{ count: "0" }]);
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);
    // August took 50000 through Revolut; September gave 20000 of it back, and
    // took nothing. A return belongs to the month it HAPPENED in.
    queueRevolut(
      [returnRow("2026-09-01", "2026-09-07", "20000")],
      [returnRow("2026-08-01", "2026-08-31", "50000")]
    );

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_paid_cents).toBe("50000");
    expect(res.body.total_refunded_cents).toBe("20000");
    expect(res.body.total_returned_cents).toBe("20000");
    expect(res.body.total_net_cents).toBe("30000");
    expect(res.body.monthly_growth).toEqual([
      {
        period: "2026-08-01",
        paid_cents: "50000",
        refunded_cents: "0",
        disputed_lost_cents: "0",
        returned_cents: "0",
        net_cents: "50000",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
      {
        period: "2026-09-01",
        paid_cents: "0",
        refunded_cents: "20000",
        disputed_lost_cents: "0",
        returned_cents: "20000",
        net_cents: "-20000",
        paying_accounts: 0,
        first_time_paying_accounts: 0,
      },
    ]);
  });

  /** A row of the grouped paying-account query, one per (grain, period). */
  function accountRow(
    grain: string,
    period: string | null,
    paying: number,
    firstTime: number
  ) {
    return {
      grain,
      period: period === null ? null : new Date(`${period}T00:00:00Z`),
      paying,
      first_time: firstTime,
    };
  }

  it("publishes how many accounts paid, and how many paid for the first time", async () => {
    dbMock.queueSelect("payment_intents", [{ total: "62500" }]);
    dbMock.queueSelect("customers", [{ count: "3" }]);
    dbMock.queueSelect("payment_intents", [
      { period: new Date("2026-07-01T00:00:00Z"), paid_cents: "12500" },
      { period: new Date("2026-08-01T00:00:00Z"), paid_cents: "50000" },
    ]);
    dbMock.queueSelect("payment_intents", [
      { period: new Date("2026-08-24T00:00:00Z"), paid_cents: "62500" },
    ]);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);
    // 5 accounts have ever paid; 3 of them paid for the first time in July,
    // 2 more in August; the week of 2026-08-24 saw 4 of them, 2 new.
    dbMock.queueExecute([
      accountRow("total", null, 5, 5),
      accountRow("month", "2026-07-01", 3, 3),
      accountRow("month", "2026-08-01", 4, 2),
      accountRow("week", "2026-08-24", 4, 2),
    ]);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_paying_accounts).toBe(5);
    // Who PAID is a different question from who has a Stripe card saved, and
    // the two figures are published side by side without being conflated.
    expect(res.body.accounts_with_payment_method).toBe(3);

    expect(res.body.monthly_growth).toEqual([
      {
        period: "2026-07-01",
        paid_cents: "12500",
        refunded_cents: "0",
        disputed_lost_cents: "0",
        returned_cents: "0",
        net_cents: "12500",
        paying_accounts: 3,
        first_time_paying_accounts: 3,
      },
      {
        period: "2026-08-01",
        paid_cents: "50000",
        refunded_cents: "0",
        disputed_lost_cents: "0",
        returned_cents: "0",
        net_cents: "50000",
        paying_accounts: 4,
        first_time_paying_accounts: 2,
      },
    ]);
    expect(res.body.weekly_growth[0]).toMatchObject({
      period: "2026-08-24",
      paying_accounts: 4,
      first_time_paying_accounts: 2,
    });

    // The AC the consumer checks: first-timers summed over every period are
    // exactly the accounts that have ever paid, on either grain.
    const firstTimers = (rows: { first_time_paying_accounts: number }[]) =>
      rows.reduce((acc, r) => acc + r.first_time_paying_accounts, 0);
    expect(firstTimers(res.body.monthly_growth)).toBe(5);
    expect(firstTimers(res.body.weekly_growth)).toBe(res.body.total_paying_accounts - 3);
  });

  it("emits a bucket whose money has no attributable account with real zeros", async () => {
    // A payment we cannot tie to an org still counts as MONEY — the totals are
    // unchanged — but it is not an account we can name, so it counts as none.
    dbMock.queueSelect("payment_intents", [{ total: "30000" }]);
    dbMock.queueSelect("customers", [{ count: "0" }]);
    dbMock.queueSelect("payment_intents", [
      { period: new Date("2026-07-01T00:00:00Z"), paid_cents: "30000" },
    ]);
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);
    dbMock.queueExecute([accountRow("total", null, 0, 0)]);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_paid_cents).toBe("30000");
    expect(res.body.total_paying_accounts).toBe(0);
    expect(res.body.monthly_growth[0]).toMatchObject({
      paid_cents: "30000",
      paying_accounts: 0,
      first_time_paying_accounts: 0,
    });
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
    expect(res.body.total_paying_accounts).toBe(0);
    expect(res.body.monthly_growth).toEqual([]);
    expect(res.body.weekly_growth).toEqual([]);
  });
});
