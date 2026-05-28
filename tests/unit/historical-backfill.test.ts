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
  recordApiSnapshot: vi.fn(async () => {}),
  extractOrgId: vi.fn((metadata: Record<string, unknown> | null | undefined) => {
    if (!metadata) return null;
    const v = (metadata.org_id ?? metadata.orgId) as unknown;
    return typeof v === "string" ? v : null;
  }),
  extractString: vi.fn((v: unknown) => {
    if (!v) return null;
    if (typeof v === "string") return v;
    return (v as { id?: string }).id ?? null;
  }),
  resolveOrgId: vi.fn(async (metaOrgId: string | null, _customerId: string | null) => {
    return metaOrgId ?? "unknown";
  }),
}));

import { backfillHistorical } from "../../src/lib/historical-backfill";
import { recordApiSnapshot } from "../../src/lib/event-processor";
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
  it("paginates customers, PIs, and CS and upserts each with metadata.org_id", async () => {
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

    await backfillHistorical();

    expect(stripeMock.customers.list).toHaveBeenCalledWith({ limit: 100 });
    expect(stripeMock.paymentIntents.list).toHaveBeenCalledWith({ limit: 100 });
    expect(stripeMock.checkout.sessions.list).toHaveBeenCalledWith({ limit: 100 });
    expect(stripeMock.customers.listBalanceTransactions).not.toHaveBeenCalled();

    expect(recordApiSnapshot).toHaveBeenCalledTimes(4);
    expect(recordApiSnapshot).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "cus_1" }), "customer", "org-1");
    expect(recordApiSnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "cus_2" }), "customer", "org-2");
    expect(recordApiSnapshot).toHaveBeenNthCalledWith(3, expect.objectContaining({ id: "pi_1" }), "payment_intent", "org-1");
    expect(recordApiSnapshot).toHaveBeenNthCalledWith(4, expect.objectContaining({ id: "cs_1" }), "checkout_session", "org-1");
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

    await backfillHistorical();

    expect(recordApiSnapshot).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "pi_orphan_a" }), "payment_intent", "unknown");
    expect(recordApiSnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "pi_orphan_b" }), "payment_intent", "unknown");
  });

  it("propagates errors from resolvePlatformKey", async () => {
    (resolvePlatformKey as unknown as { mockRejectedValueOnce: (err: Error) => void }).mockRejectedValueOnce(
      new Error("key-service unreachable")
    );

    await expect(backfillHistorical()).rejects.toThrow("key-service unreachable");
  });
});
