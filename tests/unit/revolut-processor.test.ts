import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
const getOrder = vi.fn();
const cancelOrder = vi.fn().mockResolvedValue({});
vi.mock("../../src/lib/revolut-client", () => ({
  getOrder: (...args: unknown[]) => getOrder(...args),
  cancelOrder: (...args: unknown[]) => cancelOrder(...args),
}));

import {
  feeAmountOf,
  revolutOrgIdOf,
  mirrorOrderById,
  recordDisputeSnapshot,
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
  refunded_amount: 0,
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

describe("revolutOrgIdOf", () => {
  it("takes the org straight off a payment's own metadata", () => {
    expect(revolutOrgIdOf(REAL_PAYMENT)).toBe("org-a");
  });

  it("leaves a refund's org NULL — the tenant is joined, never copied", () => {
    // Copying it would reintroduce an ordering dependency: the back-fill walks
    // newest-first, so a refund is mirrored BEFORE its payment and a copied
    // tenant is written null forever. Observed in production on first deploy.
    expect(revolutOrgIdOf(REAL_REFUND)).toBeNull();
  });

  it("never invents a tenant for an order with no metadata", () => {
    expect(revolutOrgIdOf({ id: "orphan" })).toBeNull();
    expect(revolutOrgIdOf({ id: "x", metadata: {} })).toBeNull();
  });
});

describe("the detail-only invariant is structural, not sniffed", () => {
  // A cancelled or never-paid order's DETAIL has neither `payments` nor
  // `refunded_amount` — byte-identical in shape to a list entry. Verified in
  // production when a payload-sniffing guard rejected a real ORDER_CANCELLED
  // delivery. There is no discriminator in the data, so the only defence is
  // that nothing can hand an order payload in: it is always fetched by id.
  const CANCELLED_DETAIL = {
    id: "6a93f223-c627-a837-a295-8f4ee0e9d10b",
    type: "payment",
    state: "cancelled",
    amount: 100,
    currency: "USD",
    updated_at: "2026-08-30T09:04:40.000000Z",
  };

  it("mirrors a cancelled order that carries neither payments nor refunded_amount", async () => {
    getOrder.mockResolvedValue(CANCELLED_DETAIL);
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: CANCELLED_DETAIL }]);

    await mirrorOrderById(CANCELLED_DETAIL.id, "webhook");

    expect(dbMock.lastInsertValues("revolut_orders")).toMatchObject({
      id: CANCELLED_DETAIL.id,
      state: "cancelled",
    });
  });

  it("always asks Revolut rather than trusting a payload it was handed", async () => {
    getOrder.mockResolvedValue(REAL_PAYMENT);
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);

    await mirrorOrderById(REAL_PAYMENT.id, "poll");

    expect(getOrder).toHaveBeenCalledWith(REAL_PAYMENT.id);
  });
});

describe("bronze capture", () => {
  it("stores the payload verbatim in bronze before projecting", async () => {
    getOrder.mockResolvedValue(REAL_PAYMENT);
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);

    await mirrorOrderById(REAL_PAYMENT.id, "poll");

    const stored = dbMock.lastInsertValues("revolut_object_snapshots");
    expect(stored.objectKind).toBe("order");
    expect(stored.objectId).toBe(REAL_PAYMENT.id);
    expect(stored.payload).toEqual(REAL_PAYMENT);
    expect(stored.objectUpdatedAt).toEqual(new Date(REAL_PAYMENT.updated_at));
  });

  it("keys bronze on the payload so an identical re-read cannot duplicate", async () => {
    getOrder.mockResolvedValue(REAL_PAYMENT);
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);
    await mirrorOrderById(REAL_PAYMENT.id, "poll");
    const first = dbMock.lastInsertValues("revolut_object_snapshots").id;

    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);
    await mirrorOrderById(REAL_PAYMENT.id, "webhook");
    const second = dbMock.lastInsertValues("revolut_object_snapshots").id;

    expect(second).toBe(first);
  });

  it("gives a changed object a different bronze row", async () => {
    getOrder.mockResolvedValue(REAL_PAYMENT);
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);
    await mirrorOrderById(REAL_PAYMENT.id, "poll");
    const first = dbMock.lastInsertValues("revolut_object_snapshots").id;

    getOrder.mockResolvedValue({ ...REAL_PAYMENT, state: "cancelled" });
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);
    await mirrorOrderById(REAL_PAYMENT.id, "poll");
    expect(dbMock.lastInsertValues("revolut_object_snapshots").id).not.toBe(first);
  });

  it("captures a dispute in bronze but projects no silver for it", async () => {
    await recordDisputeSnapshot({ id: "dp-1" }, "poll");

    expect(dbMock.lastInsertValues("revolut_object_snapshots").objectKind).toBe(
      "dispute"
    );
    // No dispute payload has ever been observed, so nothing is projected.
    expect(dbMock.lastInsertValues("revolut_orders")).toBeUndefined();
  });
});

