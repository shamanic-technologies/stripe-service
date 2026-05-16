import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_ORG_ID } from "../helpers/mocks";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import { processEvent, upsertCustomer } from "../../src/lib/event-processor";

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
