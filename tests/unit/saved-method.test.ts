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
      method: { id: "pm-rev-1", type: "card", saved_for: "merchant", funding: null, prepaid: null, country: null },
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
    paymentMethodsList.mockResolvedValue({ data: [{ id: "pm_card_1", type: "card" }] });

    expect(await confirmSavedPaymentMethod("org-1")).toEqual({
      object: "saved_payment_method",
      acquirer: "stripe",
      saved: true,
      method: { id: "pm_card_1", type: "card", saved_for: null, funding: null, prepaid: null, country: null },
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

describe("confirmSavedPaymentMethod — is the saved card PREPAID (both acquirers)", () => {
  it.each([
    ["prepaid", "prepaid", true],
    ["debit", "debit", false],
    ["credit", "credit", false],
    ["PREPAID", "prepaid", true],
  ])("Revolut funding %s -> funding %s, prepaid %s", async (raw, funding, prepaid) => {
    pinnedToRevolut();
    // Shape observed live 2026-10-12 on GET /customers/{id}/payment-methods.
    listCustomerPaymentMethods.mockResolvedValue([
      { id: "pm-rev-1", type: "card", saved_for: "merchant", funding: raw },
    ]);

    const out = await confirmSavedPaymentMethod("org-1");
    expect(out.saved && out.method).toMatchObject({ funding, prepaid });
  });

  it("Revolut stating no funding is UNKNOWN (null), never not-prepaid", async () => {
    pinnedToRevolut();
    listCustomerPaymentMethods.mockResolvedValue([
      { id: "pm-rev-1", type: "card", saved_for: "merchant" },
    ]);

    const out = await confirmSavedPaymentMethod("org-1");
    expect(out.saved && out.method).toMatchObject({ funding: null, prepaid: null });
  });

  it.each([
    ["prepaid", "prepaid", true],
    ["debit", "debit", false],
    ["credit", "credit", false],
    ["unknown", null, null],
  ])("Stripe card.funding %s -> funding %s, prepaid %s", async (raw, funding, prepaid) => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_stripe_1" }]);
    paymentMethodsList.mockResolvedValue({
      data: [{ id: "pm_card_1", type: "card", card: { funding: raw } }],
    });

    const out = await confirmSavedPaymentMethod("org-1");
    expect(out.saved && out.method).toMatchObject({ id: "pm_card_1", funding, prepaid });
  });

  it("a Stripe Link method has no card, so its funding is unknown", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_stripe_1" }]);
    paymentMethodsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id: "pm_link_1", type: "link" }] });

    const out = await confirmSavedPaymentMethod("org-1");
    expect(out.saved && out.method).toMatchObject({
      id: "pm_link_1",
      funding: null,
      prepaid: null,
    });
  });

  it("a Revolut card states the country it was issued in (prod shape 2026-10-13)", async () => {
    pinnedToRevolut();
    listCustomerPaymentMethods.mockResolvedValue([
      {
        id: "pm-rev-1",
        type: "card",
        saved_for: "merchant",
        funding: "prepaid",
        issuer_country: "US",
        billing_address: { country_code: "US" },
      },
    ]);

    const out = await confirmSavedPaymentMethod("org-1");
    expect(out.saved && out.method).toMatchObject({ prepaid: true, country: "US" });
  });

  it("a Stripe card states card.country, uppercased", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_stripe_1" }]);
    paymentMethodsList.mockResolvedValue({
      data: [{ id: "pm_card_1", type: "card", card: { funding: "credit", country: "fr" } }],
    });

    const out = await confirmSavedPaymentMethod("org-1");
    expect(out.saved && out.method).toMatchObject({ type: "card", prepaid: false, country: "FR" });
  });

  it("a Stripe Link method says it is link, reads its funding-source country off its latest charge, funding stays unknown", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_stripe_1" }]);
    paymentMethodsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id: "pm_link_1", type: "link" }] });
    dbMock.queueExecute([{ country: "US" }]);

    const out = await confirmSavedPaymentMethod("org-1");
    expect(out.saved && out.method).toEqual({
      id: "pm_link_1",
      type: "link",
      saved_for: null,
      funding: null,
      prepaid: null,
      country: "US",
    });
  });

  it("a Link method never charged yet has an unknown country, never a guess", async () => {
    dbMock.queueSelect("org_acquirers", []);
    dbMock.queueSelect("customers", [{ id: "cus_stripe_1" }]);
    paymentMethodsList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id: "pm_link_1", type: "link" }] });
    dbMock.queueExecute([]);

    const out = await confirmSavedPaymentMethod("org-1");
    expect(out.saved && out.method).toMatchObject({ country: null, funding: null, prepaid: null });
  });

  it("the recurring-charge authorization carries the same fact", async () => {
    pinnedToRevolut();
    listCustomerPaymentMethods.mockResolvedValue([
      { id: "pm-rev-1", type: "card", saved_for: "merchant", funding: "prepaid" },
    ]);

    const auth = await authorizeRecurringCharges("org-1");
    expect(auth.method).toMatchObject({ funding: "prepaid", prepaid: true });
  });
});
