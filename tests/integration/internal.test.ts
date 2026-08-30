import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { TEST_API_KEY, TEST_ORG_ID } from "../helpers/mocks";

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
    (e as { statusCode?: number }).statusCode === 404,
}));
// The teardown route resolves the platform Stripe key (single-account model)
// via getPlatformStripe -> resolvePlatformKey. Keep the rest of key-client real.
vi.mock("../../src/lib/key-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/key-client")>();
  return {
    ...actual,
    resolvePlatformKey: vi.fn().mockResolvedValue({ key: "sk_test_platform" }),
  };
});

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

/**
 * Collect every bound parameter value out of a drizzle SQL condition. The db
 * mock replays queued rows without applying a WHERE, so the captured where
 * clause is the only place a time bound is observable.
 */
function paramValues(node: unknown, seen = new Set<unknown>()): unknown[] {
  if (node === null || typeof node !== "object") return [];
  if (seen.has(node)) return [];
  seen.add(node);
  const rec = node as Record<string, unknown>;
  if ("value" in rec && "encoder" in rec) return [rec.value];
  const out: unknown[] = [];
  for (const child of Object.values(rec)) {
    if (Array.isArray(child)) {
      for (const item of child) out.push(...paramValues(item, seen));
    } else {
      out.push(...paramValues(child, seen));
    }
  }
  return out;
}

// Bronze event a deleted-customer projection reads back: its presence drives
// projectSilverFromBronze into the `deleted` branch -> db.delete(customers).
function deletedCustomerEvent(id: string) {
  return [{ payload: { data: { object: { id, object: "customer", deleted: true } } } }];
}

function apiKeyOnly(): Record<string, string> {
  return { "X-API-Key": TEST_API_KEY };
}

