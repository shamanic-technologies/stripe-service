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
});

describe("POST /internal/invoices/by-org/:orgId (off-session invoiced charge)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMock.invoices.create.mockReset();
    stripeMock.invoices.finalizeInvoice.mockReset();
    stripeMock.invoices.pay.mockReset();
    stripeMock.invoiceItems.create.mockReset();
    stripeMock.paymentIntents.retrieve.mockReset();
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
      payment_intent: "pi_inv",
      hosted_invoice_url: "https://pay.stripe.com/i/in_1",
      invoice_pdf: "https://pay.stripe.com/i/in_1.pdf",
    });
    stripeMock.paymentIntents.retrieve.mockResolvedValueOnce({
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
      { off_session: true },
      expect.objectContaining({ idempotencyKey: "topup_123:pay" })
    );
    // Mirror-freshness snapshot of the invoice's PaymentIntent.
    expect(stripeMock.paymentIntents.retrieve).toHaveBeenCalledWith("pi_inv");
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
      { off_session: true, payment_method: "pm_card_1" },
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

  it("still returns 200 when the post-charge PI snapshot fails (webhook reconciles)", async () => {
    dbMock.queueSelect("customers", [{ id: "cus_x" }]);
    stripeMock.invoices.create.mockResolvedValueOnce({ id: "in_1", status: "draft" });
    stripeMock.invoiceItems.create.mockResolvedValueOnce({ id: "ii_1" });
    stripeMock.invoices.finalizeInvoice.mockResolvedValueOnce({ id: "in_1", status: "open" });
    stripeMock.invoices.pay.mockResolvedValueOnce({
      id: "in_1",
      object: "invoice",
      status: "paid",
      payment_intent: "pi_inv",
    });
    stripeMock.paymentIntents.retrieve.mockRejectedValueOnce(new Error("Stripe transient"));

    const res = await request(app)
      .post(`/internal/invoices/by-org/${TEST_ORG_ID}`)
      .set({ "X-API-Key": TEST_API_KEY, "Idempotency-Key": "topup_snapfail" })
      .send({ amount: 5000, currency: "usd", description: "Top-up" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
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
