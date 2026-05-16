import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, stripeMock } = vi.hoisted(() => {
  const { makeDbMock, makeStripeMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi), stripeMock: makeStripeMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
vi.mock("../../src/lib/key-client", () => ({
  resolvePlatformKey: vi.fn(async () => ({ provider: "stripe", key: "sk_test_fake" })),
}));
vi.mock("../../src/lib/stripe-client", () => ({
  makeStripeClient: vi.fn(() => stripeMock),
}));
vi.mock("../../src/lib/event-processor", () => ({
  upsertCustomer: vi.fn(async () => {}),
  upsertPaymentIntent: vi.fn(async () => {}),
  upsertCheckoutSession: vi.fn(async () => {}),
  upsertCustomerBalanceTransaction: vi.fn(async () => {}),
}));

import { backfillHistorical } from "../../src/lib/historical-backfill";
import {
  upsertCustomer,
  upsertPaymentIntent,
  upsertCheckoutSession,
  upsertCustomerBalanceTransaction,
} from "../../src/lib/event-processor";
import { resolvePlatformKey } from "../../src/lib/key-client";

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const it of items) yield it;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("backfillHistorical", () => {
  it("paginates customers, PIs, CS and CBTs and upserts each with metadata.org_id", async () => {
    stripeMock.customers.list.mockReturnValue(
      asyncIter([
        { id: "cus_1", metadata: { org_id: "org-1" }, created: 1 },
        { id: "cus_2", metadata: { org_id: "org-2" }, created: 2 },
      ])
    );
    stripeMock.paymentIntents.list.mockReturnValue(
      asyncIter([
        { id: "pi_1", metadata: { org_id: "org-1" }, amount: 1000, currency: "usd", status: "succeeded" },
      ])
    );
    stripeMock.checkout.sessions.list.mockReturnValue(
      asyncIter([
        { id: "cs_1", metadata: { org_id: "org-1" }, mode: "payment", created: 4 },
      ])
    );

    dbMock.queueSelect("customers", [
      { id: "cus_1", orgId: "org-1" },
      { id: "cus_2", orgId: "org-2" },
    ]);
    stripeMock.customers.listBalanceTransactions.mockReturnValueOnce(
      asyncIter([
        { id: "cbtxn_1", customer: "cus_1", amount: -500, currency: "usd", type: "adjustment" },
      ])
    );
    stripeMock.customers.listBalanceTransactions.mockReturnValueOnce(asyncIter([]));

    await backfillHistorical();

    expect(stripeMock.customers.list).toHaveBeenCalledWith({ limit: 100 });
    expect(stripeMock.paymentIntents.list).toHaveBeenCalledWith({ limit: 100 });
    expect(stripeMock.checkout.sessions.list).toHaveBeenCalledWith({ limit: 100 });
    expect(stripeMock.customers.listBalanceTransactions).toHaveBeenCalledTimes(2);
    expect(stripeMock.customers.listBalanceTransactions).toHaveBeenNthCalledWith(1, "cus_1", { limit: 100 });
    expect(stripeMock.customers.listBalanceTransactions).toHaveBeenNthCalledWith(2, "cus_2", { limit: 100 });

    expect(upsertCustomer).toHaveBeenCalledTimes(2);
    expect(upsertCustomer).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "cus_1" }), "org-1");
    expect(upsertCustomer).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "cus_2" }), "org-2");

    expect(upsertPaymentIntent).toHaveBeenCalledTimes(1);
    expect(upsertPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ id: "pi_1" }), "org-1");

    expect(upsertCheckoutSession).toHaveBeenCalledTimes(1);
    expect(upsertCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ id: "cs_1" }), "org-1");

    expect(upsertCustomerBalanceTransaction).toHaveBeenCalledTimes(1);
    expect(upsertCustomerBalanceTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cbtxn_1" }),
      "org-1"
    );
  });

  it("falls back to 'unknown' orgId when metadata is null or missing org_id", async () => {
    stripeMock.customers.list.mockReturnValue(asyncIter([]));
    stripeMock.paymentIntents.list.mockReturnValue(
      asyncIter([
        { id: "pi_orphan_a", metadata: null, amount: 100, currency: "usd", status: "canceled" },
        { id: "pi_orphan_b", metadata: { foo: "bar" }, amount: 200, currency: "usd", status: "canceled" },
      ])
    );
    stripeMock.checkout.sessions.list.mockReturnValue(asyncIter([]));
    dbMock.queueSelect("customers", []);

    await backfillHistorical();

    expect(upsertPaymentIntent).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "pi_orphan_a" }), "unknown");
    expect(upsertPaymentIntent).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "pi_orphan_b" }), "unknown");
  });

  it("propagates errors from resolvePlatformKey (fail-loud, no swallow)", async () => {
    (resolvePlatformKey as unknown as { mockRejectedValueOnce: (err: Error) => void }).mockRejectedValueOnce(
      new Error("key-service unreachable")
    );

    await expect(backfillHistorical()).rejects.toThrow("key-service unreachable");
  });
});
