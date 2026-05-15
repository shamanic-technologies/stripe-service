import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_ORG_ID } from "../helpers/mocks";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import { processEvent } from "../../src/lib/event-processor";

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
