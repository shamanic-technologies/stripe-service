import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock } = vi.hoisted(() => {
  const { makeDbMock } = require("../helpers/mocks-factory.cjs");
  return { dbMock: makeDbMock(vi) };
});
vi.mock("../../src/db", () => ({ db: dbMock.db, pool: {} }));

const listCustomerPaymentMethods = vi.fn();
vi.mock("../../src/lib/revolut-client", () => ({
  listCustomerPaymentMethods: (...a: unknown[]) =>
    listCustomerPaymentMethods(...a),
}));

const paymentMethodsList = vi.fn();
vi.mock("../../src/lib/event-processor", () => ({
  getPlatformStripe: async () => ({
    paymentMethods: { list: (...a: unknown[]) => paymentMethodsList(...a) },
  }),
}));

import {
  authorizeRecurringCharges,
  confirmSavedPaymentMethod,
  NoSavedPaymentMethod,
} from "../../src/lib/saved-method";
import { hasChargeablePaymentMethod } from "../../src/lib/chargeable-method";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.clearQueues();
});

function pinnedToRevolut(customerId: string | null = "cus-rev-1") {
  dbMock.queueSelect("org_acquirers", [{ acquirer: "revolut", customerId }]);
}

describe("confirmSavedPaymentMethod — the three answers stay apart", () => {
  it("says a card IS saved, and names the method a later charge would use", async () => {
    pinnedToRevolut();
    listCustomerPaymentMethods.mockResolvedValue([
      { id: "pm-rev-1", type: "card", saved_for: "merchant" },
    ]);

    expect(await confirmSavedPaymentMethod("org-1")).toEqual({
      object: "saved_payment_method",
      acquirer: "revolut",
      saved: true,
      method: { id: "pm-rev-1", type: "card", saved_for: "merchant" },
    });
  });

  it("says NO card is saved when the acquirer answers with an empty list", async () => {
    pinnedToRevolut();
    listCustomerPaymentMethods.mockResolvedValue([]);

    expect(await confirmSavedPaymentMethod("org-1")).toMatchObject({
      saved: false,
      method: null,
      reason: "no_saved_method",
    });
  });

  it("does NOT count a method saved only for the customer's own checkouts", async () => {
    // This is the failure the whole feature exists for, one step further in: a
    // card that exists but cannot be charged with nobody on the page is not a
    // card automatic top-up can use, and reporting it as one would arm charges
    // that decline later for a reason nobody can see.
    pinnedToRevolut();
    listCustomerPaymentMethods.mockResolvedValue([
      { id: "pm-rev-1", type: "card", saved_for: "customer" },
    ]);

    expect(await confirmSavedPaymentMethod("org-1")).toMatchObject({
      saved: false,
      reason: "not_saved_for_merchant",
    });
  });

  it("says NO customer when the org has none at its acquirer", async () => {
    pinnedToRevolut(null);
    expect(await confirmSavedPaymentMethod("org-1")).toMatchObject({
      saved: false,
      reason: "no_customer",
    });
    expect(listCustomerPaymentMethods).not.toHaveBeenCalled();
  });

  it("THROWS when the acquirer cannot be asked — never 'no card'", async () => {
    pinnedToRevolut();
    listCustomerPaymentMethods.mockRejectedValue(new Error("502 upstream"));

    await expect(confirmSavedPaymentMethod("org-1")).rejects.toThrow(/502/);
  });

  it("reads Stripe the same way, through the resolution the charge itself uses", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_stripe_1" }]);
    paymentMethodsList.mockResolvedValue({ data: [{ id: "pm_card_1" }] });

    expect(await confirmSavedPaymentMethod("org-1")).toEqual({
      object: "saved_payment_method",
      acquirer: "stripe",
      saved: true,
      method: { id: "pm_card_1", type: "card", saved_for: null },
    });
  });

  it("propagates a Stripe outage rather than reporting no card", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_stripe_1" }]);
    paymentMethodsList.mockRejectedValue(new Error("Stripe unreachable"));

    await expect(confirmSavedPaymentMethod("org-1")).rejects.toThrow(
      /unreachable/
    );
  });
});

describe("authorizeRecurringCharges — the invariant", () => {
  it("REFUSES to arm recurring charges when no card is saved", async () => {
    pinnedToRevolut();
    listCustomerPaymentMethods.mockResolvedValue([]);

    await expect(authorizeRecurringCharges("org-1")).rejects.toBeInstanceOf(
      NoSavedPaymentMethod
    );
  });

  it("REFUSES when the card cannot be charged merchant-initiated", async () => {
    pinnedToRevolut();
    listCustomerPaymentMethods.mockResolvedValue([
      { id: "pm-rev-1", type: "card", saved_for: "customer" },
    ]);

    await expect(authorizeRecurringCharges("org-1")).rejects.toMatchObject({
      reason: "not_saved_for_merchant",
    });
  });

  it("REFUSES with an ERROR, not a refusal, when the acquirer cannot be asked", async () => {
    // "We could not ask" must never collapse into "no card": one is retryable
    // and the other is a decision. A caller that sees the refusal type would
    // reasonably tell the customer to add a card that is already there.
    pinnedToRevolut();
    listCustomerPaymentMethods.mockRejectedValue(new Error("timeout"));

    await expect(authorizeRecurringCharges("org-1")).rejects.not.toBeInstanceOf(
      NoSavedPaymentMethod
    );
  });

  it("arms only from a confirmation that actually came back saved", async () => {
    pinnedToRevolut();
    listCustomerPaymentMethods.mockResolvedValue([
      { id: "pm-rev-1", type: "card", saved_for: "merchant" },
    ]);

    const authorization = await authorizeRecurringCharges("org-1");
    expect(authorization).toMatchObject({
      orgId: "org-1",
      acquirer: "revolut",
      method: { id: "pm-rev-1" },
    });
    // The authorization is minted from the live read, so its method is the one
    // a later charge will actually name.
    expect(listCustomerPaymentMethods).toHaveBeenCalledWith("cus-rev-1");
  });
});

describe("hasChargeablePaymentMethod is the same read, not a second one", () => {
  it("agrees with the confirmation, and still propagates an outage", async () => {
    listCustomerPaymentMethods.mockResolvedValue([
      { id: "pm-rev-1", type: "card", saved_for: "merchant" },
    ]);
    const pin = { acquirer: "revolut" as const, customerId: "cus-rev-1", pinned: true };
    expect(await hasChargeablePaymentMethod("org-1", pin)).toBe(true);

    listCustomerPaymentMethods.mockResolvedValue([]);
    expect(await hasChargeablePaymentMethod("org-1", pin)).toBe(false);

    listCustomerPaymentMethods.mockRejectedValue(new Error("down"));
    await expect(hasChargeablePaymentMethod("org-1", pin)).rejects.toThrow(
      /down/
    );
  });
});
