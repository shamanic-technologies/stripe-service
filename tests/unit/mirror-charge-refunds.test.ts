import { describe, it, expect, vi, beforeEach } from "vitest";

const { stripeMock } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { makeStripeMock } = require("../helpers/mocks-factory.cjs");
  return { stripeMock: makeStripeMock(vi) };
});

vi.mock("../../src/lib/event-processor", () => ({
  recordApiSnapshot: vi.fn(async () => {}),
}));

import {
  isChargeRefundEvent,
  mirrorRefundsForChargeEvent,
} from "../../src/lib/mirror-charge-refunds";
import { recordApiSnapshot } from "../../src/lib/event-processor";

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const it of items) yield it;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stripeMock.refunds.list.mockReturnValue(asyncIter([]));
});

describe("isChargeRefundEvent", () => {
  it("covers both events Stripe can announce a refund through", () => {
    expect(isChargeRefundEvent("charge.refunded")).toBe(true);
    expect(isChargeRefundEvent("charge.refund.updated")).toBe(true);
    expect(isChargeRefundEvent("charge.succeeded")).toBe(false);
    expect(isChargeRefundEvent("payment_intent.succeeded")).toBe(false);
  });
});

describe("mirrorRefundsForChargeEvent", () => {
  // #100: `charge.refunded` is subscribed on the live endpoint but its payload
  // is a Charge, and `charge.refunds` comes back null on our API version — so
  // without this side-effect the event contributes nothing to the mirror and
  // refund mirroring depends on which event Stripe happens to deliver.
  it("mirrors the Link refunds hanging off a py_ charge from charge.refunded", async () => {
    const refund = {
      id: "pyr_1Tz5CNEnlXMXdaZaftuK3vcA",
      object: "refund",
      payment_intent: "pi_3Tz4VAEnlXMXdaZa19hZuCYe",
      charge: "py_3Tz4VAEnlXMXdaZa1tzx66M9",
      amount: 3931,
      currency: "usd",
      status: "succeeded",
    };
    stripeMock.refunds.list.mockReturnValue(asyncIter([refund]));

    const mirrored = await mirrorRefundsForChargeEvent(
      {
        id: "evt_3Tz4VAEnlXMXdaZa11tvtdzN",
        type: "charge.refunded",
        data: {
          object: {
            id: "py_3Tz4VAEnlXMXdaZa1tzx66M9",
            object: "charge",
            payment_intent: "pi_3Tz4VAEnlXMXdaZa19hZuCYe",
            amount_refunded: 3931,
            // Stripe's current API version does not expand this sub-list.
            refunds: null,
          },
        },
      } as never,
      stripeMock as never
    );

    expect(mirrored).toBe(1);
    expect(stripeMock.refunds.list).toHaveBeenCalledWith({
      charge: "py_3Tz4VAEnlXMXdaZa1tzx66M9",
      limit: 100,
    });
    // Org-less: the tenant is joined through the PaymentIntent.
    expect(recordApiSnapshot).toHaveBeenCalledWith(refund, "refund", null);
  });

  it("mirrors a card charge's refunds identically", async () => {
    stripeMock.refunds.list.mockReturnValue(
      asyncIter([
        { id: "re_1", object: "refund", amount: 2962, status: "succeeded" },
      ])
    );

    const mirrored = await mirrorRefundsForChargeEvent(
      {
        id: "evt_card",
        type: "charge.refunded",
        data: { object: { id: "ch_1", object: "charge", refunds: null } },
      } as never,
      stripeMock as never
    );

    expect(mirrored).toBe(1);
    expect(stripeMock.refunds.list).toHaveBeenCalledWith({
      charge: "ch_1",
      limit: 100,
    });
  });

  it("resolves the charge off a Refund payload too (charge.refund.updated)", async () => {
    stripeMock.refunds.list.mockReturnValue(
      asyncIter([{ id: "pyr_1", object: "refund", amount: 4039 }])
    );

    await mirrorRefundsForChargeEvent(
      {
        id: "evt_x",
        type: "charge.refund.updated",
        data: {
          object: { id: "pyr_1", object: "refund", charge: "py_1" },
        },
      } as never,
      stripeMock as never
    );

    expect(stripeMock.refunds.list).toHaveBeenCalledWith({
      charge: "py_1",
      limit: 100,
    });
  });

  it("mirrors every refund on a partially-then-fully refunded charge", async () => {
    stripeMock.refunds.list.mockReturnValue(
      asyncIter([
        { id: "pyr_a", object: "refund", amount: 2000 },
        { id: "pyr_b", object: "refund", amount: 3000 },
      ])
    );

    const mirrored = await mirrorRefundsForChargeEvent(
      {
        id: "evt_x",
        type: "charge.refunded",
        data: { object: { id: "py_1", object: "charge" } },
      } as never,
      stripeMock as never
    );

    expect(mirrored).toBe(2);
    expect(recordApiSnapshot).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when no charge can be resolved", async () => {
    const mirrored = await mirrorRefundsForChargeEvent(
      {
        id: "evt_x",
        type: "charge.refunded",
        data: { object: { object: "charge" } },
      } as never,
      stripeMock as never
    );

    expect(mirrored).toBe(0);
    expect(stripeMock.refunds.list).not.toHaveBeenCalled();
  });

  it("propagates a Stripe failure so the webhook 5xxs and Stripe retries", async () => {
    stripeMock.refunds.list.mockImplementation(() => {
      throw new Error("Stripe is down");
    });

    await expect(
      mirrorRefundsForChargeEvent(
        {
          id: "evt_x",
          type: "charge.refunded",
          data: { object: { id: "ch_1", object: "charge" } },
        } as never,
        stripeMock as never
      )
    ).rejects.toThrow(/Stripe is down/);
  });
});
