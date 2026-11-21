/**
 * Agency money + staff attribution in GET /internal/cash/by_org_day, against a
 * REAL Postgres (SAAS-CASH-1121-AGENCY).
 *
 * - A completed Revolut `payment_request` (a payment link staff sent by hand =
 *   agency fee) counts in `agency_*` ONLY; failed/cancelled never; its refund
 *   lands in agency returned on the refund's day.
 * - A staff attribution moves a null-org Stripe PI and a null-org Revolut order
 *   (and their returns) to the stated org's row; totals unchanged.
 * - Neither touches GET /public/stats/billing nor payment_summary.
 *
 * Runs when STRIPE_SERVICE_DB_TEST_URL names a `*test*` database (drops its
 * public schema). CI provides one.
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
const KEY = () => process.env.STRIPE_SERVICE_API_KEY as string;
const FIELDS = [
  "gross_cents",
  "returned_cents",
  "net_cents",
  "agency_gross_cents",
  "agency_returned_cents",
  "agency_net_cents",
] as const;

describe.skipIf(!DB_URL)("cash by org day: agency + staff attribution (real Postgres)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cash = async (): Promise<any> => {
    const res = await request(app).get("/internal/cash/by_org_day").set("X-API-Key", KEY());
    expect(res.status).toBe(200);
    return res.body;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (body: any, org: string | null, day: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body.rows.find((r: any) => r.org_id === org && r.day === day);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expectSumsMatchTotals = (body: any) => {
    for (const f of FIELDS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sum = body.rows.reduce((acc: bigint, r: any) => acc + BigInt(r[f]), 0n).toString();
      expect(sum, f).toBe(body.totals[f]);
    }
  };
  const attribute = (body: Record<string, string>) =>
    request(app).post("/internal/payment_attributions").set("X-API-Key", KEY()).send(body);

  beforeAll(async () => {
    const { db, pool: p } = await import("../../src/db");
    pool = p;
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: "./drizzle" });

    const pi = (id: string, org: string, received: number, iso: string, charge: string | null = null) =>
      pool.query(
        `INSERT INTO payment_intents (id, org_id, amount, amount_received, currency, status, latest_charge, created_stripe)
         VALUES ($1,$2,$3,$3,'usd','succeeded',$4,$5)`,
        [id, org, received, charge, unix(iso)]
      );
    await pi("pi_known", "org_A", 10000, "2026-10-01T10:00:00Z");
    await pi("pi_unknown", "unknown", 700, "2026-10-02T12:00:00Z", "ch_unknown");
    await pool.query(
      `INSERT INTO refunds (id, payment_intent, charge, amount, currency, status, created_stripe)
       VALUES ('re_unknown', NULL, 'ch_unknown', 200, 'usd', 'succeeded', $1)`,
      [unix("2026-10-03T09:00:00Z")]
    );

    const rv = (id: string, type: string, state: string, org: string | null, amount: number, iso: string, related: string | null = null) =>
      pool.query(
        `INSERT INTO revolut_orders (id, type, state, org_id, related_order_id, amount, currency, created_at_revolut)
         VALUES ($1,$2,$3,$4,$5,$6,'USD',$7)`,
        [id, type, state, org, related, amount, iso]
      );
    await rv("rv_topup", "payment", "completed", "org_C", 4000, "2026-10-03T08:00:00Z");
    await rv("rv_topup_orgless", "payment", "completed", null, 600, "2026-10-03T09:00:00Z");
    // Agency payment links (staff-sent): only the completed one counts.
    await rv("rv_req", "payment_request", "completed", null, 200000, "2026-09-09T10:55:07Z");
    await rv("rv_req2", "payment_request", "completed", null, 125000, "2026-10-11T11:37:00Z");
    await rv("rv_req_failed", "payment_request", "failed", null, 200000, "2026-09-04T11:20:36Z");
    await rv("rv_req_cancelled", "payment_request", "cancelled", null, 125000, "2026-10-11T11:35:48Z");
    // Refund of an agency link, on a later day: agency returned only.
    await rv("rv_req_refund", "refund", "completed", null, 5000, "2026-10-15T08:00:00Z", "rv_req2");
    await rv("rv_req_refund_failed", "refund", "failed", null, 5000, "2026-10-15T08:00:00Z", "rv_req2");

    const { createTestApp } = await import("../helpers/test-app");
    app = createTestApp();
  }, 60_000);

  afterAll(async () => {
    await pool?.end?.();
    process.env.STRIPE_SERVICE_DATABASE_URL = PREVIOUS_DB_URL;
  });

  it("counts a completed payment_request in agency fields only, its refund in agency returned on its day", async () => {
    const body = await cash();
    expect(body.totals).toEqual({
      gross_cents: "15300",
      returned_cents: "200",
      net_cents: "15100",
      agency_gross_cents: "325000",
      agency_returned_cents: "5000",
      agency_net_cents: "320000",
      saas_reclassified_to_agency_gross_cents: "0",
      saas_reclassified_to_agency_returned_cents: "0",
      saas_reclassified_to_agency_net_cents: "0",
    });
    expect(row(body, null, "2026-09-09")).toEqual({
      org_id: null,
      day: "2026-09-09",
      gross_cents: "0",
      returned_cents: "0",
      net_cents: "0",
      agency_gross_cents: "200000",
      agency_returned_cents: "0",
      agency_net_cents: "200000",
    });
    expect(row(body, null, "2026-10-15")).toMatchObject({
      gross_cents: "0",
      returned_cents: "0",
      agency_returned_cents: "5000",
      agency_net_cents: "-5000",
    });
    // failed / cancelled links never count
    expect(row(body, null, "2026-09-04")).toBeUndefined();
    expectSumsMatchTotals(body);
  });

  it("public stats keep SaaS money only (agency links + their refunds absent)", async () => {
    const [body, stats] = await Promise.all([cash(), request(app).get("/public/stats/billing")]);
    expect(stats.status).toBe(200);
    expect(stats.body.total_paid_cents).toBe(body.totals.gross_cents);
    expect(stats.body.total_net_cents).toBe(body.totals.net_cents);
    expect(stats.body.total_returned_cents).toBe(body.totals.returned_cents);
  });

  it("refuses: unknown payment 404, payment with an org 409, refund id 404", async () => {
    const base = { recorded_by: "staff@distribute.you", note: "n", org_id: "org_Z" };
    expect((await attribute({ ...base, acquirer: "stripe", payment_id: "pi_nope" })).status).toBe(404);
    const hasOrg = await attribute({ ...base, acquirer: "stripe", payment_id: "pi_known" });
    expect(hasOrg.status).toBe(409);
    expect(hasOrg.body.code).toBe("payment_has_org");
    const rvHasOrg = await attribute({ ...base, acquirer: "revolut", payment_id: "rv_topup" });
    expect(rvHasOrg.status).toBe(409);
    expect(rvHasOrg.body.code).toBe("payment_has_org");
    expect((await attribute({ ...base, acquirer: "revolut", payment_id: "rv_req_refund" })).status).toBe(404);
    expect((await attribute({ ...base, acquirer: "stripe", payment_id: "pi_unknown", recorded_by: "not-an-email" })).status).toBe(400);
  });

  it("moves an attributed null-org Stripe PI, Revolut top-up and agency link (and returns) to the org; totals unchanged", async () => {
    const before = await cash();
    const statsBefore = await request(app).get("/public/stats/billing");
    const summaryBefore = await request(app)
      .get("/internal/payment_summary/by-org/org_Z")
      .set("X-API-Key", KEY());

    const a1 = await attribute({ acquirer: "stripe", payment_id: "pi_unknown", org_id: "org_Z", recorded_by: "staff@distribute.you", note: "wire from Z" });
    expect(a1.status).toBe(201);
    expect(a1.body).toMatchObject({ object: "payment_attribution", acquirer: "stripe", payment_id: "pi_unknown", org_id: "org_Z", recorded_by: "staff@distribute.you", note: "wire from Z" });
    expect(typeof a1.body.recorded_at).toBe("number");
    expect((await attribute({ acquirer: "revolut", payment_id: "rv_topup_orgless", org_id: "org_Z", recorded_by: "staff@distribute.you", note: "top-up" })).status).toBe(201);
    expect((await attribute({ acquirer: "revolut", payment_id: "rv_req2", org_id: "org_Z", recorded_by: "staff@distribute.you", note: "Doc Dinners October" })).status).toBe(201);

    // same org again: idempotent 200; different org: 409
    const replay = await attribute({ acquirer: "stripe", payment_id: "pi_unknown", org_id: "org_Z", recorded_by: "other@distribute.you", note: "again" });
    expect(replay.status).toBe(200);
    expect(replay.body.recorded_by).toBe("staff@distribute.you");
    const conflict = await attribute({ acquirer: "stripe", payment_id: "pi_unknown", org_id: "org_Y", recorded_by: "staff@distribute.you", note: "x" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("attributed_to_other_org");
    expect(conflict.body.existing.org_id).toBe("org_Z");

    const after = await cash();
    expect(after.totals).toEqual(before.totals);
    expectSumsMatchTotals(after);
    expect(row(after, null, "2026-10-02")).toBeUndefined();
    expect(row(after, "org_Z", "2026-10-02")).toMatchObject({ gross_cents: "700", net_cents: "700" });
    // the refund of the attributed PI follows it
    expect(row(after, null, "2026-10-03")).toBeUndefined();
    expect(row(after, "org_Z", "2026-10-03")).toMatchObject({ gross_cents: "600", returned_cents: "200", net_cents: "400" });
    expect(row(after, "org_Z", "2026-10-11")).toMatchObject({ gross_cents: "0", agency_gross_cents: "125000" });
    expect(row(after, "org_Z", "2026-10-15")).toMatchObject({ agency_returned_cents: "5000" });
    expect(row(after, null, "2026-09-09")).toMatchObject({ agency_gross_cents: "200000" });

    // nothing else moves
    const statsAfter = await request(app).get("/public/stats/billing");
    expect(statsAfter.body).toEqual(statsBefore.body);
    const summaryAfter = await request(app)
      .get("/internal/payment_summary/by-org/org_Z")
      .set("X-API-Key", KEY());
    expect(summaryAfter.status).toBe(summaryBefore.status);
    expect(summaryAfter.body).toEqual(summaryBefore.body);

    const list = await request(app).get("/internal/payment_attributions").set("X-API-Key", KEY());
    expect(list.status).toBe(200);
    expect(list.body.data.map((a: { payment_id: string }) => a.payment_id).sort()).toEqual(["pi_unknown", "rv_req2", "rv_topup_orgless"]);
  });
});
