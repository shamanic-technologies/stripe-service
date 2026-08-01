import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_ORG_ID } from "../helpers/mocks";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));
vi.mock("../../src/lib/notify-payment-method-removed", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/lib/notify-payment-method-removed")
  >("../../src/lib/notify-payment-method-removed");
  return {
    isPaymentMethodDetachedEvent: actual.isPaymentMethodDetachedEvent,
    notifyPaymentMethodRemoved: vi.fn(async () => true),
  };
});

import {
  processEvent,
  upsertCustomer,
  resolveOrgId,
} from "../../src/lib/event-processor";
import { notifyPaymentMethodRemoved } from "../../src/lib/notify-payment-method-removed";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processEvent — idempotence", () => {
  it("returns true on first insertion", async () => {
    dbMock.queueInsert("events", [{ id: "evt_1" }]);

    const result = await processEvent(
      {
        id: "evt_1",
        type: "customer.created",
        api_version: "2024-12-18",
        livemode: false,
        created: 1700000000,
        data: {
          object: {
            id: "cus_1",
            object: "customer",
            metadata: { org_id: TEST_ORG_ID },
            created: 1700000000,
            livemode: false,
          },
        },
      } as never,
      "webhook"
    );

    expect(result).toBe(true);
  });

  it("returns false when event already exists", async () => {
    dbMock.queueInsert("events", []);

    const result = await processEvent(
      {
        id: "evt_dup",
        type: "customer.created",
        api_version: "2024-12-18",
        livemode: false,
        created: 1700000000,
        data: {
          object: {
            id: "cus_1",
            object: "customer",
            metadata: { org_id: TEST_ORG_ID },
            created: 1700000000,
            livemode: false,
          },
        },
      } as never,
      "webhook"
    );

    expect(result).toBe(false);
  });
});

describe("payment_method.detached — one detach, one staff email", () => {
  function detached() {
    return {
      id: "evt_detach_1",
      type: "payment_method.detached",
      api_version: "2026-02-25.clover",
      livemode: true,
      created: 1785541883,
      data: {
        object: {
          id: "pm_1",
          object: "payment_method",
          type: "card",
          customer: null,
        },
        previous_attributes: { customer: "cus_1" },
      },
    } as never;
  }

  it("notifies on the first sighting of the event", async () => {
    dbMock.queueInsert("events", [{ id: "evt_detach_1" }]);

    expect(await processEvent(detached(), "webhook")).toBe(true);
    expect(notifyPaymentMethodRemoved).toHaveBeenCalledTimes(1);
  });

  // Webhook delivery, webhook redelivery and the 5-minute poll all carry the
  // same `evt_…`, so the bronze insert conflicts and side-effects never run
  // again. This is what keeps one detach at one email.
  it("does not notify again on redelivery or on the poller seeing it", async () => {
    dbMock.queueInsert("events", []);
    expect(await processEvent(detached(), "webhook")).toBe(false);

    dbMock.queueInsert("events", []);
    expect(await processEvent(detached(), "poll")).toBe(false);

    expect(notifyPaymentMethodRemoved).not.toHaveBeenCalled();
  });

  it("leaves payment methods unmirrored — the detach writes no silver row", async () => {
    dbMock.queueInsert("events", [{ id: "evt_detach_1" }]);
    dbMock.clearCaptured();

    await processEvent(detached(), "webhook");

    expect(dbMock.lastInsertValues("customers")).toBeUndefined();
    expect(dbMock.lastInsertValues("payment_intents")).toBeUndefined();
  });
});

describe("upsertCustomer — balance stripped from raw_json", () => {
  it("removes the polluted `balance` field before storing raw_json", async () => {
    dbMock.clearCaptured();

    await upsertCustomer(
      {
        id: "cus_strip",
        object: "customer",
        balance: 198143,
        email: "x@example.com",
        name: null,
        description: null,
        phone: null,
        metadata: { org_id: TEST_ORG_ID },
        livemode: false,
        created: 1700000000,
      } as never,
      TEST_ORG_ID
    );

    const insertedRow = dbMock.lastInsertValues("customers") as {
      rawJson: Record<string, unknown>;
    };
    expect(insertedRow).toBeDefined();
    expect(insertedRow.rawJson).toBeDefined();
    expect(insertedRow.rawJson.id).toBe("cus_strip");
    expect("balance" in insertedRow.rawJson).toBe(false);
  });
});

describe("resolveOrgId — customer-mirror fallback", () => {
  it("returns metadata org_id without hitting the DB when present", async () => {
    const orgId = await resolveOrgId("org-from-meta", "cus_123");
    expect(orgId).toBe("org-from-meta");
    expect(dbMock.db.select).not.toHaveBeenCalled();
  });

  it("falls back to customers.org_id when metadata is empty", async () => {
    dbMock.queueSelect("customers", [{ orgId: "org-from-customer" }]);
    const orgId = await resolveOrgId(null, "cus_with_mirror");
    expect(orgId).toBe("org-from-customer");
    expect(dbMock.db.select).toHaveBeenCalled();
  });

  it("returns 'unknown' when metadata is empty and customer mirror is missing", async () => {
    dbMock.queueSelect("customers", []);
    const orgId = await resolveOrgId(null, "cus_orphan");
    expect(orgId).toBe("unknown");
  });

  it("returns 'unknown' when customerId is null and metadata is empty", async () => {
    const orgId = await resolveOrgId(null, null);
    expect(orgId).toBe("unknown");
    expect(dbMock.db.select).not.toHaveBeenCalled();
  });
});
