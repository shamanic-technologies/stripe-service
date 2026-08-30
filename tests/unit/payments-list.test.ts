import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import { listOrgPayments } from "../../src/lib/payments-list";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
});

const STRIPE_PI = {
  id: "pi_1",
  amount: 50000,
  currency: "usd",
  status: "succeeded",
  description: "Distribute credit top-up",
  created: 1_780_000_000,
  latestCharge: null,
};

const REVOLUT_PAYMENT = {
  id: "6a946174-e5aa-aa5e-a4d1-b9324be9ae69",
  amount: 50000,
  currency: "USD",
  state: "completed",
  description: "Distribute credit top-up",
  createdAt: new Date("2026-08-30T22:00:00.000Z"),
  refunded: 0,
};

describe("listOrgPayments", () => {
  it("shows payments from BOTH acquirers in one history", async () => {
    dbMock.queueSelect("payment_intents", [STRIPE_PI]);
    dbMock.queueSelect("revolut_orders", [REVOLUT_PAYMENT]);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);

    const out = await listOrgPayments("org-1");

    expect(out.map((p) => p.acquirer).sort()).toEqual(["revolut", "stripe"]);
  });

  it("canonicalises status, so one org's history does not read differently from another's", async () => {
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("revolut_orders", [REVOLUT_PAYMENT]);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);

    // Revolut says "completed"; a consumer must not have to know that.
    expect((await listOrgPayments("org-1"))[0].status).toBe("succeeded");
  });

  it("puts both acquirers on one time scale so the sort is meaningful", async () => {
    dbMock.queueSelect("payment_intents", [STRIPE_PI]);
    dbMock.queueSelect("revolut_orders", [REVOLUT_PAYMENT]);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);

    const out = await listOrgPayments("org-1");
    expect(out[0].created).toBeGreaterThan(out[1].created);
    // Revolut dates with an ISO string; it must not arrive as one.
    expect(typeof out[0].created).toBe("number");
  });

  it("carries what came back, per acquirer's own record of it", async () => {
    dbMock.queueSelect("payment_intents", [STRIPE_PI]);
    dbMock.queueSelect("revolut_orders", [{ ...REVOLUT_PAYMENT, refunded: 1500 }]);
    dbMock.queueSelect("refunds", [
      { id: "re_1", paymentIntent: "pi_1", charge: null, amount: 2500, status: "succeeded" },
    ]);
    dbMock.queueSelect("disputes", []);

    const out = await listOrgPayments("org-1");
    const byId = Object.fromEntries(out.map((p) => [p.id, p.amount_returned]));
    expect(byId["pi_1"]).toBe(2500);
    expect(byId[REVOLUT_PAYMENT.id]).toBe(1500);
  });

  it("leaves a Stripe-only org's history byte-identical to before", async () => {
    dbMock.queueSelect("payment_intents", [STRIPE_PI]);
    dbMock.queueSelect("revolut_orders", []);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);

    expect(await listOrgPayments("org-1")).toEqual([
      {
        id: "pi_1",
        acquirer: "stripe",
        amount: 50000,
        currency: "usd",
        status: "succeeded",
        created: 1_780_000_000,
        description: "Distribute credit top-up",
        amount_returned: 0,
      },
    ]);
  });

  it("does not list a refund as a payment", async () => {
    // On Revolut a refund is its own order. It belongs in amount_returned, not
    // in the history as a negative payment, so the query filters on type.
    dbMock.queueSelect("payment_intents", []);
    dbMock.queueSelect("revolut_orders", []);
    dbMock.queueSelect("refunds", []);
    dbMock.queueSelect("disputes", []);

    await listOrgPayments("org-1");

    const values: unknown[] = [];
    const walk = (n: unknown, seen = new Set<unknown>()) => {
      if (!n || typeof n !== "object" || seen.has(n)) return;
      seen.add(n);
      const rec = n as Record<string, unknown>;
      if ("value" in rec && "encoder" in rec) values.push(rec.value);
      for (const c of Object.values(rec)) {
        if (Array.isArray(c)) c.forEach((x) => walk(x, seen));
        else walk(c, seen);
      }
    };
    walk(dbMock.lastSelectWhere("revolut_orders"));
    expect(values).toContain("payment");
  });
});
