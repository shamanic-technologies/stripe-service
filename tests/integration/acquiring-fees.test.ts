import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { TEST_API_KEY } from "../helpers/mocks";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
});

describe("GET /internal/acquiring_fees/monthly", () => {
  it("serves the fees we absorb per org per month, X-API-Key only, no identity", async () => {
    dbMock.queueExecute([
      { org_id: "org-a", acquirer: "stripe", month: "2026-07", currency: "eur", fee: "253", exchange_rate: "0.867574" },
      { org_id: "org-a", acquirer: "stripe", month: "2026-09", currency: "usd", fee: "290" },
      { org_id: "org-a", acquirer: "revolut", month: "2026-10", currency: "usd", fee: "25" },
      { org_id: null, acquirer: "stripe", month: "2026-10", currency: "usd", fee: "200" },
    ]);

    const res = await request(app)
      .get("/internal/acquiring_fees/monthly")
      .set({ "X-API-Key": TEST_API_KEY });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("acquiring_fees_by_month");
    expect(res.body.orgs).toEqual([
      {
        org_id: "org-a",
        months: [
          { month: "2026-07", currency: "eur", stripe_fee_cents: 253, revolut_fee_cents: 0, fee_cents: 253, stripe_fee_usd_cents: 292, revolut_fee_usd_cents: 0, fee_usd_cents: 292, unconverted_fee_count: 0, unconverted_fee_cents: 0 },
          { month: "2026-09", currency: "usd", stripe_fee_cents: 290, revolut_fee_cents: 0, fee_cents: 290, stripe_fee_usd_cents: 290, revolut_fee_usd_cents: 0, fee_usd_cents: 290, unconverted_fee_count: 0, unconverted_fee_cents: 0 },
          { month: "2026-10", currency: "usd", stripe_fee_cents: 0, revolut_fee_cents: 25, fee_cents: 25, stripe_fee_usd_cents: 0, revolut_fee_usd_cents: 25, fee_usd_cents: 25, unconverted_fee_count: 0, unconverted_fee_cents: 0 },
        ],
        total: [
          { currency: "eur", stripe_fee_cents: 253, revolut_fee_cents: 0, fee_cents: 253, stripe_fee_usd_cents: 292, revolut_fee_usd_cents: 0, fee_usd_cents: 292, unconverted_fee_count: 0, unconverted_fee_cents: 0 },
          { currency: "usd", stripe_fee_cents: 290, revolut_fee_cents: 25, fee_cents: 315, stripe_fee_usd_cents: 290, revolut_fee_usd_cents: 25, fee_usd_cents: 315, unconverted_fee_count: 0, unconverted_fee_cents: 0 },
        ],
        usd_months: [
          { month: "2026-07", stripe_fee_usd_cents: 292, revolut_fee_usd_cents: 0, fee_usd_cents: 292, unconverted_fee_count: 0 },
          { month: "2026-09", stripe_fee_usd_cents: 290, revolut_fee_usd_cents: 0, fee_usd_cents: 290, unconverted_fee_count: 0 },
          { month: "2026-10", stripe_fee_usd_cents: 0, revolut_fee_usd_cents: 25, fee_usd_cents: 25, unconverted_fee_count: 0 },
        ],
        usd_total: { stripe_fee_usd_cents: 582, revolut_fee_usd_cents: 25, fee_usd_cents: 607, unconverted_fee_count: 0 },
      },
    ]);
    expect(res.body.fleet.usd_total.fee_usd_cents).toBe(807);
    expect(res.body.unattributed.total[0].fee_cents).toBe(200);
    expect(res.body.fleet.total.find((t: { currency: string }) => t.currency === "usd").fee_cents).toBe(515);
  });

  it("refuses without the service key", async () => {
    const res = await request(app).get("/internal/acquiring_fees/monthly");
    expect(res.status).toBe(401);
  });
});
