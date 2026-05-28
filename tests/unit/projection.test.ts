import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_ORG_ID } from "../helpers/mocks";

const { dbMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import {
  processEvent,
  insertSyntheticEvent,
  projectSilverFromBronze,
} from "../../src/lib/event-processor";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearCaptured();
});

describe("projection — out-of-order webhook race regression", () => {
  it("projects status=succeeded when older 'created' event arrives after newer 'succeeded' is already in bronze", async () => {
    // Bronze insert of the (older) created event accepted.
    dbMock.queueInsert("events", [{ id: "evt_pi_created" }]);

    // resolveOrgId path: metadata.org_id is present on the incoming event so no
    // DB select is needed. But projection then reads bronze for the latest
    // event by created_stripe DESC — return the succeeded snapshot.
    dbMock.queueSelect("events", [
      {
        payload: {
          id: "evt_pi_succeeded",
          type: "payment_intent.succeeded",
          api_version: "2024-12-18",
          livemode: false,
          created: 1779927593,
          data: {
            object: {
              id: "pi_race_X",
              object: "payment_intent",
              status: "succeeded",
              amount: 5000,
              amount_received: 5000,
              currency: "usd",
              customer: "cus_race_Y",
              metadata: { org_id: TEST_ORG_ID },
              livemode: false,
              created: 1779927590,
            },
          },
        },
      },
    ]);

    await processEvent(
      {
        id: "evt_pi_created",
        type: "payment_intent.created",
        api_version: "2024-12-18",
        livemode: false,
        created: 1779927590,
        data: {
          object: {
            id: "pi_race_X",
            object: "payment_intent",
            status: "requires_payment_method",
            amount: 5000,
            amount_received: 0,
            currency: "usd",
            customer: "cus_race_Y",
            metadata: { org_id: TEST_ORG_ID },
            livemode: false,
            created: 1779927590,
          },
        },
      } as never,
      "webhook"
    );

    const silverRow = dbMock.lastInsertValues("payment_intents") as {
      status: string;
      id: string;
    };
    expect(silverRow).toBeDefined();
    expect(silverRow.id).toBe("pi_race_X");
    expect(silverRow.status).toBe("succeeded");
  });
});

describe("insertSyntheticEvent", () => {
  it("writes an api-prefixed bronze row with source='api'", async () => {
    dbMock.queueInsert("events", [{ id: "ignored" }]);

    await insertSyntheticEvent(
      {
        id: "pi_synth",
        object: "payment_intent",
        status: "succeeded",
        amount: 5000,
        amount_received: 5000,
        currency: "usd",
        customer: "cus_X",
        metadata: {},
        livemode: false,
        created: 1779000000,
      } as never,
      "payment_intent"
    );

    const eventRow = dbMock.lastInsertValues("events") as {
      id: string;
      type: string;
      source: string;
      objectId: string;
    };
    expect(eventRow).toBeDefined();
    expect(eventRow.id.startsWith("api_")).toBe(true);
    expect(eventRow.type).toBe("api_snapshot.payment_intent");
    expect(eventRow.source).toBe("api");
    expect(eventRow.objectId).toBe("pi_synth");
  });
});

describe("projectSilverFromBronze", () => {
  it("upserts silver from latest event payload by created_stripe DESC", async () => {
    dbMock.queueSelect("events", [
      {
        payload: {
          id: "evt_latest",
          type: "payment_intent.succeeded",
          api_version: "2024-12-18",
          livemode: false,
          created: 1779927999,
          data: {
            object: {
              id: "pi_proj_X",
              object: "payment_intent",
              status: "succeeded",
              amount: 7500,
              amount_received: 7500,
              currency: "usd",
              customer: "cus_proj_Y",
              metadata: { org_id: TEST_ORG_ID },
              livemode: false,
              created: 1779927900,
            },
          },
        },
      },
    ]);

    await projectSilverFromBronze("pi_proj_X", TEST_ORG_ID);

    const silverRow = dbMock.lastInsertValues("payment_intents") as {
      status: string;
      id: string;
      amount: number;
    };
    expect(silverRow).toBeDefined();
    expect(silverRow.id).toBe("pi_proj_X");
    expect(silverRow.status).toBe("succeeded");
    expect(silverRow.amount).toBe(7500);
  });

  it("is a no-op when no events exist for object_id", async () => {
    dbMock.queueSelect("events", []);

    await projectSilverFromBronze("pi_missing", TEST_ORG_ID);

    const silverRow = dbMock.lastInsertValues("payment_intents");
    expect(silverRow).toBeUndefined();
  });
});