describe("silver projection", () => {
  it("lands a payment's money fields where consumers can read them", async () => {
    getOrder.mockResolvedValue(REAL_PAYMENT);
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);

    await mirrorOrderById(REAL_PAYMENT.id, "poll");

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

  it("projects a refund as its own row carrying the join key, not a copied org", async () => {
    getOrder.mockImplementation((id: string) =>
      Promise.resolve(id === REAL_REFUND.id ? REAL_REFUND : REAL_PAYMENT)
    );
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_REFUND }]);

    await mirrorOrderById(REAL_REFUND.id, "webhook");

    expect(dbMock.lastInsertValues("revolut_orders")).toMatchObject({
      id: REAL_REFUND.id,
      type: "refund",
      state: "failed",
      relatedOrderId: REAL_PAYMENT.id,
      orgId: null,
    });
  });
});

describe("mirrorOrderById — parent chasing", () => {
  it("re-reads the parent too, because refunded_amount only moves there", async () => {
    getOrder.mockImplementation((id: string) =>
      Promise.resolve(id === REAL_REFUND.id ? REAL_REFUND : REAL_PAYMENT)
    );
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_REFUND }]);
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);

    await mirrorOrderById(REAL_REFUND.id, "webhook");

    expect(getOrder).toHaveBeenCalledWith(REAL_REFUND.id);
    expect(getOrder).toHaveBeenCalledWith(REAL_PAYMENT.id);
  });

  it("does not chase a parent for a plain payment", async () => {
    getOrder.mockResolvedValue(REAL_PAYMENT);
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: REAL_PAYMENT }]);

    await mirrorOrderById(REAL_PAYMENT.id, "poll");

    expect(getOrder).toHaveBeenCalledTimes(1);
  });
});

describe("mergeCurrencyTotals", () => {
  const row = (currency: string, received: number) => ({
    currency,
    amount_received: received,
    amount_refunded: 0,
    amount_disputed_lost: 0,
    amount_returned: 0,
    amount_net: received,
  });

  it("folds the acquirers' different spellings of one currency together", async () => {
    const { mergeCurrencyTotals } = await import("../../src/lib/revolut-money");
    // Stripe reports `usd`, Revolut reports `USD`. Two entries for one currency
    // is the quiet way to halve a balance.
    expect(mergeCurrencyTotals([row("usd", 100)], [row("USD", 500)])).toEqual([
      { ...row("usd", 600) },
    ]);
  });

  it("still keeps genuinely different currencies apart", async () => {
    const { mergeCurrencyTotals } = await import("../../src/lib/revolut-money");
    const out = mergeCurrencyTotals([row("usd", 100)], [row("EUR", 500)]);
    expect(out.map((r) => r.currency)).toEqual(["eur", "usd"]);
  });
});

describe("releasing the card-verification hold", () => {
  const setupOrder = (over = {}) => ({
    id: "ord-setup",
    state: "authorised",
    metadata: { purpose: "card-setup" },
    updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    ...over,
  });

  it("does NOT cancel on the webhook — that cancels it under the customer", async () => {
    // Cancelling the moment the authorisation lands leaves the customer's page
    // reporting a failure and the card unsaved, because the order it was being
    // saved against no longer exists. Verified in production, twice.
    const order = {
      id: "ord-setup",
      type: "payment",
      state: "authorised",
      amount: 100,
      currency: "USD",
      refunded_amount: 0,
      updated_at: "2026-08-30T18:38:42.000000Z",
      metadata: { org_id: "org-a", purpose: "card-setup" },
    };
    getOrder.mockResolvedValue(order);
    dbMock.queueSelect("revolut_object_snapshots", [{ payload: order }]);

    await mirrorOrderById(order.id, "webhook");

    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it("releases a hold once the flow has certainly finished", async () => {
    const { releaseSettledCardSetupHolds } = await import(
      "../../src/lib/revolut-processor"
    );
    dbMock.queueSelect("revolut_orders", [setupOrder()]);

    expect(await releaseSettledCardSetupHolds()).toBe(1);
    expect(cancelOrder).toHaveBeenCalledWith("ord-setup");
  });

  it("leaves a hold alone while the customer could still be in the flow", async () => {
    const { releaseSettledCardSetupHolds } = await import(
      "../../src/lib/revolut-processor"
    );
    dbMock.queueSelect("revolut_orders", [
      setupOrder({ updatedAt: new Date(Date.now() - 30 * 1000) }),
    ]);

    expect(await releaseSettledCardSetupHolds()).toBe(0);
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it("never cancels a real payment, however old", async () => {
    const { releaseSettledCardSetupHolds } = await import(
      "../../src/lib/revolut-processor"
    );
    dbMock.queueSelect("revolut_orders", [
      setupOrder({ metadata: { purpose: "manual-topup" } }),
    ]);

    expect(await releaseSettledCardSetupHolds()).toBe(0);
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it("keeps going when one release fails", async () => {
    const { releaseSettledCardSetupHolds } = await import(
      "../../src/lib/revolut-processor"
    );
    cancelOrder.mockRejectedValueOnce(new Error("cancel failed"));
    dbMock.queueSelect("revolut_orders", [
      setupOrder({ id: "a" }),
      setupOrder({ id: "b" }),
    ]);

    expect(await releaseSettledCardSetupHolds()).toBe(1);
  });
});
