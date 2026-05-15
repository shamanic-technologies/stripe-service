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

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total_paid_cents: "12500",
      accounts_with_payment_method: 3,
      monthly_growth: [
        { period: "2026-04-01", paid_cents: "5000" },
        { period: "2026-05-01", paid_cents: "7500" },
      ],
      weekly_growth: [
        { period: "2026-05-04", paid_cents: "2500" },
        { period: "2026-05-11", paid_cents: "5000" },
      ],
    });
  });

  it("returns zero values when no data", async () => {
    dbMock.queueSelect("payment_intents", [{ total: null }]);
    dbMock.queueSelect("customers", [{ count: "0" }]);
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("payment_intents", []);

    const res = await request(app).get("/public/stats/billing");

    expect(res.status).toBe(200);
    expect(res.body.total_paid_cents).toBe("0");
    expect(res.body.accounts_with_payment_method).toBe(0);
    expect(res.body.monthly_growth).toEqual([]);
    expect(res.body.weekly_growth).toEqual([]);
  });
});
