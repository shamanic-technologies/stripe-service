import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_ORG_ID } from "../helpers/mocks";

const { dbMock, stripeMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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

import {
  processEvent,
  insertSyntheticEvent,
  projectSilverFromBronze,
} from "../../src/lib/event-processor";

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const it of items) yield it;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearCaptured();
  // The charge-refund side-effect lists refunds off Stripe; default it empty so
  // only the tests that care about it exercise it.
  stripeMock.refunds.list.mockReturnValue(asyncIter([]));
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

describe("projection — refund / dispute silver", () => {
  function bronze(object: Record<string, unknown>) {
    return [{ payload: { data: { object } } }];
  }

  it("projects a Refund into refunds silver with its live status", async () => {
    dbMock.queueSelect(
      "events",
      bronze({
        id: "re_1",
        object: "refund",
        payment_intent: "pi_1",
        charge: "ch_1",
        amount: 1000,
        currency: "usd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: 1779927900,
      })
    );

    // Refund silver is org-less on purpose — the org is joined via the PI.
    await projectSilverFromBronze("re_1", null);

    const row = dbMock.lastInsertValues("refunds") as Record<string, unknown>;
    expect(row).toMatchObject({
      id: "re_1",
      paymentIntent: "pi_1",
      charge: "ch_1",
      amount: 1000,
      currency: "usd",
      status: "succeeded",
    });
  });

  // #100: a refund of a Link (or any non-card) payment carries a `pyr_` id, not
  // `re_`. Routing on the id prefix dropped every one of them on the floor while
  // card refunds mirrored fine, so `amount_returned` read 0 for money we had
  // already given back. The payload's own `object` field is the routing key.
  it("projects a Link refund (pyr_ id) exactly like a card refund", async () => {
    dbMock.queueSelect(
      "events",
      bronze({
        id: "pyr_1Tz5CKEnlXMXdaZa0y7zRILl",
        object: "refund",
        payment_intent: "pi_3Tz4VSEnlXMXdaZa08Ya69pF",
        charge: "py_3Tz4VSEnlXMXdaZa0mIweqHE",
        amount: 4039,
        currency: "usd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: 1785461126,
      })
    );

    await projectSilverFromBronze("pyr_1Tz5CKEnlXMXdaZa0y7zRILl", null);

    const row = dbMock.lastInsertValues("refunds") as Record<string, unknown>;
    expect(row).toMatchObject({
      id: "pyr_1Tz5CKEnlXMXdaZa0y7zRILl",
      paymentIntent: "pi_3Tz4VSEnlXMXdaZa08Ya69pF",
      charge: "py_3Tz4VSEnlXMXdaZa0mIweqHE",
      amount: 4039,
      currency: "usd",
      status: "succeeded",
    });
  });

  it("projects a Link refund arriving as a full charge.refund.updated webhook", async () => {
    dbMock.queueInsert("events", [{ id: "evt_1Tz5CUEnlXMXdaZaId9H4BRL" }]);
    const refund = {
      id: "pyr_1Tz5CKEnlXMXdaZa0y7zRILl",
      object: "refund",
      payment_intent: "pi_3Tz4VSEnlXMXdaZa08Ya69pF",
      charge: "py_3Tz4VSEnlXMXdaZa0mIweqHE",
      amount: 4039,
      currency: "usd",
      status: "succeeded",
      created: 1785461126,
    };
    dbMock.queueSelect("events", bronze(refund));

    await processEvent(
      {
        id: "evt_1Tz5CUEnlXMXdaZaId9H4BRL",
        type: "charge.refund.updated",
        api_version: "2024-12-18",
        livemode: true,
        created: 1785461126,
        data: { object: refund },
      } as never,
      "webhook"
    );

    const row = dbMock.lastInsertValues("refunds") as Record<string, unknown>;
    expect(row).toMatchObject({ id: "pyr_1Tz5CKEnlXMXdaZa0y7zRILl", amount: 4039 });
  });

  it("routes on the payload's `object` field, not the id prefix", async () => {
    // Same object, an id prefix no branch has ever heard of. Stripe telling us
    // it is a refund has to be enough — a new payment rail must not be able to
    // reintroduce #100.
    dbMock.queueSelect(
      "events",
      bronze({
        id: "somenewprefix_9",
        object: "refund",
        payment_intent: "pi_1",
        charge: "ch_1",
        amount: 250,
        currency: "usd",
        status: "succeeded",
        created: 1785461126,
      })
    );

    await projectSilverFromBronze("somenewprefix_9", null);

    const row = dbMock.lastInsertValues("refunds") as Record<string, unknown>;
    expect(row).toMatchObject({ id: "somenewprefix_9", amount: 250 });
  });

  it("logs loudly instead of silently dropping an object type it cannot route", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.queueSelect(
      "events",
      bronze({ id: "wat_1", object: "totally_new_object", created: 1785461126 })
    );

    await projectSilverFromBronze("wat_1", null);

    expect(dbMock.lastInsertValues("refunds")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("totally_new_object")
    );
    warn.mockRestore();
  });

  it("stays quiet for object types we deliberately do not mirror", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbMock.queueSelect(
      "events",
      bronze({ id: "ch_1", object: "charge", created: 1785461126 })
    );

    await projectSilverFromBronze("ch_1", null);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("re-projects a reverted refund to its new status so it stops counting", async () => {
    dbMock.queueSelect(
      "events",
      bronze({
        id: "re_1",
        object: "refund",
        payment_intent: "pi_1",
        charge: "ch_1",
        amount: 1000,
        currency: "usd",
        status: "failed",
        created: 1779928000,
      })
    );

    await projectSilverFromBronze("re_1", null);

    const row = dbMock.lastInsertValues("refunds") as Record<string, unknown>;
    expect(row.status).toBe("failed");
  });

  it("projects a Dispute into disputes silver", async () => {
    dbMock.queueSelect(
      "events",
      bronze({
        id: "dp_1",
        object: "dispute",
        payment_intent: "pi_1",
        charge: "ch_1",
        amount: 1000,
        currency: "usd",
        status: "lost",
        reason: "fraudulent",
        livemode: true,
        created: 1779927900,
      })
    );

    await projectSilverFromBronze("dp_1", null);

    const row = dbMock.lastInsertValues("disputes") as Record<string, unknown>;
    expect(row).toMatchObject({
      id: "dp_1",
      paymentIntent: "pi_1",
      amount: 1000,
      status: "lost",
      livemode: "true",
    });
  });

  it("never writes an org-tenanted silver row without an org (fails loud)", async () => {
    dbMock.queueSelect(
      "events",
      bronze({
        id: "pi_1",
        object: "payment_intent",
        amount: 1000,
        currency: "usd",
        status: "succeeded",
        created: 1779927900,
      })
    );

    await expect(projectSilverFromBronze("pi_1", null)).rejects.toThrow(
      /orgId is required/
    );
  });

  it("records a Refund's api_snapshot livemode as null instead of inventing 'false'", async () => {
    // Stripe's Refund object carries no `livemode`; defaulting it would lie
    // about a live refund.
    await insertSyntheticEvent({ id: "re_1" }, "refund");

    const row = dbMock.lastInsertValues("events") as Record<string, unknown>;
    expect(row.livemode).toBeNull();
  });
});
