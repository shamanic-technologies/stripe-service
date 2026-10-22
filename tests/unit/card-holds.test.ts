import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

const stripe = {
  paymentIntents: {
    create: vi.fn(),
    retrieve: vi.fn(),
    capture: vi.fn(),
    cancel: vi.fn(),
  },
  paymentMethods: { list: vi.fn(), retrieve: vi.fn() },
};
const recordApiSnapshot = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/lib/event-processor", () => ({
  getPlatformStripe: async () => stripe,
  recordApiSnapshot: (...a: unknown[]) => recordApiSnapshot(...a),
}));

const resolveAcquirer = vi.fn();
vi.mock("../../src/lib/acquirer", () => ({
  resolveAcquirer: (...a: unknown[]) => resolveAcquirer(...a),
}));

const listCustomerPaymentMethods = vi.fn();
const createOrder = vi.fn();
const payOrderWithSavedMethod = vi.fn();
const getOrder = vi.fn();
const captureOrder = vi.fn();
const cancelOrder = vi.fn();
vi.mock("../../src/lib/revolut-client", () => ({
  listCustomerPaymentMethods: (...a: unknown[]) => listCustomerPaymentMethods(...a),
  createOrder: (...a: unknown[]) => createOrder(...a),
  payOrderWithSavedMethod: (...a: unknown[]) => payOrderWithSavedMethod(...a),
  getOrder: (...a: unknown[]) => getOrder(...a),
  captureOrder: (...a: unknown[]) => captureOrder(...a),
  cancelOrder: (...a: unknown[]) => cancelOrder(...a),
}));
const mirrorOrderById = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/lib/revolut-processor", () => ({
  mirrorOrderById: (...a: unknown[]) => mirrorOrderById(...a),
}));

import {
  captureCardHold,
  cardHoldView,
  effectiveStatus,
  holdSettleTiming,
  HoldIdempotencyKeyReused,
  HoldNotLive,
  liveHold,
  placeCardHold,
  sweepExpiredCardHolds,
  type CardHoldRow,
} from "../../src/lib/card-holds";

const ORG = "org-test-staff";
const HOLD_ID = "11111111-2222-4333-8444-555555555555";
const CAPTURE_BEFORE = 1793000000; // unix seconds

function row(overrides: Partial<CardHoldRow> = {}): CardHoldRow {
  return {
    id: HOLD_ID,
    orgId: ORG,
    acquirer: "stripe",
    reference: null,
    paymentMethod: "pm_card",
    amount: 5000,
    currency: "usd",
    status: "pending",
    session: "on_session",
    amountCaptured: null,
    declineCode: null,
    declineMessage: null,
    idempotencyKey: "hold-k1",
    description: null,
    metadata: null,
    expiresAt: null,
    createdAt: new Date("2026-10-22T10:00:00Z"),
    updatedAt: new Date("2026-10-22T10:00:00Z"),
    capturedAt: null,
    endedAt: null,
    ...overrides,
  };
}

const PLACE = {
  orgId: ORG,
  amount: 5000,
  currency: "USD",
  session: "on_session" as const,
  idempotencyKey: "hold-k1",
};

function queueStripePlacement(overrides: Partial<CardHoldRow> = {}) {
  dbMock.queueSelect("card_holds", []); // no hold for this key yet
  dbMock.queueSelect("customers", [{ id: "cus_1" }]); // method pick
  stripe.paymentMethods.list.mockResolvedValueOnce({ data: [{ id: "pm_card", type: "card" }] });
  dbMock.queueInsert("card_holds", [row(overrides)]);
  dbMock.queueSelect("customers", [{ id: "cus_1" }]); // the create
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
  recordApiSnapshot.mockResolvedValue(undefined);
  mirrorOrderById.mockResolvedValue(undefined);
  resolveAcquirer.mockResolvedValue({ acquirer: "stripe", customerId: null });
  holdSettleTiming.intervalMs = 0;
  holdSettleTiming.budgetMs = 20;
});

