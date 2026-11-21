/**
 * GET /internal/cash/by_org_day against a REAL Postgres (SAAS-CASH-1121).
 *
 * The rule lives in SQL, so a mocked db could only echo a fixture back. This
 * suite builds the schema from the journaled migrations, inserts one fixture
 * per predicate, then reads the route AND GET /public/stats/billing on the SAME
 * rows: Σ rows == totals == the platform figures.
 *
 * Runs when STRIPE_SERVICE_DB_TEST_URL names a database whose name contains
 * "test" (it drops and rebuilds its `public` schema). CI provides one.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";

const { DB_URL, PREVIOUS_DB_URL } = vi.hoisted(() => {
  const url = process.env.STRIPE_SERVICE_DB_TEST_URL;
  const safe = url && /test/i.test(new URL(url).pathname) ? url : undefined;
  const previous = process.env.STRIPE_SERVICE_DATABASE_URL;
  if (safe) process.env.STRIPE_SERVICE_DATABASE_URL = safe;
  return { DB_URL: safe, PREVIOUS_DB_URL: previous };
});

vi.mock("../../src/lib/stripe-client", () => ({
  makeStripeClient: vi.fn(),
  getWebhookClient: vi.fn(),
  constructWebhookEvent: vi.fn(),
  isStripeError: () => false,
  stripeErrorStatus: () => 500,
  isResourceMissing: () => false,
}));
vi.mock("../../src/lib/resolve-stripe-key", () => ({ resolveStripeKey: vi.fn() }));

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe.skipIf(!DB_URL)("GET /internal/cash/by_org_day (real Postgres)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;

  beforeAll(async () => {
    const { db, pool: p } = await import("../../src/db");
    pool = p;
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: "./drizzle" });

    const pi = (id: string, org: string, status: string, received: number | null, iso: string, charge: string | null = null) =>
      pool.query(
        `INSERT INTO payment_intents (id, org_id, amount, amount_received, currency, status, latest_charge, created_stripe)
         VALUES ($1,$2,$3,$4,'usd',$5,$6,$7)`,
        [id, org, received ?? 0, received, status, charge, unix(iso)]
      );
    await pi("pi_a", "org_A", "succeeded", 10000, "2026-10-01T10:00:00Z", "ch_a");
    await pi("pi_b", "org_B", "succeeded", 5000, "2026-10-01T23:30:00Z", "ch_b");
    await pi("pi_a2", "org_A", "succeeded", 2000, "2026-10-02T00:30:00Z");
    await pi("pi_fail", "org_A", "requires_payment_method", null, "2026-10-01T11:00:00Z");
    await pi("pi_unknown", "unknown", "succeeded", 700, "2026-10-02T12:00:00Z");

    const ret = (table: string, id: string, piId: string | null, charge: string | null, amount: number, status: string, iso: string) =>
      pool.query(
        `INSERT INTO ${table} (id, payment_intent, charge, amount, currency, status, created_stripe)
         VALUES ($1,$2,$3,$4,'usd',$5,$6)`,
        [id, piId, charge, amount, status, unix(iso)]
      );
    // Refund on a LATER day lands on the refund's day, with the parent's org.
    await ret("refunds", "re_1", "pi_a", null, 3000, "succeeded", "2026-10-05T09:00:00Z");
    // Attributed through the charge when Stripe leaves payment_intent null.
    await ret("refunds", "re_2", null, "ch_a", 1000, "succeeded", "2026-10-05T15:00:00Z");
    await ret("refunds", "re_failed", "pi_a", null, 500, "failed", "2026-10-05T16:00:00Z");
    await ret("refunds", "re_pending", "pi_a", null, 400, "pending", "2026-10-05T16:00:00Z");
    await ret("refunds", "re_orphan", "pi_not_mirrored", null, 900, "succeeded", "2026-10-05T16:00:00Z");
    await ret("disputes", "dp_won", "pi_b", null, 5000, "won", "2026-10-06T10:00:00Z");
    await ret("disputes", "dp_lost", "pi_b", null, 2000, "lost", "2026-10-07T10:00:00Z");

    const rv = (id: string, type: string, state: string, org: string | null, amount: number, iso: string, related: string | null = null) =>
      pool.query(
        `INSERT INTO revolut_orders (id, type, state, org_id, related_order_id, amount, currency, created_at_revolut)
         VALUES ($1,$2,$3,$4,$5,$6,'USD',$7)`,
        [id, type, state, org, related, amount, iso]
      );
    await rv("rv_p", "payment", "completed", "org_C", 4000, "2026-10-03T08:00:00Z");
    await rv("rv_p_failed", "payment", "failed", "org_C", 8000, "2026-10-03T08:00:00Z");
    await rv("rv_p_orgless", "payment", "completed", null, 600, "2026-10-03T09:00:00Z");
    // Revolut refunds carry no org: attributed through the parent order.
    await rv("rv_r", "refund", "completed", null, 1500, "2026-10-09T08:00:00Z", "rv_p");
    await rv("rv_r_failed", "refund", "failed", null, 1500, "2026-10-09T08:00:00Z", "rv_p");

    await pool.query(
      `INSERT INTO direct_payments (org_id, amount, currency, note, recorded_by, idempotency_key, recorded_at, voided_at)
       VALUES ('org_D', 2500, 'usd', 'bank transfer', 'staff@x', 'k1', '2026-10-04T12:00:00Z', NULL),
              ('org_D', 9000, 'usd', 'mistake', 'staff@x', 'k2', '2026-10-04T12:00:00Z', '2026-10-04T13:00:00Z')`
    );

    const { createTestApp } = await import("../helpers/test-app");
    app = createTestApp();
  }, 60_000);

  afterAll(async () => {
    await pool?.end?.();
    process.env.STRIPE_SERVICE_DATABASE_URL = PREVIOUS_DB_URL;
  });

  it("serves gross on the payment day, returns on their own day, voided/failed/pending/won excluded", async () => {
    const res = await request(app)
      .get("/internal/cash/by_org_day")
      .set("X-API-Key", process.env.STRIPE_SERVICE_API_KEY as string);

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("cash_by_org_day");
    expect(typeof res.body.as_of).toBe("string");
    const Z = { agency_gross_cents: "0", agency_returned_cents: "0", agency_net_cents: "0" };
    expect(res.body.rows).toEqual([
      { org_id: "org_A", day: "2026-10-01", gross_cents: "10000", returned_cents: "0", net_cents: "10000", ...Z },
      { org_id: "org_B", day: "2026-10-01", gross_cents: "5000", returned_cents: "0", net_cents: "5000", ...Z },
      { org_id: null, day: "2026-10-02", gross_cents: "700", returned_cents: "0", net_cents: "700", ...Z },
      { org_id: "org_A", day: "2026-10-02", gross_cents: "2000", returned_cents: "0", net_cents: "2000", ...Z },
      { org_id: null, day: "2026-10-03", gross_cents: "600", returned_cents: "0", net_cents: "600", ...Z },
      { org_id: "org_C", day: "2026-10-03", gross_cents: "4000", returned_cents: "0", net_cents: "4000", ...Z },
      { org_id: "org_D", day: "2026-10-04", gross_cents: "2500", returned_cents: "0", net_cents: "2500", ...Z },
      { org_id: "org_A", day: "2026-10-05", gross_cents: "0", returned_cents: "4000", net_cents: "-4000", ...Z },
      { org_id: "org_B", day: "2026-10-07", gross_cents: "0", returned_cents: "2000", net_cents: "-2000", ...Z },
      { org_id: "org_C", day: "2026-10-09", gross_cents: "0", returned_cents: "1500", net_cents: "-1500", ...Z },
    ]);
    expect(res.body.totals).toEqual({ gross_cents: "24800", returned_cents: "7500", net_cents: "17300", ...Z });
  });

  it("Σ rows == totals == GET /public/stats/billing on the same rows", async () => {
    const [cash, stats] = await Promise.all([
      request(app).get("/internal/cash/by_org_day").set("X-API-Key", process.env.STRIPE_SERVICE_API_KEY as string),
      request(app).get("/public/stats/billing"),
    ]);
    expect(stats.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = cash.body.rows as any[];
    const sum = (k: string) => rows.reduce((acc, r) => acc + BigInt(r[k]), 0n).toString();
    expect(sum("gross_cents")).toBe(cash.body.totals.gross_cents);
    expect(sum("net_cents")).toBe(cash.body.totals.net_cents);
    expect(cash.body.totals.gross_cents).toBe(stats.body.total_paid_cents);
    expect(cash.body.totals.net_cents).toBe(stats.body.total_net_cents);
    expect(cash.body.totals.returned_cents).toBe(stats.body.total_returned_cents);
  });

  it("requires the API key", async () => {
    const res = await request(app).get("/internal/cash/by_org_day");
    expect(res.status).toBe(401);
  });
});
