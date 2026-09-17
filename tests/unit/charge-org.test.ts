import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

const listCustomerPaymentMethods = vi.fn();
const createOrder = vi.fn();
const payOrderWithSavedMethod = vi.fn();
const getOrder = vi.fn();
vi.mock("../../src/lib/revolut-client", () => ({
  listCustomerPaymentMethods: (...a: unknown[]) => listCustomerPaymentMethods(...a),
  createOrder: (...a: unknown[]) => createOrder(...a),
  payOrderWithSavedMethod: (...a: unknown[]) => payOrderWithSavedMethod(...a),
  getOrder: (...a: unknown[]) => getOrder(...a),
}));
vi.mock("../../src/lib/event-processor", () => ({
  recordApiSnapshot: vi.fn().mockResolvedValue(undefined),
}));
const mirrorOrderById = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/lib/revolut-processor", () => ({
  mirrorOrderById: (...a: unknown[]) => mirrorOrderById(...a),
}));

import {
  chargeViaRevolut,
  chargeViaStripeInvoice,
  chargeResultFromInvoice,
  chargeResultFromDecline,
  cardDeclineFrom,
  CardDeclined,
  resolveStripeChargeablePaymentMethod,
  NoChargeablePaymentMethod,
} from "../../src/lib/charge-org";

const BASE = {
  orgId: "org-1",
  customerId: "cus-rev-1",
  amount: 50000,
  currency: "USD",
  description: "Distribute credit top-up",
};

beforeEach(() => {
  vi.clearAllMocks();
  mirrorOrderById.mockResolvedValue(undefined);
});

describe("chargeViaRevolut", () => {
  it("charges the saved card and reports success in neutral shape", async () => {
    listCustomerPaymentMethods.mockResolvedValue([{ id: "pm-1", type: "card" }]);
    createOrder.mockResolvedValue({ id: "ord-1", state: "pending" });
    payOrderWithSavedMethod.mockResolvedValue({ id: "ord-1", state: "completed" });

    const out = await chargeViaRevolut(BASE);

    expect(payOrderWithSavedMethod).toHaveBeenCalledWith("ord-1", "pm-1", "card");
    expect(out).toEqual({
      object: "charge_result",
      org_id: "org-1",
      acquirer: "revolut",
      reference: "ord-1",
      status: "succeeded",
      amount: 50000,
      currency: "USD",
      // Revolut has no invoice object. Null is the honest answer.
      hosted_document_url: null,
    });
  });

  it("stamps the org on the order so the mirror can attribute it", async () => {
    listCustomerPaymentMethods.mockResolvedValue([{ id: "pm-1", type: "card" }]);
    createOrder.mockResolvedValue({ id: "ord-1" });
    payOrderWithSavedMethod.mockResolvedValue({ id: "ord-1", state: "completed" });

    await chargeViaRevolut({ ...BASE, metadata: { reason: "auto_reload" } });

    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 50000,
        currency: "USD",
        customerId: "cus-rev-1",
        metadata: { reason: "auto_reload", org_id: "org-1" },
      })
    );
  });

  it("reports failure rather than success when the charge does not complete", async () => {
    listCustomerPaymentMethods.mockResolvedValue([{ id: "pm-1", type: "card" }]);
    createOrder.mockResolvedValue({ id: "ord-1" });
    payOrderWithSavedMethod.mockResolvedValue({ id: "ord-1", state: "failed" });

    expect((await chargeViaRevolut(BASE)).status).toBe("failed");
  });

  it("mirrors the order even when the charge THROWS, so a decline is not invisible", async () => {
    listCustomerPaymentMethods.mockResolvedValue([{ id: "pm-1", type: "card" }]);
    createOrder.mockResolvedValue({ id: "ord-1" });
    payOrderWithSavedMethod.mockRejectedValue(new Error("card declined"));

    await expect(chargeViaRevolut(BASE)).rejects.toThrow("card declined");
    expect(mirrorOrderById).toHaveBeenCalledWith("ord-1", "webhook");
  });

  it("refuses before creating an order when there is no saved card", async () => {
    listCustomerPaymentMethods.mockResolvedValue([]);

    await expect(chargeViaRevolut(BASE)).rejects.toBeInstanceOf(
      NoChargeablePaymentMethod
    );
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("reads the saved methods LIVE on every charge", async () => {
    // Revolut invalidates merchant-initiated eligibility when a customer
    // updates their card, with no event. A cached list would push that failure
    // to the acquirer, where the reason is not legible.
    listCustomerPaymentMethods.mockResolvedValue([{ id: "pm-1", type: "card" }]);
    createOrder.mockResolvedValue({ id: "ord-1" });
    payOrderWithSavedMethod.mockResolvedValue({ id: "ord-1", state: "completed" });

    await chargeViaRevolut(BASE);
    await chargeViaRevolut(BASE);

    expect(listCustomerPaymentMethods).toHaveBeenCalledTimes(2);
  });
});

