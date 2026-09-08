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
  isResourceMissing: () => false,
}));
vi.mock("../../src/lib/key-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/key-client")>();
  return {
    ...actual,
    resolvePlatformKey: vi.fn().mockResolvedValue({ key: "sk_test_platform" }),
  };
});

const revolutMock = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  listCustomerPaymentMethods: vi.fn(),
}));
vi.mock("../../src/lib/revolut-client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/lib/revolut-client")
  >();
  return { ...actual, ...revolutMock };
});

import { createTestApp } from "../helpers/test-app";

const app = createTestApp();

function apiKeyOnly(): Record<string, string> {
  return { "X-API-Key": TEST_API_KEY };
}

/** A Stripe customer whose card is chargeable off-session. */
function queueStripeOrgWithCard() {
  dbMock.queueSelect("customers", [{ id: "cus_x" }]);
  stripeMock.paymentMethods.list.mockResolvedValueOnce({
    object: "list",
    data: [{ id: "pm_card_1", object: "payment_method", type: "card" }],
  });
}

/** A Stripe customer with nothing chargeable saved: neither card nor link. */
function queueStripeOrgWithoutCard() {
  dbMock.queueSelect("customers", [{ id: "cus_x" }]);
  stripeMock.paymentMethods.list.mockResolvedValueOnce({ object: "list", data: [] });
  stripeMock.paymentMethods.list.mockResolvedValueOnce({ object: "list", data: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  dbMock.clearCaptured();
  stripeMock.paymentMethods.list.mockReset();
  revolutMock.createCustomer.mockReset();
  revolutMock.listCustomerPaymentMethods.mockReset();
});

describe("PUT /internal/acquirer/by-org/:orgId — a pin may not strand a card", () => {
  it("REFUSES to move an org that holds a chargeable card on the DEFAULT acquirer", async () => {
    // The population the old guard could never protect: a Stripe org records no
    // pin row at all, so "the other acquirer has a customer id" was false for
    // every one of them, card or no card. This is the production incident of
    // 2026-08-30 — the org kept a live Mastercard on Stripe and was told it had
    // run out of credit.
    dbMock.queueSelect("org_acquirers", []);
    queueStripeOrgWithCard();

    const res = await request(app)
      .put(`/internal/acquirer/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly())
      .send({ acquirer: "revolut", email: "a@b.com", full_name: "A B" });

    expect(res.status).toBe(409);
    // The failure names the real reason, not a generic conflict.
    expect(res.body.error).toMatch(/chargeable payment method on stripe/i);
    expect(res.body.error).toMatch(/cannot move between/i);
    // Refused BEFORE anything was created or written.
    expect(revolutMock.createCustomer).not.toHaveBeenCalled();
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });

  it("REFUSES to move an org that holds a saved method on Revolut back to Stripe", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    revolutMock.listCustomerPaymentMethods.mockResolvedValueOnce([
      { id: "pm-rev-1", type: "card" },
    ]);

    const res = await request(app)
      .put(`/internal/acquirer/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly())
      .send({ acquirer: "stripe" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/chargeable payment method on revolut/i);
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });

  it("allows the move when the org has no chargeable method to strand", async () => {
    dbMock.queueSelect("org_acquirers", []);
    queueStripeOrgWithoutCard();
    revolutMock.createCustomer.mockResolvedValueOnce({ id: "cus-rev-new" });

    const res = await request(app)
      .put(`/internal/acquirer/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly())
      .send({ acquirer: "revolut", email: "a@b.com", full_name: "A B" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: "org_acquirer",
      acquirer: "revolut",
      customer_id: "cus-rev-new",
    });
  });

  it("allows the move for an org that has no customer at all (nothing to strand)", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", []);
    revolutMock.createCustomer.mockResolvedValueOnce({ id: "cus-rev-new" });

    const res = await request(app)
      .put(`/internal/acquirer/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly())
      .send({ acquirer: "revolut", email: "a@b.com", full_name: "A B" });

    expect(res.status).toBe(200);
    // No card to look for, so no acquirer was asked about one.
    expect(stripeMock.paymentMethods.list).not.toHaveBeenCalled();
  });

  it("allows the move when the acquirer says that customer is GONE", async () => {
    // The acquirer was reachable, it answered, and its answer was definitive:
    // that customer is not there, so it holds no card and nothing can be
    // stranded. Reading it as an outage made such an org permanently
    // unmovable — the guard it must pass could never come back clean.
    // Production, 2026-09-08: the pin answered 400 with `No such customer`.
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_gone" }]);
    stripeMock.paymentMethods.list.mockRejectedValueOnce(
      Object.assign(new Error("No such customer: 'cus_gone'"), {
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        statusCode: 400,
      })
    );
    revolutMock.createCustomer.mockResolvedValueOnce({ id: "cus-rev-new" });

    const res = await request(app)
      .put(`/internal/acquirer/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly())
      .send({ acquirer: "revolut", email: "a@b.com", full_name: "A B" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ acquirer: "revolut", customer_id: "cus-rev-new" });
    // The mirror row is NOT touched: historical payments resolve through it.
    expect(dbMock.lastInsertValues("customers")).toBeUndefined();
  });

  it("allows the move when REVOLUT says that customer is gone (404)", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-gone" },
    ]);
    const { RevolutApiError } = await import("../../src/lib/revolut-client");
    revolutMock.listCustomerPaymentMethods.mockRejectedValueOnce(
      new RevolutApiError(404, "{}", "Revolut GET /customers/x failed: 404 {}")
    );

    const res = await request(app)
      .put(`/internal/acquirer/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly())
      .send({ acquirer: "stripe" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ acquirer: "stripe" });
  });

  it("does not check anything when the pin is not a MOVE (same acquirer)", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);

    const res = await request(app)
      .put(`/internal/acquirer/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly())
      .send({ acquirer: "revolut" });

    expect(res.status).toBe(200);
    expect(res.body.customer_id).toBe("cus-rev-1");
    expect(revolutMock.listCustomerPaymentMethods).not.toHaveBeenCalled();
  });

  it("propagates an acquirer we cannot reach rather than reading it as 'no card'", async () => {
    // "We could not ask" and "there is no card" are different answers, and only
    // one of them makes a move safe.
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    revolutMock.listCustomerPaymentMethods.mockRejectedValueOnce(
      new Error("Revolut unreachable")
    );

    const res = await request(app)
      .put(`/internal/acquirer/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly())
      .send({ acquirer: "stripe" });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(dbMock.lastInsertValues("org_acquirers")).toBeUndefined();
  });
});

