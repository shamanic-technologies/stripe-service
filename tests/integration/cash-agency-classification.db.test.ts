/**
 * Staff AGENCY classification of a recorded payment in
 * GET /internal/cash/by_org_day, against a REAL Postgres
 * (SAAS-CASH-1121-AGENCY-KIND).
 *
 * - A classified Stripe PI, Revolut `payment` order and direct payment move
 *   from the SaaS fields to the agency fields of the SAME (org, day) row, their
 *   refunds / lost disputes too.
 * - SaaS totals drop and agency totals rise by the same amount, stated in
 *   `saas_reclassified_to_agency_*_cents`; Σ rows == totals for every field;
 *   SaaS + reclassified == GET /public/stats/billing.
 * - public stats and payment_summary are byte-unchanged.
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

const MOVED = [
  "saas_reclassified_to_agency_gross_cents",
  "saas_reclassified_to_agency_returned_cents",
  "saas_reclassified_to_agency_net_cents",
] as const;

describe.skipIf(!DB_URL)("cash by org day: staff agency classification (real Postgres)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  let directAgencyId = "";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expectPublicIdentity = (body: any, stats: any) => {
    const t = body.totals;
    expect((BigInt(t.gross_cents) + BigInt(t.saas_reclassified_to_agency_gross_cents)).toString()).toBe(stats.total_paid_cents);
    expect((BigInt(t.returned_cents) + BigInt(t.saas_reclassified_to_agency_returned_cents)).toString()).toBe(stats.total_returned_cents);
    expect((BigInt(t.net_cents) + BigInt(t.saas_reclassified_to_agency_net_cents)).toString()).toBe(stats.total_net_cents);
  };
  const classify = (body: Record<string, string>) =>
    request(app).post("/internal/payment_agency_classifications").set("X-API-Key", KEY()).send(body);
  const staff = { recorded_by: "staff@distribute.you", note: "journalist expert quote, agency mode" };

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
    await pi("pi_saas", "org_A", 10000, "2026-10-01T10:00:00Z");
    await pi("pi_agency", "unknown", 30000, "2026-07-03T10:00:00Z", "ch_agency");
    await pool.query(
      `INSERT INTO refunds (id, payment_intent, charge, amount, currency, status, created_stripe)
       VALUES ('re_agency', NULL, 'ch_agency', 5000, 'usd', 'succeeded', $1)`,
      [unix("2026-07-10T09:00:00Z")]
    );
    await pool.query(
      `INSERT INTO disputes (id, payment_intent, charge, amount, currency, status, created_stripe)
       VALUES ('dp_agency', 'pi_agency', 'ch_agency', 1000, 'usd', 'lost', $1)`,
      [unix("2026-07-12T09:00:00Z")]
    );

    const rv = (id: string, type: string, state: string, org: string | null, amount: number, iso: string, related: string | null = null) =>
      pool.query(
        `INSERT INTO revolut_orders (id, type, state, org_id, related_order_id, amount, currency, created_at_revolut)
         VALUES ($1,$2,$3,$4,$5,$6,'USD',$7)`,
        [id, type, state, org, related, amount, iso]
      );
    await rv("rv_pay", "payment", "completed", "org_C", 4000, "2026-10-03T08:00:00Z");
    await rv("rv_pay_refund", "refund", "completed", null, 1000, "2026-10-05T08:00:00Z", "rv_pay");
    await rv("rv_req", "payment_request", "completed", null, 2000, "2026-09-09T10:00:00Z");

    const dp = await pool.query(
      `INSERT INTO direct_payments (org_id, amount, currency, note, recorded_by, idempotency_key, recorded_at)
       VALUES ('org_D', 115015, 'usd', 'Doc Dinners', 'staff@x', 'k1', '2026-10-11T12:00:00Z') RETURNING id`
    );
    directAgencyId = dp.rows[0].id;
    await pool.query(
      `INSERT INTO direct_payments (org_id, amount, currency, note, recorded_by, idempotency_key, recorded_at)
       VALUES ('org_D', 2500, 'usd', 'saas top-up', 'staff@x', 'k2', '2026-10-12T12:00:00Z')`
    );

    const { createTestApp } = await import("../helpers/test-app");
    app = createTestApp();
  }, 60_000);

  afterAll(async () => {
    await pool?.end?.();
    process.env.STRIPE_SERVICE_DATABASE_URL = PREVIOUS_DB_URL;
  });

  it("before any classification nothing moves: reclassified totals are 0 and SaaS == public stats", async () => {
    const [body, stats] = await Promise.all([cash(), request(app).get("/public/stats/billing")]);
    for (const f of MOVED) expect(body.totals[f], f).toBe("0");
    expect(body.totals.gross_cents).toBe("161515");
    expect(row(body, null, "2026-07-03")).toMatchObject({ gross_cents: "30000", agency_gross_cents: "0" });
    expectSumsMatchTotals(body);
    expectPublicIdentity(body, stats.body);
  });

  it("refuses: unknown payment 404, refund id 404, bad direct id 404, payment link 409 already_agency, bad body 400", async () => {
    expect((await classify({ ...staff, acquirer: "stripe", payment_id: "pi_nope" })).status).toBe(404);
    expect((await classify({ ...staff, acquirer: "revolut", payment_id: "rv_pay_refund" })).status).toBe(404);
    const badDirect = await classify({ ...staff, acquirer: "direct", payment_id: "not-a-uuid" });
    expect(badDirect.status).toBe(404);
    expect(badDirect.body.code).toBe("payment_not_found");
    expect((await classify({ ...staff, acquirer: "direct", payment_id: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    const link = await classify({ ...staff, acquirer: "revolut", payment_id: "rv_req" });
    expect(link.status).toBe(409);
    expect(link.body.code).toBe("already_agency");
    expect((await classify({ ...staff, acquirer: "stripe", payment_id: "pi_agency", recorded_by: "nope" })).status).toBe(400);
    expect((await classify({ ...staff, acquirer: "paypal", payment_id: "pi_agency" })).status).toBe(400);
  });

  it("moves a classified Stripe PI, Revolut payment and direct payment (and their returns) to agency on the same row", async () => {
    const before = await cash();
    const statsBefore = await request(app).get("/public/stats/billing");
    const summaries = async () =>
      Promise.all(
        ["org_A", "org_C", "org_D", "unknown"].map((o) =>
          request(app).get(`/internal/payment_summary/by-org/${o}`).set("X-API-Key", KEY())
        )
      );
    const summariesBefore = await summaries();

    const s1 = await classify({ ...staff, acquirer: "stripe", payment_id: "pi_agency" });
    expect(s1.status).toBe(201);
    expect(s1.body).toMatchObject({ object: "payment_agency_classification", acquirer: "stripe", payment_id: "pi_agency", ...staff });
    expect(typeof s1.body.recorded_at).toBe("number");
    expect((await classify({ ...staff, acquirer: "revolut", payment_id: "rv_pay" })).status).toBe(201);
    expect((await classify({ ...staff, acquirer: "direct", payment_id: directAgencyId })).status).toBe(201);
    // replay: idempotent, the first statement stands
    const replay = await classify({ acquirer: "stripe", payment_id: "pi_agency", recorded_by: "other@distribute.you", note: "again" });
    expect(replay.status).toBe(200);
    expect(replay.body.recorded_by).toBe("staff@distribute.you");

    const after = await cash();
    expect(after.totals).toEqual({
      gross_cents: (161515 - 30000 - 4000 - 115015).toString(),
      returned_cents: "0",
      net_cents: (161515 - 149015).toString(),
      agency_gross_cents: (2000 + 149015).toString(),
      agency_returned_cents: "7000",
      agency_net_cents: (2000 + 149015 - 7000).toString(),
      saas_reclassified_to_agency_gross_cents: "149015",
      saas_reclassified_to_agency_returned_cents: "7000",
      saas_reclassified_to_agency_net_cents: "142015",
    });
    // SaaS drops and agency rises by the same amount
    expect(BigInt(before.totals.gross_cents) - BigInt(after.totals.gross_cents)).toBe(
      BigInt(after.totals.agency_gross_cents) - BigInt(before.totals.agency_gross_cents)
    );
    expectSumsMatchTotals(after);

    expect(row(after, null, "2026-07-03")).toMatchObject({ gross_cents: "0", agency_gross_cents: "30000" });
    expect(row(after, null, "2026-07-10")).toMatchObject({ returned_cents: "0", agency_returned_cents: "5000", agency_net_cents: "-5000" });
    expect(row(after, null, "2026-07-12")).toMatchObject({ returned_cents: "0", agency_returned_cents: "1000" });
    expect(row(after, "org_C", "2026-10-03")).toMatchObject({ gross_cents: "0", agency_gross_cents: "4000" });
    expect(row(after, "org_C", "2026-10-05")).toMatchObject({ returned_cents: "0", agency_returned_cents: "1000" });
    expect(row(after, "org_D", "2026-10-11")).toMatchObject({ gross_cents: "0", agency_gross_cents: "115015" });
    expect(row(after, "org_D", "2026-10-12")).toMatchObject({ gross_cents: "2500", agency_gross_cents: "0" });
    expect(row(after, "org_A", "2026-10-01")).toMatchObject({ gross_cents: "10000", agency_gross_cents: "0" });

    // nothing else moves
    const statsAfter = await request(app).get("/public/stats/billing");
    expect(statsAfter.body).toEqual(statsBefore.body);
    expectPublicIdentity(after, statsAfter.body);
    const summariesAfter = await summaries();
    summariesAfter.forEach((s, i) => {
      expect(s.status).toBe(summariesBefore[i].status);
      expect(s.body).toEqual(summariesBefore[i].body);
    });

    const list = await request(app).get("/internal/payment_agency_classifications").set("X-API-Key", KEY());
    expect(list.status).toBe(200);
    expect(list.body.data.map((c: { payment_id: string }) => c.payment_id).sort()).toEqual(
      [directAgencyId, "pi_agency", "rv_pay"].sort()
    );
  });

  it("an attribution still decides the org: the classified org-less PI moves to the stated org, still agency", async () => {
    const res = await request(app)
      .post("/internal/payment_attributions")
      .set("X-API-Key", KEY())
      .send({ acquirer: "stripe", payment_id: "pi_agency", org_id: "org_Z", ...staff });
    expect(res.status).toBe(201);
    const body = await cash();
    expect(row(body, null, "2026-07-03")).toBeUndefined();
    expect(row(body, "org_Z", "2026-07-03")).toMatchObject({ gross_cents: "0", agency_gross_cents: "30000" });
    expect(row(body, "org_Z", "2026-07-10")).toMatchObject({ agency_returned_cents: "5000" });
    expect(body.totals.saas_reclassified_to_agency_gross_cents).toBe("149015");
    expectSumsMatchTotals(body);
  });
});
