import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
const getOrder = vi.fn();
vi.mock("../../src/lib/revolut-client", () => ({
  getOrder: (...args: unknown[]) => getOrder(...args),
}));

import {
  feeAmountOf,
  resolveRevolutOrgId,
  recordRevolutObject,
  fetchAndMirrorOrder,
} from "../../src/lib/revolut-processor";

// The payment Revolut actually returned for the 2026-08-30 production test.
const REAL_PAYMENT = {
  id: "6a93e991-8f91-aee4-b0c4-fb8dc1938a4d",
  type: "payment",
  state: "completed",
  amount: 500,
  currency: "USD",
  refunded_amount: 0,
  outstanding_amount: 0,
  updated_at: "2026-08-30T08:32:14.141919Z",
  created_at: "2026-08-30T08:28:01.545390Z",
  metadata: { org_id: "org-a", purpose: "integration-shape-discovery" },
  payments: [
    {
      id: "6a93ea4b-d3d7-a3d5-b1d0-a6a401f7ed55",
      state: "captured",
      amount: 500,
      settled_amount: 472,
      settled_currency: "USD",
      fees: [{ type: "acquiring", amount: 28, currency: "USD" }],
      payment_method: { type: "revolut_pay_account" },
    },
  ],
};

// The refund object, which is a TOP-LEVEL order carrying related_order_id —
// not a nested entry on the payment.
const REAL_REFUND = {
  id: "6a93ea8d-25da-a943-a612-0185a23ef905",
  type: "refund",
  state: "failed",
  amount: 500,
  currency: "USD",
  outstanding_amount: 500,
  updated_at: "2026-08-30T08:32:14.177476Z",
  related_order_id: REAL_PAYMENT.id,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  dbMock.clearCaptured();
});

describe("feeAmountOf", () => {
  it("reads the acquiring fee off the payment, where Revolut puts it", () => {
    expect(feeAmountOf(REAL_PAYMENT)).toBe(28);
  });

  it("SUMS every fee entry rather than taking the first", () => {
    expect(
      feeAmountOf({
        id: "x",
        payments: [{ fees: [{ amount: 28 }, { amount: 7 }] }],
      })
    ).toBe(35);
  });

  it("is null for an order that has not settled, which is not a fee of zero", () => {
    expect(feeAmountOf({ id: "x" })).toBeNull();
    expect(feeAmountOf({ id: "x", payments: [] })).toBeNull();
    expect(feeAmountOf({ id: "x", payments: [{ fees: [] }] })).toBeNull();
  });
});

describe("resolveRevolutOrgId", () => {
  it("takes the org straight off a payment's own metadata", async () => {
    expect(await resolveRevolutOrgId(REAL_PAYMENT)).toBe("org-a");
  });

  it("inherits a refund's org from the payment it reverses", async () => {
    dbMock.queueSelect("revolut_orders", [{ orgId: "org-a" }]);
    expect(await resolveRevolutOrgId(REAL_REFUND)).toBe("org-a");
  });

  it("returns null rather than inventing a tenant when nothing answers", async () => {
    dbMock.queueSelect("revolut_orders", []);
    expect(await resolveRevolutOrgId(REAL_REFUND)).toBeNull();
    expect(await resolveRevolutOrgId({ id: "orphan" })).toBeNull();
  });
});

describe("recordRevolutObject", () => {
  it("stores the payload verbatim in bronze before projecting", async () => {
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);

    await recordRevolutObject("order", REAL_PAYMENT, "poll");

    const stored = dbMock.lastInsertValues("revolut_object_snapshots");
    expect(stored.objectKind).toBe("order");
    expect(stored.objectId).toBe(REAL_PAYMENT.id);
    expect(stored.payload).toEqual(REAL_PAYMENT);
    expect(stored.objectUpdatedAt).toEqual(new Date(REAL_PAYMENT.updated_at));
  });

  it("keys bronze on the payload so an identical re-read cannot duplicate", async () => {
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);
    await recordRevolutObject("order", REAL_PAYMENT, "poll");
    const first = dbMock.lastInsertValues("revolut_object_snapshots").id;

    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);
    await recordRevolutObject("order", REAL_PAYMENT, "webhook");
    const second = dbMock.lastInsertValues("revolut_object_snapshots").id;

    expect(second).toBe(first);
  });

  it("gives a changed object a different bronze row", async () => {
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);
    await recordRevolutObject("order", REAL_PAYMENT, "poll");
    const first = dbMock.lastInsertValues("revolut_object_snapshots").id;

    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);
    await recordRevolutObject(
      "order",
      { ...REAL_PAYMENT, state: "cancelled" },
      "poll"
    );
    expect(dbMock.lastInsertValues("revolut_object_snapshots").id).not.toBe(first);
  });

  it("captures a dispute in bronze but projects no silver for it", async () => {
    await recordRevolutObject("dispute", { id: "dp-1" }, "poll");

    expect(dbMock.lastInsertValues("revolut_object_snapshots").objectKind).toBe(
      "dispute"
    );
    // No dispute payload has ever been observed, so nothing is projected.
    expect(dbMock.lastInsertValues("revolut_orders")).toBeUndefined();
  });
});

describe("silver projection", () => {
  it("lands a payment's money fields where consumers can read them", async () => {
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);

    await recordRevolutObject("order", REAL_PAYMENT, "poll");

    const row = dbMock.lastInsertValues("revolut_orders");
    expect(row).toMatchObject({
      id: REAL_PAYMENT.id,
      type: "payment",
      state: "completed",
      orgId: "org-a",
      amount: 500,
      currency: "USD",
      settledAmount: 472,
      feeAmount: 28,
      paymentMethodType: "revolut_pay_account",
    });
  });

  it("projects a refund as its own row joined by related_order_id", async () => {
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_REFUND }]);
    dbMock.queueSelect("revolut_orders", [{ orgId: "org-a" }]);

    await recordRevolutObject("order", REAL_REFUND, "webhook");

    expect(dbMock.lastInsertValues("revolut_orders")).toMatchObject({
      id: REAL_REFUND.id,
      type: "refund",
      state: "failed",
      relatedOrderId: REAL_PAYMENT.id,
      orgId: "org-a",
    });
  });
});

describe("fetchAndMirrorOrder", () => {
  it("re-reads the parent too, because refunded_amount only moves there", async () => {
    getOrder.mockImplementation((id: string) =>
      Promise.resolve(id === REAL_REFUND.id ? REAL_REFUND : REAL_PAYMENT)
    );
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_REFUND }]);
    dbMock.queueSelect("revolut_orders", [{ orgId: "org-a" }]);
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);

    await fetchAndMirrorOrder(REAL_REFUND.id, "webhook");

    expect(getOrder).toHaveBeenCalledWith(REAL_REFUND.id);
    expect(getOrder).toHaveBeenCalledWith(REAL_PAYMENT.id);
  });

  it("does not chase a parent for a plain payment", async () => {
    getOrder.mockResolvedValue(REAL_PAYMENT);
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);

    await fetchAndMirrorOrder(REAL_PAYMENT.id, "poll");

    expect(getOrder).toHaveBeenCalledTimes(1);
  });
});