describe("chargeResultFromInvoice", () => {
  it("carries the hosted invoice through for a Stripe org", () => {
    const out = chargeResultFromInvoice(
      "org-1",
      {
        id: "in_1",
        status: "paid",
        hosted_invoice_url: "https://invoice.stripe.com/x",
      } as never,
      50000,
      "usd"
    );
    expect(out).toMatchObject({
      acquirer: "stripe",
      reference: "in_1",
      status: "succeeded",
      hosted_document_url: "https://invoice.stripe.com/x",
    });
  });

  it("is not succeeded for an invoice that is not paid", () => {
    expect(
      chargeResultFromInvoice("org-1", { id: "in_1", status: "open" } as never, 1, "usd")
        .status
    ).toBe("failed");
  });
});

describe("chargeViaRevolut — retrying one logical top-up", () => {
  beforeEach(() => {
    dbMock.clearQueues();
    listCustomerPaymentMethods.mockResolvedValue([{ id: "pm-1", type: "card" }]);
  });

  it("stamps the caller's key on the order, which is what a retry finds", async () => {
    dbMock.queueSelect("revolut_orders", []);
    createOrder.mockResolvedValue({ id: "ord-1" });
    payOrderWithSavedMethod.mockResolvedValue({ id: "ord-1", state: "completed" });

    await chargeViaRevolut({ ...BASE, idempotencyKey: "topup_1" });

    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ idempotency_key: "topup_1" }),
      })
    );
  });

  it("does NOT take the money twice when the same top-up is retried", async () => {
    // The first attempt's order is mirrored, so the retry finds it completed.
    dbMock.queueSelect("revolut_orders", [{ id: "ord-1" }]);
    getOrder.mockResolvedValue({ id: "ord-1", state: "completed" });

    const out = await chargeViaRevolut({ ...BASE, idempotencyKey: "topup_1" });

    expect(createOrder).not.toHaveBeenCalled();
    expect(payOrderWithSavedMethod).not.toHaveBeenCalled();
    expect(out).toMatchObject({ reference: "ord-1", status: "succeeded" });
  });

  it("resumes the order it already created rather than minting a second one", async () => {
    // A crash between create and pay leaves an unpaid order carrying the key.
    dbMock.queueSelect("revolut_orders", [{ id: "ord-1" }]);
    getOrder.mockResolvedValue({ id: "ord-1", state: "pending" });
    payOrderWithSavedMethod.mockResolvedValue({ id: "ord-1", state: "completed" });

    const out = await chargeViaRevolut({ ...BASE, idempotencyKey: "topup_1" });

    expect(createOrder).not.toHaveBeenCalled();
    expect(payOrderWithSavedMethod).toHaveBeenCalledWith("ord-1", "pm-1", "card");
    expect(out).toMatchObject({ reference: "ord-1", status: "succeeded" });
  });
});

describe("resolveStripeChargeablePaymentMethod", () => {
  function stripeWith(byType: Record<string, unknown[]>) {
    return {
      paymentMethods: {
        list: vi.fn(async ({ type }: { type: string }) => ({
          object: "list",
          data: byType[type] ?? [],
        })),
      },
    } as never;
  }

  it("prefers the saved card", async () => {
    const stripe = stripeWith({
      card: [{ id: "pm_card_1" }],
      link: [{ id: "pm_link_1" }],
    });
    await expect(
      resolveStripeChargeablePaymentMethod(stripe, "org-1", "cus_x")
    ).resolves.toBe("pm_card_1");
  });

  it("falls back to a Link-saved method, which IS chargeable when named by id", async () => {
    const stripe = stripeWith({ card: [], link: [{ id: "pm_link_1" }] });
    await expect(
      resolveStripeChargeablePaymentMethod(stripe, "org-1", "cus_x")
    ).resolves.toBe("pm_link_1");
  });

  it("refuses loudly rather than falling through to the customer's default", async () => {
    const stripe = stripeWith({ card: [], link: [] });
    await expect(
      resolveStripeChargeablePaymentMethod(stripe, "org-1", "cus_x")
    ).rejects.toBeInstanceOf(NoChargeablePaymentMethod);
  });
});

