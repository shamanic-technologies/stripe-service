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
    param: "starting_after",
  });
}

describe("pollOnce", () => {
  it("resets the cursor and re-lists newest events when the stored cursor aged out", async () => {
    dbMock.queueSelect("event_sync_cursor", [{ id: 1, lastEventId: "evt_old" }]);
    stripeMock.events.list
      .mockRejectedValueOnce(agedOutError())
      .mockResolvedValueOnce({ data: [{ id: "evt_new", type: "charge.succeeded" }] });

    const processed = await pollOnce();

    expect(stripeMock.events.list).toHaveBeenNthCalledWith(1, {
      limit: 100,
      starting_after: "evt_old",
    });
    // Second call drops starting_after entirely.
    expect(stripeMock.events.list).toHaveBeenNthCalledWith(2, { limit: 100 });
    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(processed).toBe(1);

    const cursorWrite = dbMock.lastInsertValues("event_sync_cursor");
    expect(cursorWrite).toMatchObject({ id: 1, lastEventId: "evt_new" });
  });

  it("does not reset when there is no stored cursor (error would not be cursor-related)", async () => {
    dbMock.queueSelect("event_sync_cursor", []);
    stripeMock.events.list.mockRejectedValueOnce(agedOutError());

    // Outer catch swallows to 0; the cursor-reset path must NOT fire (no cursor to reset).
    const processed = await pollOnce();

    expect(stripeMock.events.list).toHaveBeenCalledTimes(1);
    expect(stripeMock.events.list).toHaveBeenCalledWith({
      limit: 100,
      starting_after: undefined,
    });
    expect(processed).toBe(0);
  });

  it("re-throws non-cursor Stripe errors (swallowed by outer catch to 0)", async () => {
    dbMock.queueSelect("event_sync_cursor", [{ id: 1, lastEventId: "evt_old" }]);
    stripeMock.events.list.mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { code: "rate_limit" })
    );

    const processed = await pollOnce();

    // Only the first list call; no reset retry for unrelated errors.
    expect(stripeMock.events.list).toHaveBeenCalledTimes(1);
    expect(processEvent).not.toHaveBeenCalled();
    expect(processed).toBe(0);
  });

  it("normal poll with a valid cursor advances to the newest event", async () => {
    dbMock.queueSelect("event_sync_cursor", [{ id: 1, lastEventId: "evt_old" }]);
    stripeMock.events.list.mockResolvedValueOnce({
      data: [
        { id: "evt_b", type: "charge.succeeded" },
        { id: "evt_a", type: "customer.created" },
      ],
    });

    const processed = await pollOnce();

    expect(stripeMock.events.list).toHaveBeenCalledTimes(1);
    expect(stripeMock.events.list).toHaveBeenCalledWith({
      limit: 100,
      starting_after: "evt_old",
    });
    // Oldest-first processing order.
    expect((processEvent as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ id: "evt_a" });
    expect((processEvent as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({ id: "evt_b" });
    expect(processed).toBe(2);

    const cursorWrite = dbMock.lastInsertValues("event_sync_cursor");
    expect(cursorWrite).toMatchObject({ id: 1, lastEventId: "evt_b" });
  });
});
