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
  processEvent: vi.fn(async () => true),
}));

import { pollOnce } from "../../src/lib/event-poller";
import { processEvent } from "../../src/lib/event-processor";

beforeEach(() => {
  vi.clearAllMocks();
});

function agedOutError() {
  return Object.assign(new Error("aged out"), {
    code: "resource_missing",
    param: "ending_before",
  });
}

const processEventMock = processEvent as ReturnType<typeof vi.fn>;

beforeEach(() => {
  dbMock.clearQueues();
  dbMock.clearCaptured();
  processEventMock.mockImplementation(async () => true);
});

describe("pollOnce", () => {
  it("walks FORWARD from the cursor (ending_before), never back into history", async () => {
    // Stripe lists newest-first: `starting_after` pages to OLDER events. The
    // poller used it and so re-read history behind its cursor (prod 2026-11-03).
    dbMock.queueSelect("event_sync_cursor", [{ id: 1, lastEventId: "evt_old" }]);
    stripeMock.events.list.mockResolvedValueOnce({
      data: [
        { id: "evt_b", type: "charge.succeeded" },
        { id: "evt_a", type: "customer.created" },
      ],
      has_more: false,
    });

    const processed = await pollOnce();

    expect(stripeMock.events.list).toHaveBeenCalledTimes(1);
    expect(stripeMock.events.list).toHaveBeenCalledWith({
      limit: 100,
      ending_before: "evt_old",
    });
    // Oldest-first processing order.
    expect(processEventMock.mock.calls[0][0]).toMatchObject({ id: "evt_a" });
    expect(processEventMock.mock.calls[1][0]).toMatchObject({ id: "evt_b" });
    expect(processed).toBe(2);

    const cursorWrite = dbMock.lastInsertValues("event_sync_cursor");
    expect(cursorWrite).toMatchObject({ id: 1, lastEventId: "evt_b" });
  });

  it("follows every newer page in one poll, cursor on the newest seen", async () => {
    dbMock.queueSelect("event_sync_cursor", [{ id: 1, lastEventId: "evt_old" }]);
    stripeMock.events.list
      .mockResolvedValueOnce({ data: [{ id: "evt_2" }, { id: "evt_1" }], has_more: true })
      .mockResolvedValueOnce({ data: [{ id: "evt_3" }], has_more: false });

    const processed = await pollOnce();

    expect(stripeMock.events.list).toHaveBeenNthCalledWith(2, {
      limit: 100,
      ending_before: "evt_2",
    });
    expect(processEventMock.mock.calls.map((c) => c[0].id)).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(processed).toBe(3);
    expect(dbMock.lastInsertValues("event_sync_cursor")).toMatchObject({ lastEventId: "evt_3" });
  });

  it("survives an event whose side-effect throws: the others run and the cursor advances", async () => {
    // Prod 2026-10-29 → 2026-11-03: a setup_intent.succeeded naming a DETACHED
    // card threw on every poll and froze the cursor for five days.
    dbMock.queueSelect("event_sync_cursor", [{ id: 1, lastEventId: "evt_old" }]);
    stripeMock.events.list.mockResolvedValueOnce({
      data: [
        { id: "evt_c", type: "payment_method.detached" },
        { id: "evt_bad", type: "setup_intent.succeeded" },
        { id: "evt_a", type: "customer.updated" },
      ],
      has_more: false,
    });
    processEventMock.mockImplementation(async (evt: { id: string }) => {
      if (evt.id === "evt_bad") {
        throw Object.assign(
          new Error(
            "This PaymentMethod was previously used without being attached to a Customer or was detached from a Customer, and may not be used again."
          ),
          { type: "StripeInvalidRequestError", statusCode: 400 }
        );
      }
      return true;
    });

    const processed = await pollOnce();

    expect(processEventMock.mock.calls.map((c) => c[0].id)).toEqual(["evt_a", "evt_bad", "evt_c"]);
    expect(processed).toBe(2);
    expect(dbMock.lastInsertValues("event_sync_cursor")).toMatchObject({ lastEventId: "evt_c" });
  });

  it("re-runs stored events whose side-effects never completed, one failure not stopping the rest", async () => {
    dbMock.queueSelect("event_sync_cursor", [{ id: 1, lastEventId: "evt_old" }]);
    stripeMock.events.list.mockResolvedValueOnce({ data: [], has_more: false });
    dbMock.queueSelect("events", [
      { payload: { id: "evt_stuck", type: "setup_intent.succeeded" } },
      { payload: { id: "evt_ok", type: "payment_method.detached" } },
    ]);
    processEventMock.mockImplementation(async (evt: { id: string }) => {
      if (evt.id === "evt_stuck") throw new Error("still failing");
      return true;
    });

    await pollOnce();

    expect(processEventMock.mock.calls.map((c) => c[0].id)).toEqual(["evt_stuck", "evt_ok"]);
  });

  it("resets the cursor and re-lists newest events when the stored cursor aged out", async () => {
    dbMock.queueSelect("event_sync_cursor", [{ id: 1, lastEventId: "evt_old" }]);
    stripeMock.events.list
      .mockRejectedValueOnce(agedOutError())
      .mockResolvedValueOnce({ data: [{ id: "evt_new", type: "charge.succeeded" }], has_more: true });

    const processed = await pollOnce();

    expect(stripeMock.events.list).toHaveBeenNthCalledWith(1, {
      limit: 100,
      ending_before: "evt_old",
    });
    // Second call drops the cursor entirely, and the walk stops on that page.
    expect(stripeMock.events.list).toHaveBeenNthCalledWith(2, { limit: 100 });
    expect(stripeMock.events.list).toHaveBeenCalledTimes(2);
    expect(processed).toBe(1);
    expect(dbMock.lastInsertValues("event_sync_cursor")).toMatchObject({ id: 1, lastEventId: "evt_new" });
  });

  it("does not reset when there is no stored cursor (error would not be cursor-related)", async () => {
    dbMock.queueSelect("event_sync_cursor", []);
    stripeMock.events.list.mockRejectedValueOnce(agedOutError());

    const processed = await pollOnce();

    expect(stripeMock.events.list).toHaveBeenCalledTimes(1);
    expect(stripeMock.events.list).toHaveBeenCalledWith({
      limit: 100,
      ending_before: undefined,
    });
    expect(processed).toBe(0);
  });

  it("re-throws non-cursor Stripe errors (swallowed by outer catch to 0)", async () => {
    dbMock.queueSelect("event_sync_cursor", [{ id: 1, lastEventId: "evt_old" }]);
    stripeMock.events.list.mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { code: "rate_limit" })
    );

    const processed = await pollOnce();

    expect(stripeMock.events.list).toHaveBeenCalledTimes(1);
    expect(processEvent).not.toHaveBeenCalled();
    expect(processed).toBe(0);
  });
});