// A refused card and an acquirer we could not reach are different answers, and
// the whole defect this covers was reporting the first as the second. The
// production incident these are written from (2026-09-17): Stripe refused an
// off-session invoice payment with `type: "card_error"`, `code:
// "payment_intent_payment_attempt_failed"`, `decline_code: "generic_decline"`
// on a `link` method — and billing-service received a 502 naming OUR
// infrastructure, so the first diagnosis was an outage that never happened.
describe("classifying an acquirer's refusal", () => {
  const stripeThatRefusesPayment = (err: unknown) => ({
    invoices: {
      create: vi.fn().mockResolvedValue({ id: "in_1", status: "draft" }),
      finalizeInvoice: vi.fn().mockResolvedValue({ id: "in_1", status: "open" }),
      pay: vi.fn().mockRejectedValue(err),
    },
    invoiceItems: { create: vi.fn().mockResolvedValue({ id: "ii_1" }) },
    paymentIntents: { update: vi.fn() },
  });

  const STRIPE_ARGS = {
    orgId: "org-1",
    customerId: "cus_1",
    amount: 50000,
    currency: "usd",
    description: "Distribute credit top-up",
    idempotencyKey: "topup_1",
  };

  it("reads the real production refusal as a decline, reason and all", () => {
    const declined = cardDeclineFrom(
      {
        type: "StripeCardError",
        rawType: "card_error",
        code: "payment_intent_payment_attempt_failed",
        decline_code: "generic_decline",
        message: "The payment failed.",
      },
      "in_1"
    );
    expect(declined).toBeInstanceOf(CardDeclined);
    // The BANK's reason wins over Stripe's generic attempt-failed code: it is
    // what decides whether the customer is told "insufficient funds" or
    // "expired card".
    expect(declined?.toFailure()).toEqual({
      type: "card_declined",
      code: "generic_decline",
      message: "The payment failed.",
    });
  });

  it("falls back to `code` when the bank named no decline reason", () => {
    const declined = cardDeclineFrom(
      { type: "card_error", code: "expired_card", message: "Your card has expired." },
      null
    );
    expect(declined?.code).toBe("expired_card");
  });

  it("is NOT a decline when the acquirer could not be reached", () => {
    // The regression this file exists to stop, read from the other side: a
    // connection error must stay an error, never be reported as a refused card.
    expect(cardDeclineFrom(new Error("fetch failed"), null)).toBeNull();
    expect(
      cardDeclineFrom({ type: "StripeConnectionError", message: "connection" }, null)
    ).toBeNull();
    expect(cardDeclineFrom({ type: "StripeAPIError" }, null)).toBeNull();
    expect(cardDeclineFrom(null, null)).toBeNull();
  });

  it("throws a declined card as CardDeclined, never as a bare acquirer error", async () => {
    const stripe = stripeThatRefusesPayment({
      type: "StripeCardError",
      rawType: "card_error",
      code: "card_declined",
      decline_code: "insufficient_funds",
      message: "Your card has insufficient funds.",
    });

    await expect(
      chargeViaStripeInvoice({ ...STRIPE_ARGS, stripe: stripe as never })
    ).rejects.toBeInstanceOf(CardDeclined);
  });

  it("keeps an unreachable acquirer an unreachable acquirer", async () => {
    const boom = new Error("connection error");
    const stripe = stripeThatRefusesPayment(boom);

    await expect(
      chargeViaStripeInvoice({ ...STRIPE_ARGS, stripe: stripe as never })
    ).rejects.toBe(boom);
  });

  it("shapes a refusal as a completed request describing a failed charge", () => {
    const declined = new CardDeclined({
      code: "insufficient_funds",
      declineMessage: "Your card has insufficient funds.",
      reference: "in_7",
    });

    expect(chargeResultFromDecline("org-1", "stripe", declined, 50000, "usd")).toEqual({
      object: "charge_result",
      org_id: "org-1",
      acquirer: "stripe",
      reference: "in_7",
      status: "failed",
      amount: 50000,
      currency: "usd",
      hosted_document_url: null,
      failure: {
        type: "card_declined",
        code: "insufficient_funds",
        message: "Your card has insufficient funds.",
      },
    });
  });
});