describe("DELETE /internal/customers/by-org/:orgId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.customers.del.mockReset();
  });

  it("deletes the org's Stripe customer online and tombstones the mirror", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x", livemode: "false" }]);
    dbMock.queueSelect("events", deletedCustomerEvent("cus_x"));
    stripeMock.customers.del.mockResolvedValueOnce({ id: "cus_x", object: "customer", deleted: true });

    const res = await request(app)
      .delete(`/internal/customers/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1, customer_ids: ["cus_x"] });
    expect(stripeMock.customers.del).toHaveBeenCalledWith("cus_x");
    // Durable tombstone: projection took the deleted branch -> silver row deleted.
    expect(dbMock.db.delete).toHaveBeenCalled();
  });

  it("returns 200 with nothing deleted when the org has no customer (idempotent)", async () => {
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .delete(`/internal/customers/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 0, customer_ids: [] });
    expect(stripeMock.customers.del).not.toHaveBeenCalled();
    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });

  it("fails loud (non-2xx) when Stripe deletion errors for a real reason", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x", livemode: "false" }]);
    const err = new Error("Stripe down") as Error & { statusCode?: number };
    err.statusCode = 500;
    stripeMock.customers.del.mockRejectedValueOnce(err);

    const res = await request(app)
      .delete(`/internal/customers/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(stripeMock.customers.del).toHaveBeenCalledWith("cus_x");
    // Stripe threw before the tombstone -> mirror not deleted, error propagated.
    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });

  it("treats an already-deleted Stripe customer (resource_missing) as success", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x", livemode: "false" }]);
    dbMock.queueSelect("events", deletedCustomerEvent("cus_x"));
    const err = new Error("No such customer") as Error & { statusCode?: number };
    err.statusCode = 404;
    stripeMock.customers.del.mockRejectedValueOnce(err);

    const res = await request(app)
      .delete(`/internal/customers/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1, customer_ids: ["cus_x"] });
    expect(stripeMock.customers.del).toHaveBeenCalledWith("cus_x");
    // Still tombstoned even though Stripe reported it already gone.
    expect(dbMock.db.delete).toHaveBeenCalled();
  });

  it("requires only X-API-Key — no x-org-id/x-user-id identity headers", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x", livemode: "false" }]);
    dbMock.queueSelect("events", deletedCustomerEvent("cus_x"));
    stripeMock.customers.del.mockResolvedValueOnce({ id: "cus_x", object: "customer", deleted: true });

    const res = await request(app)
      .delete(`/internal/customers/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
  });

  it("rejects with 401 when X-API-Key is missing", async () => {
    const res = await request(app).delete(`/internal/customers/by-org/${TEST_ORG_ID}`);

    expect(res.status).toBe(401);
    expect(stripeMock.customers.del).not.toHaveBeenCalled();
  });
});

describe("GET /internal/customers/by-org/:orgId (user-less)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the org's customer raw_json with only X-API-Key", async () => {
    dbMock.queueSelect("customers", [
      { id: "cus_x", rawJson: { id: "cus_x", object: "customer", email: "a@b.co" } },
    ]);

    const res = await request(app)
      .get(`/internal/customers/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "cus_x", object: "customer", email: "a@b.co" });
  });

  it("returns 404 when the org has no customer", async () => {
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .get(`/internal/customers/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(404);
  });

  it("rejects with 401 when X-API-Key is missing", async () => {
    const res = await request(app).get(`/internal/customers/by-org/${TEST_ORG_ID}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /internal/payment_intents/by-org/:orgId (user-less)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the org's PaymentIntents as a Stripe list with only X-API-Key", async () => {
    dbMock.queueSelect("payment_intents", [
      { id: "pi_1", rawJson: { id: "pi_1", object: "payment_intent", status: "succeeded", amount_received: 5000 } },
      { id: "pi_2", rawJson: { id: "pi_2", object: "payment_intent", status: "requires_payment_method" } },
    ]);

    const res = await request(app)
      .get(`/internal/payment_intents/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBe("pi_1");
    expect(res.body.has_more).toBe(false);
  });

  it("returns an empty list when the org has no PaymentIntents", async () => {
    dbMock.queueSelect("payment_intents", []);

    const res = await request(app)
      .get(`/internal/payment_intents/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "list",
      data: [],
      has_more: false,
      url: `/internal/payment_intents/by-org/${TEST_ORG_ID}`,
    });
  });

  it("conveys per payment how much was returned, leaving the Stripe object intact", async () => {
    dbMock.queueSelect("payment_intents", [
      {
        id: "pi_refunded",
        latestCharge: "ch_1",
        rawJson: { id: "pi_refunded", object: "payment_intent", status: "succeeded", amount_received: 1000 },
      },
      {
        id: "pi_clean",
        latestCharge: "ch_2",
        rawJson: { id: "pi_clean", object: "payment_intent", status: "succeeded", amount_received: 2000 },
      },
    ]);
    dbMock.queueSelect("refunds", [
      { id: "re_1", paymentIntent: "pi_refunded", charge: "ch_1", amount: 1000, status: "succeeded" },
    ]);
    dbMock.queueSelect("disputes", []);

    const res = await request(app)
      .get(`/internal/payment_intents/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    const [refunded, clean] = res.body.data;
    // The original payment is untouched — Stripe's model is append-only.
    expect(refunded).toMatchObject({
      id: "pi_refunded",
      status: "succeeded",
      amount_received: 1000,
      amount_refunded: 1000,
      amount_disputed_lost: 0,
      amount_returned: 1000,
    });
    expect(clean).toMatchObject({ id: "pi_clean", amount_returned: 0 });
  });
});

describe("GET /internal/customers/by-org/:orgId/all (user-less)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns EVERY mirrored customer for the org, not just the newest", async () => {
    dbMock.queueSelect("customers", [
      { id: "cus_2", rawJson: { id: "cus_2", object: "customer" } },
      { id: "cus_1", rawJson: { id: "cus_1", object: "customer" } },
    ]);

    const res = await request(app)
      .get(`/internal/customers/by-org/${TEST_ORG_ID}/all`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "list",
      data: [
        { id: "cus_2", object: "customer" },
        { id: "cus_1", object: "customer" },
      ],
      has_more: false,
      url: `/internal/customers/by-org/${TEST_ORG_ID}/all`,
    });
  });

  it("resolves the org from the mapping column, not from a metadata filter", async () => {
    dbMock.queueSelect("customers", []);

    await request(app)
      .get(`/internal/customers/by-org/${TEST_ORG_ID}/all`)
      .set(apiKeyOnly());

    expect(paramValues(dbMock.lastSelectWhere("customers"))).toEqual([TEST_ORG_ID]);
  });

  it("answers an org with no customers with an empty list, not a 404", async () => {
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .get(`/internal/customers/by-org/${TEST_ORG_ID}/all`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("needs no end-user identity", async () => {
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .get(`/internal/customers/by-org/${TEST_ORG_ID}/all`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
  });

  it("rejects with 401 when X-API-Key is missing", async () => {
    const res = await request(app).get(
      `/internal/customers/by-org/${TEST_ORG_ID}/all`
    );

    expect(res.status).toBe(401);
  });
});

describe("POST /internal/customers/:id/metadata (user-less)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards the metadata verbatim to Stripe with no end-user identity", async () => {
    stripeMock.customers.update.mockResolvedValue({
      id: "cus_1",
      object: "customer",
      metadata: { org_id: "org-target", brand_id: "brand-b" },
    });
    dbMock.queueInsert("events", [{ id: "evt_synthetic" }]);
    dbMock.queueSelect("events", [
      {
        payload: {
          data: {
            object: {
              id: "cus_1",
              object: "customer",
              metadata: { org_id: "org-target" },
            },
          },
        },
      },
    ]);

    const res = await request(app)
      .post("/internal/customers/cus_1/metadata")
      .set(apiKeyOnly())
      .send({ metadata: { org_id: "org-target", brand_id: "brand-b" } });

    expect(res.status).toBe(200);
    expect(stripeMock.customers.update).toHaveBeenCalledWith("cus_1", {
      metadata: { org_id: "org-target", brand_id: "brand-b" },
    });
  });

  it("re-mirrors under the org the UPDATED object names, so a tenant move lands on the new owner", async () => {
    stripeMock.customers.update.mockResolvedValue({
      id: "cus_1",
      object: "customer",
      metadata: { org_id: "org-target" },
    });
    dbMock.queueInsert("events", [{ id: "evt_synthetic" }]);
    dbMock.queueSelect("events", [
      {
        payload: {
          data: {
            object: {
              id: "cus_1",
              object: "customer",
              metadata: { org_id: "org-target" },
            },
          },
        },
      },
    ]);

    await request(app)
      .post("/internal/customers/cus_1/metadata")
      .set(apiKeyOnly())
      .send({ metadata: { org_id: "org-target" } });

    // The synthetic bronze event is what carries the move into silver.
    expect(dbMock.lastInsertValues("events")).toBeTruthy();
  });

  it("404s on a customer Stripe does not have", async () => {
    stripeMock.customers.update.mockRejectedValue(
      Object.assign(new Error("No such customer"), { statusCode: 404 })
    );

    const res = await request(app)
      .post("/internal/customers/cus_missing/metadata")
      .set(apiKeyOnly())
      .send({ metadata: { org_id: "org-target" } });

    expect(res.status).toBe(404);
  });

  it("rejects a body with no metadata rather than writing nothing silently", async () => {
    const res = await request(app)
      .post("/internal/customers/cus_1/metadata")
      .set(apiKeyOnly())
      .send({});

    expect(res.status).toBe(400);
    expect(stripeMock.customers.update).not.toHaveBeenCalled();
  });

  it("rejects with 401 when X-API-Key is missing", async () => {
    const res = await request(app)
      .post("/internal/customers/cus_1/metadata")
      .send({ metadata: { org_id: "org-target" } });

    expect(res.status).toBe(401);
    expect(stripeMock.customers.update).not.toHaveBeenCalled();
  });
});

describe("GET /internal/payment_summary/by-org/:orgId (user-less)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports gross, returned and net for an org with a fully refunded payment", async () => {
    dbMock.queueSelect("payment_intents", [
      { id: "pi_1", currency: "usd", status: "succeeded", amountReceived: 1000, latestCharge: "ch_1" },
    ]);
    dbMock.queueSelect("customers", [{ id: "cus_1" }]);
    dbMock.queueSelect("refunds", [
      { id: "re_1", paymentIntent: "pi_1", charge: "ch_1", amount: 1000, status: "succeeded" },
    ]);
    dbMock.queueSelect("disputes", []);

    const res = await request(app)
      .get(`/internal/payment_summary/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "payment_summary",
      org_id: TEST_ORG_ID,
      customer: "cus_1",
      as_of: null,
      totals: [
        {
          currency: "usd",
          amount_received: 1000,
          amount_refunded: 1000,
          amount_disputed_lost: 0,
          amount_returned: 1000,
          amount_net: 0,
        },
      ],
    });
  });

  it("reports zero returned and net == gross for an org with no refunds", async () => {
    dbMock.queueSelect("payment_intents", [
      { id: "pi_1", currency: "usd", status: "succeeded", amountReceived: 4200, latestCharge: null },
    ]);
    dbMock.queueSelect("customers", [{ id: "cus_1" }]);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);

    const res = await request(app)
      .get(`/internal/payment_summary/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual([
      {
        currency: "usd",
        amount_received: 4200,
        amount_refunded: 0,
        amount_disputed_lost: 0,
        amount_returned: 0,
        amount_net: 4200,
      },
    ]);
  });

  it("counts a lost dispute as returned money", async () => {
    dbMock.queueSelect("payment_intents", [
      { id: "pi_1", currency: "usd", status: "succeeded", amountReceived: 5000, latestCharge: "ch_1" },
    ]);
    dbMock.queueSelect("customers", [{ id: "cus_1" }]);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", [
      { id: "dp_1", paymentIntent: "pi_1", charge: "ch_1", amount: 5000, status: "lost" },
    ]);

    const res = await request(app)
      .get(`/internal/payment_summary/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.body.totals[0]).toMatchObject({
      amount_disputed_lost: 5000,
      amount_returned: 5000,
      amount_net: 0,
    });
  });

  it("returns empty totals and a null customer for an org with nothing mirrored", async () => {
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .get(`/internal/payment_summary/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "payment_summary",
      org_id: TEST_ORG_ID,
      customer: null,
      as_of: null,
      totals: [],
    });
  });

  it("requires no end-user identity — X-API-Key and the org in the path are enough", async () => {
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .get(`/internal/payment_summary/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
  });

  it("echoes the as_of bound it applied, so a caller can tell it was honoured", async () => {
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .get(`/internal/payment_summary/by-org/${TEST_ORG_ID}?as_of=1700000000`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body.as_of).toBe(1700000000);
  });

  it("bounds the payments it sums to those created before the instant", async () => {
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("customers", []);

    await request(app)
      .get(`/internal/payment_summary/by-org/${TEST_ORG_ID}?as_of=1700000000`)
      .set(apiKeyOnly());

    expect(paramValues(dbMock.lastSelectWhere("payment_intents"))).toContain(1700000000);
  });

  it("bounds the returns it subtracts by the same instant, not just the payments", async () => {
    dbMock.queueSelect("payment_intents", [
      { id: "pi_1", currency: "usd", status: "succeeded", amountReceived: 1000, latestCharge: "ch_1" },
    ]);
    dbMock.queueSelect("customers", [{ id: "cus_1" }]);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);

    await request(app)
      .get(`/internal/payment_summary/by-org/${TEST_ORG_ID}?as_of=1700000000`)
      .set(apiKeyOnly());

    // Both sides of amount_net must come from the same population — a bound on
    // payments alone would subtract refunds that had not happened yet.
    expect(paramValues(dbMock.lastSelectWhere("refunds"))).toContain(1700000000);
    expect(paramValues(dbMock.lastSelectWhere("disputes"))).toContain(1700000000);
  });

  it("applies no bound and echoes null when as_of is absent", async () => {
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .get(`/internal/payment_summary/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.body.as_of).toBeNull();
    expect(paramValues(dbMock.lastSelectWhere("payment_intents"))).toEqual([TEST_ORG_ID]);
  });

  it.each(["abc", "0", "-1", "1.5", ""])(
    "rejects as_of=%j with 400 rather than silently answering a different question",
    async (value) => {
      const res = await request(app)
        .get(`/internal/payment_summary/by-org/${TEST_ORG_ID}?as_of=${value}`)
        .set(apiKeyOnly());

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/as_of/);
    }
  );

  it("rejects with 401 when X-API-Key is missing", async () => {
    const res = await request(app).get(
      `/internal/payment_summary/by-org/${TEST_ORG_ID}`
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /internal/invoices/by-org/:orgId (off-session invoiced charge)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.invoices.create.mockReset();
    stripeMock.invoices.finalizeInvoice.mockReset();
    stripeMock.invoices.pay.mockReset();
    stripeMock.invoiceItems.create.mockReset();
    stripeMock.paymentIntents.retrieve.mockReset();
    stripeMock.paymentIntents.update.mockReset();
  });

  function queueHappyStripe() {
    stripeMock.invoices.create.mockResolvedValueOnce({ id: "in_1", status: "draft" });
    stripeMock.invoiceItems.create.mockResolvedValueOnce({ id: "ii_1" });
    stripeMock.invoices.finalizeInvoice.mockResolvedValueOnce({ id: "in_1", status: "open" });
    stripeMock.invoices.pay.mockResolvedValueOnce({
      id: "in_1",
      object: "invoice",
      status: "paid",
      amount_paid: 5000,
      currency: "usd",
      // The ONLY PaymentIntent reference Stripe exposes on this API version.
      payments: {
        object: "list",
        data: [{ id: "inpay_1", payment: { type: "payment_intent", payment_intent: "pi_inv" } }],
      },
      hosted_invoice_url: "https://pay.stripe.com/i/in_1",
      invoice_pdf: "https://pay.stripe.com/i/in_1.pdf",
    });
    stripeMock.paymentIntents.update.mockResolvedValueOnce({
      id: "pi_inv",
      object: "payment_intent",
      status: "succeeded",
      amount_received: 5000,
    });
  }

  it("creates, finalizes, and pays an off-session invoice; returns the paid invoice", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    queueHappyStripe();

    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_123" })
      .send({ amount: 5000, currency: "usd", description: "Auto top-up" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("in_1");
    expect(res.body.status).toBe("paid");
    expect(res.body.hosted_invoice_url).toBe("https://pay.stripe.com/i/in_1");

    // Drove Stripe: draft invoice -> item bound to it -> finalize -> pay off_session.
    expect(stripeMock.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_x",
        collection_method: "charge_automatically",
        auto_advance: false,
        currency: "usd",
        description: "Auto top-up",
        pending_invoice_items_behavior: "exclude",
        metadata: expect.objectContaining({ org_id: TEST_ORG_ID }),
      }),
      expect.objectContaining({ idempotencyKey: "topup_123:invoice" })
    );
    expect(stripeMock.invoiceItems.create).toHaveBeenCalledWith(
      { customer: "cus_x", invoice: "in_1", amount: 5000, currency: "usd", description: "Auto top-up" },
      expect.objectContaining({ idempotencyKey: "topup_123:item" })
    );
    expect(stripeMock.invoices.finalizeInvoice).toHaveBeenCalledWith(
      "in_1",
      {},
      expect.objectContaining({ idempotencyKey: "topup_123:finalize" })
    );
    expect(stripeMock.invoices.pay).toHaveBeenCalledWith(
      "in_1",
      { off_session: true, expand: ["payments"] },
      expect.objectContaining({ idempotencyKey: "topup_123:pay" })
    );
    // Provenance carried onto the PaymentIntent consumers actually read, then
    // mirrored — Stripe copies neither the metadata nor the invoice link, and
    // labels the PaymentIntent "Payment for Invoice" unless we describe it.
    expect(stripeMock.paymentIntents.update).toHaveBeenCalledWith(
      "pi_inv",
      {
        metadata: { org_id: TEST_ORG_ID, invoice_id: "in_1" },
        description: "Auto top-up",
      },
      expect.objectContaining({ idempotencyKey: "topup_123:pi-provenance" })
    );
  });

  it("describes the PaymentIntent in the caller's words, not Stripe's 'Payment for Invoice'", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    queueHappyStripe();

    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_desc" })
      .send({ amount: 5000, currency: "usd", description: "Distribute credit top-up" });

    expect(res.status).toBe(200);
    // The customer-facing billing history renders PaymentIntents, so the
    // description has to reach the PAYMENT — describing only the invoice
    // leaves Stripe's generic fallback on the object consumers read.
    expect(stripeMock.paymentIntents.update).toHaveBeenCalledWith(
      "pi_inv",
      expect.objectContaining({ description: "Distribute credit top-up" }),
      expect.anything()
    );
  });

  it("stamps the caller's own metadata onto the PaymentIntent, not just the invoice", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    queueHappyStripe();

    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_prov" })
      .send({
        amount: 5000,
        currency: "usd",
        description: "Month-end settlement",
        metadata: { reason: "month_end_sweep", month: "2026-07" },
      });

    expect(res.status).toBe(200);
    // Invoice keeps carrying it (unchanged behaviour)...
    expect(stripeMock.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { reason: "month_end_sweep", month: "2026-07", org_id: TEST_ORG_ID },
      }),
      expect.anything()
    );
    // ...and it now reaches the PaymentIntent too, with the invoice back-reference.
    expect(stripeMock.paymentIntents.update).toHaveBeenCalledWith(
      "pi_inv",
      {
        metadata: {
          reason: "month_end_sweep",
          month: "2026-07",
          org_id: TEST_ORG_ID,
          invoice_id: "in_1",
        },
        description: "Month-end settlement",
      },
      expect.objectContaining({ idempotencyKey: "topup_prov:pi-provenance" })
    );
  });

  it("mirrors the stamped PaymentIntent (provenance reaches silver, not just Stripe)", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    stripeMock.invoices.create.mockResolvedValueOnce({ id: "in_1", status: "draft" });
    stripeMock.invoiceItems.create.mockResolvedValueOnce({ id: "ii_1" });
    stripeMock.invoices.finalizeInvoice.mockResolvedValueOnce({ id: "in_1", status: "open" });
    stripeMock.invoices.pay.mockResolvedValueOnce({
      id: "in_1",
      object: "invoice",
      status: "paid",
      payments: { object: "list", data: [{ payment: { payment_intent: "pi_inv" } }] },
    });
    stripeMock.paymentIntents.update.mockResolvedValueOnce({
      id: "pi_inv",
      object: "payment_intent",
      status: "succeeded",
      amount_received: 5000,
      description: "Auto top-up",
      metadata: { type: "auto_reload", org_id: TEST_ORG_ID, invoice_id: "in_1" },
    });

    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_mirror" })
      .send({
        amount: 5000,
        currency: "usd",
        description: "Auto top-up",
        metadata: { type: "auto_reload" },
      });

    expect(res.status).toBe(200);
    // Bronze api_snapshot event carries the STAMPED PaymentIntent — that event
    // is what silver projects from, so the mirror shows the provenance.
    const event = dbMock.lastInsertValues("events");
    expect(event.type).toBe("api_snapshot.payment_intent");
    expect(event.objectId).toBe("pi_inv");
    expect(event.payload.data.object.metadata).toEqual({
      type: "auto_reload",
      org_id: TEST_ORG_ID,
      invoice_id: "in_1",
    });
    // Same for the description: consumers render the MIRROR, so a description
    // that only existed on the live Stripe object would never be read.
    expect(event.payload.data.object.description).toBe("Auto top-up");
  });

  it("forwards an explicit payment_method to the invoice default + the pay call", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    queueHappyStripe();

    await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_pm" })
      .send({ amount: 5000, currency: "usd", description: "Top-up", payment_method: "pm_card_1" });

    expect(stripeMock.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ default_payment_method: "pm_card_1" }),
      expect.anything()
    );
    expect(stripeMock.invoices.pay).toHaveBeenCalledWith(
      "in_1",
      { off_session: true, expand: ["payments"], payment_method: "pm_card_1" },
      expect.anything()
    );
  });

  it("returns 400 when the Idempotency-Key header is missing (no Stripe calls)", async () => {
    // No customer queued: the route rejects at the idempotency check, BEFORE the
    // customer select — queuing one would leak into the next test's select.
    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY })
      .send({ amount: 5000, currency: "usd", description: "Top-up" });

    expect(res.status).toBe(400);
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it("returns 400 on an invalid body (missing amount)", async () => {
    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_bad" })
      .send({ currency: "usd", description: "Top-up" });

    expect(res.status).toBe(400);
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it("returns 404 when the org has no customer (no Stripe calls)", async () => {
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_nocust" })
      .send({ amount: 5000, currency: "usd", description: "Top-up" });

    expect(res.status).toBe(404);
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it("rejects with 401 when X-API-Key is missing", async () => {
    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "Idempotency-Key": "topup_noauth" })
      .send({ amount: 5000, currency: "usd", description: "Top-up" });

    expect(res.status).toBe(401);
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it("fails loud (non-2xx) when the off-session payment is declined", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    stripeMock.invoices.create.mockResolvedValueOnce({ id: "in_1", status: "draft" });
    stripeMock.invoiceItems.create.mockResolvedValueOnce({ id: "ii_1" });
    stripeMock.invoices.finalizeInvoice.mockResolvedValueOnce({ id: "in_1", status: "open" });
    const declined = new Error("Your card was declined.") as Error & { statusCode?: number };
    declined.statusCode = 402;
    stripeMock.invoices.pay.mockRejectedValueOnce(declined);

    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_declined" })
      .send({ amount: 5000, currency: "usd", description: "Top-up" });

    // A declined off_session charge propagates as a non-2xx (Stripe 402) — fail
    // loud, the caller retries (idempotent) or surfaces the decline.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
    expect(stripeMock.invoices.pay).toHaveBeenCalled();
  });

  it("fails loud when the provenance stamp fails — never silently drops it", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    stripeMock.invoices.create.mockResolvedValueOnce({ id: "in_1", status: "draft" });
    stripeMock.invoiceItems.create.mockResolvedValueOnce({ id: "ii_1" });
    stripeMock.invoices.finalizeInvoice.mockResolvedValueOnce({ id: "in_1", status: "open" });
    stripeMock.invoices.pay.mockResolvedValueOnce({
      id: "in_1",
      object: "invoice",
      status: "paid",
      payments: { object: "list", data: [{ payment: { payment_intent: "pi_inv" } }] },
    });
    stripeMock.paymentIntents.update.mockRejectedValueOnce(new Error("Stripe transient"));

    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_stampfail" })
      .send({ amount: 5000, currency: "usd", description: "Top-up", metadata: { type: "auto_reload" } });

    // Stripe emits no event for a metadata update, so a swallowed failure here
    // would drop the caller's provenance permanently. Failing is safe: every
    // Stripe step is idempotency-keyed, so the caller's retry replays them.
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("fails loud when the paid invoice references no PaymentIntent", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    stripeMock.invoices.create.mockResolvedValueOnce({ id: "in_1", status: "draft" });
    stripeMock.invoiceItems.create.mockResolvedValueOnce({ id: "ii_1" });
    stripeMock.invoices.finalizeInvoice.mockResolvedValueOnce({ id: "in_1", status: "open" });
    stripeMock.invoices.pay.mockResolvedValueOnce({
      id: "in_1",
      object: "invoice",
      status: "paid",
      payments: { object: "list", data: [] },
    });

    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_nopi" })
      .send({ amount: 5000, currency: "usd", description: "Top-up" });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(stripeMock.paymentIntents.update).not.toHaveBeenCalled();
  });
});

describe("GET /internal/payment_methods/by-org/:orgId (user-less)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.paymentMethods.list.mockReset();
  });

  it("lists the org customer's PaymentMethods via the platform key, X-API-Key only", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    stripeMock.paymentMethods.list.mockResolvedValueOnce({
      object: "list",
      data: [{ id: "pm_card", type: "card", customer: "cus_x" }],
      has_more: false,
      url: "/v1/payment_methods",
    });

    const res = await request(app)
      .get(`/internal/payment_methods/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body.data[0].id).toBe("pm_card");
    expect(stripeMock.paymentMethods.list).toHaveBeenCalledWith({ customer: "cus_x" });
  });

  it("forwards type=card to the Stripe SDK", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    stripeMock.paymentMethods.list.mockResolvedValueOnce({
      object: "list",
      data: [],
      has_more: false,
      url: "/v1/payment_methods",
    });

    await request(app)
      .get(`/internal/payment_methods/by-org/${TEST_ORG_ID}?type=card`)
      .set(apiKeyOnly());

    expect(stripeMock.paymentMethods.list).toHaveBeenCalledWith({ customer: "cus_x", type: "card" });
  });

  it("returns 404 when the org has no customer (no Stripe call)", async () => {
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .get(`/internal/payment_methods/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(404);
    expect(stripeMock.paymentMethods.list).not.toHaveBeenCalled();
  });
});

describe("POST /internal/invoices/by-org/:orgId — acquirer dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.clearQueues();
  });

  it("charges a Revolut-pinned org through Revolut and says there is no invoice", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);

    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly())
      .set("Idempotency-Key", "k-1")
      .send({ amount: 50000, currency: "usd", description: "top-up" });

    // The Revolut client is not mocked here, so the call fails outward — what
    // this asserts is the DISPATCH: a Revolut org must not be sent down the
    // Stripe invoice path, which would charge the wrong acquirer.
    expect(stripeMock.invoices?.create).not.toHaveBeenCalled();
  });

  it("still requires an Idempotency-Key before doing anything at all", async () => {
    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly())
      .send({ amount: 50000, currency: "usd", description: "top-up" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key/);
  });
});

describe("POST /internal/charges/by-org/:orgId (vendor-neutral charge)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.clearQueues();
    stripeMock.invoices.create.mockReset();
    stripeMock.invoices.finalizeInvoice.mockReset();
    stripeMock.invoices.pay.mockReset();
    stripeMock.invoiceItems.create.mockReset();
    stripeMock.paymentIntents.update.mockReset();
  });

  function queueHappyStripeInvoice() {
    stripeMock.invoices.create.mockResolvedValueOnce({ id: "in_9", status: "draft" });
    stripeMock.invoiceItems.create.mockResolvedValueOnce({ id: "ii_9" });
    stripeMock.invoices.finalizeInvoice.mockResolvedValueOnce({ id: "in_9", status: "open" });
    stripeMock.invoices.pay.mockResolvedValueOnce({
      id: "in_9",
      object: "invoice",
      status: "paid",
      payments: {
        object: "list",
        data: [{ id: "inpay_9", payment: { type: "payment_intent", payment_intent: "pi_9" } }],
      },
      hosted_invoice_url: "https://pay.stripe.com/i/in_9",
    });
    stripeMock.paymentIntents.update.mockResolvedValueOnce({
      id: "pi_9",
      object: "payment_intent",
      status: "succeeded",
    });
  }

  it("charges an org on the DEFAULT acquirer and reports where its hosted document is", async () => {
    // No pin row: absent means Stripe, which is where nearly every org is.
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    queueHappyStripeInvoice();

    const res = await request(app)
      .post(`/internal/charges/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_n1" })
      .send({ amount: 5000, currency: "usd", description: "Auto top-up" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: "charge_result",
      org_id: TEST_ORG_ID,
      acquirer: "stripe",
      reference: "in_9",
      status: "succeeded",
      amount: 5000,
      currency: "usd",
      hosted_document_url: "https://pay.stripe.com/i/in_9",
    });
  });

  it("takes the money the same way the invoiced route does, provenance and all", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    queueHappyStripeInvoice();

    await request(app)
      .post(`/internal/charges/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_n2" })
      .send({ amount: 5000, currency: "usd", description: "Auto top-up" });

    expect(stripeMock.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_x", pending_invoice_items_behavior: "exclude" }),
      expect.objectContaining({ idempotencyKey: "topup_n2:invoice" })
    );
    expect(stripeMock.invoices.pay).toHaveBeenCalledWith(
      "in_9",
      { off_session: true, expand: ["payments"] },
      expect.objectContaining({ idempotencyKey: "topup_n2:pay" })
    );
    expect(stripeMock.paymentIntents.update).toHaveBeenCalledWith(
      "pi_9",
      { metadata: { org_id: TEST_ORG_ID, invoice_id: "in_9" }, description: "Auto top-up" },
      expect.objectContaining({ idempotencyKey: "topup_n2:pi-provenance" })
    );
  });

  it("no longer refuses a Stripe org by pointing at the invoiced route", async () => {
    dbMock.queueSelect("org_acquirers", [{ acquirer: "stripe", customerId: null }]);
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    queueHappyStripeInvoice();

    const res = await request(app)
      .post(`/internal/charges/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_n3" })
      .send({ amount: 5000, currency: "usd", description: "Auto top-up" });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/invoices\/by-org/);
  });

  it("does not send a Revolut org down the Stripe invoice path", async () => {
    dbMock.queueSelect("org_acquirers", [{ acquirer: "revolut", customerId: "cus-rev-1" }]);

    await request(app)
      .post(`/internal/charges/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_n4" })
      .send({ amount: 5000, currency: "usd", description: "Auto top-up" });

    // The Revolut client is not mocked here, so the call fails outward — what
    // this asserts is the DISPATCH: money must not leave through the acquirer
    // that does not hold this org's card.
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it("refuses before charging anything when there is no Idempotency-Key", async () => {
    const res = await request(app)
      .post(`/internal/charges/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY })
      .send({ amount: 5000, currency: "usd", description: "Auto top-up" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key/);
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it("404s an org with no customer on its acquirer, without calling Stripe", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", []);

    const res = await request(app)
      .post(`/internal/charges/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_n5" })
      .send({ amount: 5000, currency: "usd", description: "Auto top-up" });

    expect(res.status).toBe(404);
    expect(stripeMock.invoices.create).not.toHaveBeenCalled();
  });

  it("reports a Stripe charge that did not complete as failed, not as a missing document", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    stripeMock.invoices.create.mockResolvedValueOnce({ id: "in_8", status: "draft" });
    stripeMock.invoiceItems.create.mockResolvedValueOnce({ id: "ii_8" });
    stripeMock.invoices.finalizeInvoice.mockResolvedValueOnce({ id: "in_8", status: "open" });
    stripeMock.invoices.pay.mockResolvedValueOnce({
      id: "in_8",
      object: "invoice",
      status: "open",
      payments: {
        object: "list",
        data: [{ id: "inpay_8", payment: { type: "payment_intent", payment_intent: "pi_8" } }],
      },
      hosted_invoice_url: "https://pay.stripe.com/i/in_8",
    });
    stripeMock.paymentIntents.update.mockResolvedValueOnce({ id: "pi_8", object: "payment_intent" });

    const res = await request(app)
      .post(`/internal/charges/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_n6" })
      .send({ amount: 5000, currency: "usd", description: "Auto top-up" });

    expect(res.body.status).toBe("failed");
    // A document that exists is still reported: absence means "no such thing",
    // and it must not be how a caller reads a failure.
    expect(res.body.hosted_document_url).toBe("https://pay.stripe.com/i/in_8");
  });

  it("rejects with 401 when X-API-Key is missing", async () => {
    const res = await request(app)
      .post(`/internal/charges/by-org/${TEST_ORG_ID}`)
      .set({ "Idempotency-Key": "topup_n7" })
      .send({ amount: 5000, currency: "usd", description: "Auto top-up" });
    expect(res.status).toBe(401);
  });
});
