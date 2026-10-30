import { describe, it, expect } from "vitest";
import {
  stripeShapedCard,
  withStripeShapedCard,
} from "../../src/lib/revolut-card-display";

/**
 * Captured live 2026-10-31: the saved card of a Revolut-pinned org, as
 * Revolut's GET /customers/{id}/payment-methods returns it (personal fields
 * replaced). Every key observed is present.
 */
const LIVE_REVOLUT_CARD = {
  id: "6ac0bacc-87b5-a746-8407-caf6809aac03",
  type: "card",
  saved_for: "merchant",
  created_at: "2026-10-03T08:20:28.876261Z",
  bin: "000000",
  last_four: "5121",
  expiry_month: 4,
  expiry_year: 2031,
  cardholder_name: "Card Holder",
  brand: "mastercard",
  funding: "credit",
  issuer: "PATRIOT BANK, NATIONAL ASSOCIA",
  issuer_country: "US",
  billing_address: { country_code: "US" },
};

describe("stripeShapedCard", () => {
  it("maps a live Revolut card to the fields billing reads off a Stripe card", () => {
    expect(stripeShapedCard(LIVE_REVOLUT_CARD)).toEqual({
      brand: "mastercard",
      last4: "5121",
      exp_month: 4,
      exp_year: 2031,
      country: "US",
      funding: "credit",
    });
  });

  it("spells the brand the way Stripe does", () => {
    const brand = (b: string) =>
      stripeShapedCard({ ...LIVE_REVOLUT_CARD, brand: b }).brand;
    expect(brand("VISA")).toBe("visa");
    expect(brand("MASTERCARD")).toBe("mastercard");
    expect(brand("AMERICAN_EXPRESS")).toBe("amex");
    expect(brand("american express")).toBe("amex");
    expect(brand("DINERS_CLUB")).toBe("diners");
    expect(brand("maestro")).toBe("maestro");
  });

  it("invents nothing: a field Revolut omits is null", () => {
    expect(stripeShapedCard({ id: "pm-1", type: "card" })).toEqual({
      brand: null,
      last4: null,
      exp_month: null,
      exp_year: null,
      country: null,
      funding: null,
    });
  });
});

describe("withStripeShapedCard", () => {
  it("keeps every Revolut field and adds card", () => {
    const out = withStripeShapedCard(LIVE_REVOLUT_CARD);
    expect(out).toMatchObject(LIVE_REVOLUT_CARD);
    expect(out.card?.last4).toBe("5121");
  });

  it("leaves a non-card method untouched", () => {
    const m = { id: "pm-2", type: "revolut_pay" };
    expect(withStripeShapedCard(m)).toEqual(m);
  });
});