describe("placing a hold on Stripe", () => {
  it("a card with funds is HELD until Stripe's own capture deadline, nothing charged", async () => {
    queueStripePlacement();
    stripe.paymentIntents.create.mockResolvedValue({
      id: "pi_hold",
      status: "requires_capture",
      created: 1792400000,
      latest_charge: { payment_method_details: { card: { capture_before: CAPTURE_BEFORE } } },
    });

    const { hold, created } = await placeCardHold(PLACE);

    expect(created).toBe(true);
    expect(hold.status).toBe("held");
    expect(hold.reference).toBe("pi_hold");
    expect(hold.expiresAt?.getTime()).toBe(CAPTURE_BEFORE * 1000);
    const [params, opts] = stripe.paymentIntents.create.mock.calls[0];
    expect(params).toMatchObject({
      amount: 5000,
      currency: "usd",
      customer: "cus_1",
      payment_method: "pm_card",
      payment_method_types: ["card"],
      capture_method: "manual",
      confirm: true,
      off_session: false,
      metadata: { org_id: ORG, purpose: "card-hold", hold_id: HOLD_ID },
    });
    expect(opts).toEqual({ idempotencyKey: `card-hold:${HOLD_ID}` });
    // Mirrored so the PaymentIntent exists in silver (and stays out of sums).
    expect(recordApiSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: "pi_hold" }), "payment_intent", ORG);
    expect(liveHold([hold], new Date("2026-10-22T12:00:00Z"))?.id).toBe(HOLD_ID);
  });

  it("an insufficient-funds card is REFUSED with the bank's reason", async () => {
    queueStripePlacement({ session: "off_session" });
    stripe.paymentIntents.create.mockRejectedValue({
      type: "StripeCardError",
      code: "card_declined",
      decline_code: "insufficient_funds",
      message: "Your card has insufficient funds.",
      raw: { payment_intent: { id: "pi_refused", status: "requires_payment_method" } },
    });

    const { hold } = await placeCardHold({ ...PLACE, session: "off_session" });

    expect(hold.status).toBe("refused");
    expect(hold.reference).toBe("pi_refused");
    const view = cardHoldView(hold);
    expect(view.failure).toEqual({
      type: "card_declined",
      code: "insufficient_funds",
      message: "Your card has insufficient funds.",
    });
    expect(view.amount_captured).toBeNull();
    expect(stripe.paymentIntents.create.mock.calls[0][0].off_session).toBe(true);
  });

  it("an on-session hold that needs 3-D Secure hands back the client secret", async () => {
    queueStripePlacement();
    stripe.paymentIntents.create.mockResolvedValue({
      id: "pi_3ds",
      status: "requires_action",
      created: 1792400000,
      client_secret: "pi_3ds_secret_x",
    });

    const placed = await placeCardHold(PLACE);
    const view = cardHoldView(placed.hold, { clientSecret: placed.clientSecret });
    expect(view.status).toBe("requires_action");
    expect(view.client_secret).toBe("pi_3ds_secret_x");
  });

  it("could-not-ask propagates, never reads as a refusal", async () => {
    queueStripePlacement();
    stripe.paymentIntents.create.mockRejectedValue({ type: "StripeConnectionError", message: "down" });
    await expect(placeCardHold(PLACE)).rejects.toMatchObject({ type: "StripeConnectionError" });
  });

  it("a replay of the same key answers the same hold and places nothing", async () => {
    dbMock.queueSelect("card_holds", [row({ status: "held", reference: "pi_hold" })]);
    const { hold, created } = await placeCardHold(PLACE);
    expect(created).toBe(false);
    expect(hold.status).toBe("held");
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("the same key with another amount is refused", async () => {
    dbMock.queueSelect("card_holds", [row({ status: "held" })]);
    await expect(placeCardHold({ ...PLACE, amount: 9900 })).rejects.toBeInstanceOf(HoldIdempotencyKeyReused);
  });
});

describe("capturing a hold", () => {
  const held = () =>
    row({ status: "held", reference: "pi_hold", expiresAt: new Date(Date.now() + 86_400_000) });

  it("a capture of LESS than the hold settles that amount (the rest is released by Stripe)", async () => {
    dbMock.queueSelect("card_holds", [held()]);
    stripe.paymentIntents.capture.mockResolvedValue({
      id: "pi_hold",
      status: "succeeded",
      amount: 5000,
      amount_received: 3693,
    });

    const hold = await captureCardHold({ orgId: ORG, holdId: HOLD_ID, amount: 3693 });

    expect(stripe.paymentIntents.capture).toHaveBeenCalledWith(
      "pi_hold",
      { amount_to_capture: 3693 },
      { idempotencyKey: `card-hold:${HOLD_ID}:capture:3693` }
    );
    expect(hold.status).toBe("captured");
    expect(hold.amountCaptured).toBe(3693);
    // The captured intent is mirrored: it is what credits the org.
    expect(recordApiSnapshot).toHaveBeenCalledWith(expect.objectContaining({ amount_received: 3693 }), "payment_intent", ORG);
  });

  it("a hold already captured for the same amount replays, any other amount is refused", async () => {
    dbMock.queueSelect("card_holds", [row({ status: "captured", amountCaptured: 3693, reference: "pi_hold" })]);
    const again = await captureCardHold({ orgId: ORG, holdId: HOLD_ID, amount: 3693 });
    expect(again.status).toBe("captured");
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
  });

  it("an expired hold cannot be captured", async () => {
    dbMock.queueSelect("card_holds", [
      row({ status: "held", reference: "pi_hold", expiresAt: new Date(Date.now() - 1000) }),
    ]);
    await expect(captureCardHold({ orgId: ORG, holdId: HOLD_ID, amount: 5000 })).rejects.toBeInstanceOf(HoldNotLive);
    expect(stripe.paymentIntents.capture).not.toHaveBeenCalled();
  });
});