describe("DELETE /internal/acquirer/by-org/:orgId — the supported way back", () => {
  it("returns a mis-pinned org to the default acquirer, no database access needed", async () => {
    // The production recovery, which until now was a manual row delete: the org
    // never saved a card on the acquirer it was wrongly moved to, so there is
    // nothing to strand.
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    revolutMock.listCustomerPaymentMethods.mockResolvedValueOnce([]);

    const res = await request(app)
      .delete(`/internal/acquirer/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: "org_acquirer",
      org_id: TEST_ORG_ID,
      acquirer: "stripe",
      customer_id: null,
      unpinned: true,
    });
    expect(dbMock.db.delete).toHaveBeenCalled();
  });

  it("REFUSES to return an org that holds a saved method on the acquirer it would leave", async () => {
    dbMock.queueSelect("org_acquirers", [
      { acquirer: "revolut", customerId: "cus-rev-1" },
    ]);
    revolutMock.listCustomerPaymentMethods.mockResolvedValueOnce([
      { id: "pm-rev-1", type: "card" },
    ]);

    const res = await request(app)
      .delete(`/internal/acquirer/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/chargeable payment method on revolut/i);
    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });

  it("is idempotent for an org already on the default (nothing deleted)", async () => {
    dbMock.queueSelect("org_acquirers", []);

    const res = await request(app)
      .delete(`/internal/acquirer/by-org/${TEST_ORG_ID}`)
      .set(apiKeyOnly());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ acquirer: "stripe", unpinned: false });
    expect(dbMock.db.delete).not.toHaveBeenCalled();
    // An org already on the default is not asked about its cards at all.
    expect(stripeMock.paymentMethods.list).not.toHaveBeenCalled();
  });
});
