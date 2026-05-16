import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_ORG_ID } from "../helpers/mocks";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import {
  processEvent,
  upsertCustomer,
  resolveOrgId,
} from "../../src/lib/event-processor";

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
