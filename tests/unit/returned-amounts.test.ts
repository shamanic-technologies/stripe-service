import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});

vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

import {
  returnedByPaymentIntent,
  summarizeByCurrency,
  withReturnedAmounts,
  ZERO_RETURNED,
  type SummaryPayment,
} from "../../src/lib/returned-amounts";

type RefundRow = {
  id: string;
  paymentIntent: string | null;
  charge: string | null;
  amount: number;
  status: string | null;
};

/**
 * `returnedByPaymentIntent` fires the refunds + disputes selects concurrently
 * via Promise.all, so queue them by table name rather than by call order.
 */
function queueMirrors(refundRows: RefundRow[], disputeRows: RefundRow[]) {
  dbMock.queueSelect("refunds", refundRows);
  dbMock.queueSelect("disputes", disputeRows);
}

function pi(
  id: string,
  amountReceived: number | null,
  status = "succeeded",
  currency = "usd",
  latestCharge: string | null = null
): SummaryPayment {
  return { id, amountReceived, status, currency, latestCharge };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("returnedByPaymentIntent", () => {
  it("counts a FULL refund at the payment's whole amount", async () => {
    queueMirrors(
      [{ id: "re_1", paymentIntent: "pi_1", charge: null, amount: 1000, status: "succeeded" }],
      []
    );

    const out = await returnedByPaymentIntent([{ id: "pi_1", latestCharge: null }]);

    expect(out.get("pi_1")).toEqual({
      amount_refunded: 1000,
      amount_disputed_lost: 0,
      amount_returned: 1000,
    });
  });

  it("counts a PARTIAL refund at only its own amount", async () => {
    queueMirrors(
      [{ id: "re_1", paymentIntent: "pi_1", charge: null, amount: 250, status: "succeeded" }],
      []
    );

    const out = await returnedByPaymentIntent([{ id: "pi_1", latestCharge: null }]);

    expect(out.get("pi_1")?.amount_returned).toBe(250);
  });

  it("sums several partial refunds against the same payment", async () => {
    queueMirrors(
      [
        { id: "re_1", paymentIntent: "pi_1", charge: null, amount: 250, status: "succeeded" },
        { id: "re_2", paymentIntent: "pi_1", charge: null, amount: 100, status: "succeeded" },
      ],
      []
    );

    const out = await returnedByPaymentIntent([{ id: "pi_1", latestCharge: null }]);

    expect(out.get("pi_1")?.amount_refunded).toBe(350);
  });

  it("stops counting a refund that REVERTS (failed / canceled) — money came back to us", async () => {
    queueMirrors(
      [
        { id: "re_failed", paymentIntent: "pi_1", charge: null, amount: 1000, status: "failed" },
        { id: "re_canceled", paymentIntent: "pi_1", charge: null, amount: 400, status: "canceled" },
        { id: "re_ok", paymentIntent: "pi_1", charge: null, amount: 100, status: "succeeded" },
      ],
      []
    );

    const out = await returnedByPaymentIntent([{ id: "pi_1", latestCharge: null }]);

    // Only the still-succeeded refund counts; no accumulator had to be unwound.
    expect(out.get("pi_1")).toEqual({
      amount_refunded: 100,
      amount_disputed_lost: 0,
      amount_returned: 100,
    });
  });

  it("does not count a refund that has not settled yet (pending / requires_action)", async () => {
    queueMirrors(
      [
        { id: "re_p", paymentIntent: "pi_1", charge: null, amount: 1000, status: "pending" },
        { id: "re_r", paymentIntent: "pi_1", charge: null, amount: 500, status: "requires_action" },
      ],
      []
    );

    const out = await returnedByPaymentIntent([{ id: "pi_1", latestCharge: null }]);

    expect(out.get("pi_1")).toBeUndefined();
  });

  it("counts a LOST dispute as money gone, the same as a refund", async () => {
    queueMirrors(
      [],
      [{ id: "dp_1", paymentIntent: "pi_1", charge: null, amount: 1000, status: "lost" }]
    );

    const out = await returnedByPaymentIntent([{ id: "pi_1", latestCharge: null }]);

    expect(out.get("pi_1")).toEqual({
      amount_refunded: 0,
      amount_disputed_lost: 1000,
      amount_returned: 1000,
    });
  });

  it("does not count a WON or still-open dispute — the funds stayed with us", async () => {
    queueMirrors(
      [],
      [
        { id: "dp_won", paymentIntent: "pi_1", charge: null, amount: 1000, status: "won" },
        { id: "dp_open", paymentIntent: "pi_1", charge: null, amount: 700, status: "needs_response" },
        { id: "dp_rev", paymentIntent: "pi_1", charge: null, amount: 300, status: "under_review" },
        { id: "dp_warn", paymentIntent: "pi_1", charge: null, amount: 200, status: "warning_closed" },
      ]
    );

    const out = await returnedByPaymentIntent([{ id: "pi_1", latestCharge: null }]);

    expect(out.get("pi_1")).toBeUndefined();
  });

  it("adds a refund and a lost dispute on the same payment", async () => {
    queueMirrors(
      [{ id: "re_1", paymentIntent: "pi_1", charge: null, amount: 400, status: "succeeded" }],
      [{ id: "dp_1", paymentIntent: "pi_1", charge: null, amount: 600, status: "lost" }]
    );

    const out = await returnedByPaymentIntent([{ id: "pi_1", latestCharge: null }]);

    expect(out.get("pi_1")).toEqual({
      amount_refunded: 400,
      amount_disputed_lost: 600,
      amount_returned: 1000,
    });
  });

  it("attributes via `charge` when Stripe left `payment_intent` null", async () => {
    queueMirrors(
      [{ id: "re_1", paymentIntent: null, charge: "ch_1", amount: 1000, status: "succeeded" }],
      []
    );

    const out = await returnedByPaymentIntent([{ id: "pi_1", latestCharge: "ch_1" }]);

    expect(out.get("pi_1")?.amount_returned).toBe(1000);
  });

  it("counts a refund matching on BOTH payment_intent and charge exactly once", async () => {
    queueMirrors(
      [{ id: "re_1", paymentIntent: "pi_1", charge: "ch_1", amount: 1000, status: "succeeded" }],
      []
    );

    const out = await returnedByPaymentIntent([{ id: "pi_1", latestCharge: "ch_1" }]);

    expect(out.get("pi_1")?.amount_returned).toBe(1000);
  });

  it("returns an empty map (and hits no DB) for an org with no payments", async () => {
    const out = await returnedByPaymentIntent([]);

    expect(out.size).toBe(0);
    expect(dbMock.db.select).not.toHaveBeenCalled();
  });

  it("keeps refunds separated per payment", async () => {
    queueMirrors(
      [
        { id: "re_1", paymentIntent: "pi_1", charge: null, amount: 300, status: "succeeded" },
        { id: "re_2", paymentIntent: "pi_2", charge: null, amount: 700, status: "succeeded" },
      ],
      []
    );

    const out = await returnedByPaymentIntent([
      { id: "pi_1", latestCharge: null },
      { id: "pi_2", latestCharge: null },
    ]);

    expect(out.get("pi_1")?.amount_returned).toBe(300);
    expect(out.get("pi_2")?.amount_returned).toBe(700);
  });
});

describe("summarizeByCurrency", () => {
  it("reports net == gross for an org with no refunds (no regression)", () => {
    const totals = summarizeByCurrency(
      [pi("pi_1", 1000), pi("pi_2", 2500)],
      new Map()
    );

    expect(totals).toEqual([
      {
        currency: "usd",
        amount_received: 3500,
        amount_refunded: 0,
        amount_disputed_lost: 0,
        amount_returned: 0,
        amount_net: 3500,
      },
    ]);
  });

  it("subtracts a full refund from net while leaving gross intact", () => {
    const totals = summarizeByCurrency(
      [pi("pi_1", 1000)],
      new Map([
        ["pi_1", { amount_refunded: 1000, amount_disputed_lost: 0, amount_returned: 1000 }],
      ])
    );

    expect(totals[0].amount_received).toBe(1000);
    expect(totals[0].amount_returned).toBe(1000);
    expect(totals[0].amount_net).toBe(0);
  });

  it("subtracts a partial refund", () => {
    const totals = summarizeByCurrency(
      [pi("pi_1", 1000)],
      new Map([
        ["pi_1", { amount_refunded: 250, amount_disputed_lost: 0, amount_returned: 250 }],
      ])
    );

    expect(totals[0].amount_net).toBe(750);
  });

  it("subtracts a lost dispute and reports it separately from refunds", () => {
    const totals = summarizeByCurrency(
      [pi("pi_1", 1000)],
      new Map([
        ["pi_1", { amount_refunded: 0, amount_disputed_lost: 1000, amount_returned: 1000 }],
      ])
    );

    expect(totals[0]).toMatchObject({
      amount_refunded: 0,
      amount_disputed_lost: 1000,
      amount_returned: 1000,
      amount_net: 0,
    });
  });

  it("excludes non-succeeded payments from gross (billing's own predicate)", () => {
    const totals = summarizeByCurrency(
      [pi("pi_ok", 1000), pi("pi_fail", 0, "requires_payment_method"), pi("pi_null", null)],
      new Map()
    );

    expect(totals[0].amount_received).toBe(1000);
  });

  it("never merges currencies", () => {
    const totals = summarizeByCurrency(
      [pi("pi_usd", 1000, "succeeded", "usd"), pi("pi_eur", 2000, "succeeded", "eur")],
      new Map([
        ["pi_eur", { amount_refunded: 500, amount_disputed_lost: 0, amount_returned: 500 }],
      ])
    );

    expect(totals).toEqual([
      {
        currency: "eur",
        amount_received: 2000,
        amount_refunded: 500,
        amount_disputed_lost: 0,
        amount_returned: 500,
        amount_net: 1500,
      },
      {
        currency: "usd",
        amount_received: 1000,
        amount_refunded: 0,
        amount_disputed_lost: 0,
        amount_returned: 0,
        amount_net: 1000,
      },
    ]);
  });

  it("returns no rows for an org with no payments rather than a fabricated zero row", () => {
    expect(summarizeByCurrency([], new Map())).toEqual([]);
  });
});

describe("withReturnedAmounts", () => {
  it("adds the derived fields without touching the Stripe object's own fields", () => {
    const out = withReturnedAmounts(
      { id: "pi_1", object: "payment_intent", status: "succeeded", amount_received: 1000 },
      { amount_refunded: 1000, amount_disputed_lost: 0, amount_returned: 1000 }
    ) as Record<string, unknown>;

    // The original payment is NOT mutated or hidden — Stripe's model is append-only.
    expect(out.status).toBe("succeeded");
    expect(out.amount_received).toBe(1000);
    expect(out.amount_returned).toBe(1000);
    expect(out.amount_refunded).toBe(1000);
    expect(out.amount_disputed_lost).toBe(0);
  });

  it("reports explicit zeros for a payment with nothing returned", () => {
    const out = withReturnedAmounts({ id: "pi_1" }, undefined) as Record<string, unknown>;

    expect(out).toMatchObject(ZERO_RETURNED);
  });
});
