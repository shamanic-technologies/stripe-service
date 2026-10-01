import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_ORG_ID } from "../helpers/mocks";

/**
 * A PAID subscription invoice must reach the org's succeeded payments EXACTLY
 * once. Stripe creates the invoice's PaymentIntent itself: it carries the
 * customer and NO metadata of ours (invoice metadata does not propagate), so
 * the org can only come from the customer mirror. A webhook / poller replay of
 * the same event must not add a second payment.
 */
const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import { processEvent } from "../../src/lib/event-processor";
import { summarizeByCurrency } from "../../src/lib/returned-amounts";

const invoicePi = {
  id: "pi_sub_invoice",
  object: "payment_intent",
  customer: "cus_org",
  metadata: {},
  amount: 9900,
  amount_received: 9900,
  currency: "usd",
  status: "succeeded",
  description: "Subscription creation",
  payment_method: "pm_card",
  latest_charge: "ch_sub",
  created: 1790300000,
  livemode: true,
};

const event = {
  id: "evt_pi_sub_paid",
  type: "payment_intent.succeeded",
  api_version: "2025-09-30.clover",
  livemode: true,
  created: 1790300001,
  data: { object: invoicePi },
};

function insertCount(table: string): number {
  return dbMock.db.insert.mock.calls.filter(
    ([t]: [unknown]) =>
      (t as Record<symbol, string>)?.[Symbol.for("drizzle:Name")] === table
  ).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  dbMock.clearCaptured();
});

describe("a paid subscription invoice in the org's payments", () => {
  it("is attributed to the org through the customer mirror, though the PaymentIntent carries no org metadata", async () => {
    dbMock.queueInsert("events", [{ id: event.id }]);
    dbMock.queueSelect("customers", [{ orgId: TEST_ORG_ID }]);
    dbMock.queueSelect("events", [{ payload: event }]);

    expect(await processEvent(event as never, "webhook")).toBe(true);

    const row = dbMock.lastInsertValues("payment_intents");
    expect(row).toMatchObject({
      id: "pi_sub_invoice",
      orgId: TEST_ORG_ID,
      customer: "cus_org",
      status: "succeeded",
      amountReceived: 9900,
      currency: "usd",
    });
    expect(insertCount("payment_intents")).toBe(1);

    // What the payment summary sums for this org: one row, 9900 once.
    const totals = summarizeByCurrency(
      [{ id: row.id, currency: row.currency, status: row.status, amountReceived: row.amountReceived }],
      new Map()
    );
    expect(totals).toEqual([
      {
        currency: "usd",
        amount_received: 9900,
        amount_refunded: 0,
        amount_disputed_lost: 0,
        amount_returned: 0,
        amount_net: 9900,
      },
    ]);
  });

  it("a replayed delivery of the same event (webhook redelivery or poller) adds nothing", async () => {
    // Already stored, side-effects completed: the bronze insert collides.
    dbMock.queueInsert("events", []);
    dbMock.queueSelect("events", [{ sideEffectsCompletedAt: new Date() }]);

    expect(await processEvent(event as never, "poll")).toBe(false);
    expect(insertCount("payment_intents")).toBe(0);
  });

  it("a later event for the same PaymentIntent re-projects the ONE row (keyed on the PaymentIntent id), never a second", async () => {
    const later = { ...event, id: "evt_pi_sub_charge_updated", created: 1790300050 };
    dbMock.queueInsert("events", [{ id: later.id }]);
    dbMock.queueSelect("customers", [{ orgId: TEST_ORG_ID }]);
    dbMock.queueSelect("events", [{ payload: later }]);

    await processEvent(later as never, "webhook");

    // Upsert on payment_intents.id: same id, so the summary still holds one payment.
    expect(dbMock.lastInsertValues("payment_intents").id).toBe("pi_sub_invoice");
  });
});
