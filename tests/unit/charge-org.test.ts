import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

const listCustomerPaymentMethods = vi.fn();
const createOrder = vi.fn();
const payOrderWithSavedMethod = vi.fn();
vi.mock("../../src/lib/revolut-client", () => ({
  listCustomerPaymentMethods: (...a: unknown[]) => listCustomerPaymentMethods(...a),
  createOrder: (...a: unknown[]) => createOrder(...a),
  payOrderWithSavedMethod: (...a: unknown[]) => payOrderWithSavedMethod(...a),
}));
const mirrorOrderById = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/lib/revolut-processor", () => ({
  mirrorOrderById: (...a: unknown[]) => mirrorOrderById(...a),
}));

import {
  chargeViaRevolut,
  chargeResultFromInvoice,
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
        customer_id: "cus-rev-1",
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
