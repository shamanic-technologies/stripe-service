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
          { month: "2026-09", currency: "usd", stripe_fee_cents: 290, revolut_fee_cents: 0, fee_cents: 290 },
          { month: "2026-10", currency: "usd", stripe_fee_cents: 0, revolut_fee_cents: 25, fee_cents: 25 },
        ],
        total: [{ currency: "usd", stripe_fee_cents: 290, revolut_fee_cents: 25, fee_cents: 315 }],
      },
    ]);
    expect(res.body.unattributed.total[0].fee_cents).toBe(200);
    expect(res.body.fleet.total[0].fee_cents).toBe(515);
  });

  it("refuses without the service key", async () => {
    const res = await request(app).get("/internal/acquiring_fees/monthly");
    expect(res.status).toBe(401);
  });
});