describe("expiry", () => {
  it("a held hold past its deadline reads EXPIRED at once", () => {
    const h = row({ status: "held", reference: "pi_hold", expiresAt: new Date("2026-10-29T10:00:00Z") });
    expect(effectiveStatus(h, new Date("2026-10-29T09:59:59Z"))).toBe("held");
    expect(effectiveStatus(h, new Date("2026-10-29T10:00:00Z"))).toBe("expired");
    const view = cardHoldView(h, {}, new Date("2026-10-30T00:00:00Z"));
    expect(view.status).toBe("expired");
    expect(view.ended_at).toBe("2026-10-29T10:00:00.000Z");
    expect(liveHold([h], new Date("2026-10-30T00:00:00Z"))).toBeNull();
  });

  it("the sweep releases a lapsed hold at the acquirer and records it expired, never renews", async () => {
    dbMock.queueSelect("card_holds", [
      row({ status: "held", reference: "pi_hold", expiresAt: new Date("2026-10-29T10:00:00Z") }),
    ]);
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: "pi_hold", status: "requires_capture" });
    stripe.paymentIntents.cancel.mockResolvedValue({ id: "pi_hold", status: "canceled" });

    const n = await sweepExpiredCardHolds(new Date("2026-10-29T10:05:00Z"));

    expect(n).toBe(1);
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_hold", {}, { idempotencyKey: `card-hold:${HOLD_ID}:cancel` });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("the sweep leaves a hold that is still inside its window alone", async () => {
    dbMock.queueSelect("card_holds", [
      row({ status: "held", reference: "pi_hold", expiresAt: new Date("2026-10-29T10:00:00Z") }),
    ]);
    expect(await sweepExpiredCardHolds(new Date("2026-10-28T10:00:00Z"))).toBe(0);
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });
});

describe("Revolut", () => {
  beforeEach(() => {
    resolveAcquirer.mockResolvedValue({ acquirer: "revolut", customerId: "rev-cus" });
    listCustomerPaymentMethods.mockResolvedValue([{ id: "rev-pm", type: "card" }]);
    createOrder.mockResolvedValue({ id: "ord-1", state: "pending", payments: [] });
    payOrderWithSavedMethod.mockResolvedValue({ state: "authorisation_started" });
  });

  function queueRevolutPlacement() {
    dbMock.queueSelect("card_holds", []);
    dbMock.queueInsert("card_holds", [row({ acquirer: "revolut", paymentMethod: "rev-pm" })]);
  }

  it("authorises a manual-capture order with the saved card and reads it as held", async () => {
    queueRevolutPlacement();
    getOrder.mockResolvedValue({
      id: "ord-1",
      state: "authorised",
      capture_deadline: "2026-10-29T10:00:00Z",
      payments: [{ state: "authorised" }],
    });

    const { hold } = await placeCardHold(PLACE);

    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 5000,
        capture_mode: "manual",
        customerId: "rev-cus",
        metadata: expect.objectContaining({ org_id: ORG, purpose: "card-hold", hold_id: HOLD_ID }),
      })
    );
    expect(payOrderWithSavedMethod).toHaveBeenCalledWith("ord-1", "rev-pm", "card");
    expect(hold.status).toBe("held");
    expect(hold.expiresAt?.toISOString()).toBe("2026-10-29T10:00:00.000Z");
    expect(mirrorOrderById).toHaveBeenCalledWith("ord-1", "webhook");
  });

  it("a declined authorisation is refused with Revolut's reason", async () => {
    queueRevolutPlacement();
    getOrder.mockResolvedValue({
      id: "ord-1",
      state: "pending",
      payments: [{ state: "declined", decline_reason: "insufficient_funds" }],
    });
    const { hold } = await placeCardHold(PLACE);
    expect(hold.status).toBe("refused");
    expect(cardHoldView(hold).failure?.code).toBe("insufficient_funds");
  });

  it("a partial capture sends the amount and records what was taken", async () => {
    dbMock.queueSelect("card_holds", [
      row({ acquirer: "revolut", status: "held", reference: "ord-1", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);
    captureOrder.mockResolvedValue({ id: "ord-1", state: "authorised" });
    getOrder.mockResolvedValue({ id: "ord-1", state: "completed", amount: 5000 });

    const hold = await captureCardHold({ orgId: ORG, holdId: HOLD_ID, amount: 3693 });

    expect(captureOrder).toHaveBeenCalledWith("ord-1", 3693);
    expect(hold.status).toBe("captured");
    expect(hold.amountCaptured).toBe(3693);
  });
});
