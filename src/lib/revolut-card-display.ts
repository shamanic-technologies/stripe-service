import type { RevolutPaymentMethod } from "./revolut-client";

/**
 * The Stripe-shaped `card` sub-object a consumer already reads off a payment
 * method (`card.brand`, `card.last4`, `card.exp_month`, `card.exp_year`,
 * `card.country`, `card.funding`), built from what Revolut states about a saved
 * card. Revolut carries the same facts under its own names (`brand`,
 * `last_four`, `expiry_month`, `expiry_year`, `issuer_country`, `funding`,
 * observed live 2026-10-31 on a saved Mastercard); without this every
 * Revolut-pinned org read as a card with no brand, no last 4, no expiry and no
 * issuing country, which also blinded the issuing-country reload gate.
 *
 * Nothing is invented: a field Revolut does not return is `null`. Brand is
 * lowercased to Stripe's spelling (`mastercard`, `visa`), and the two network
 * names Stripe abbreviates are renamed (`american_express` → `amex`,
 * `diners_club` → `diners`); any other brand is passed through lowercased.
 */
export interface StripeShapedCard {
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  country: string | null;
  funding: string | null;
}

const STRIPE_BRAND_NAMES: Record<string, string> = {
  american_express: "amex",
  americanexpress: "amex",
  diners_club: "diners",
  dinersclub: "diners",
};

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function int(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

export function stripeShapedCard(m: RevolutPaymentMethod): StripeShapedCard {
  const rawBrand = text(m.brand)?.toLowerCase().replace(/[\s-]+/g, "_") ?? null;
  const brand = rawBrand ? STRIPE_BRAND_NAMES[rawBrand] ?? rawBrand : null;
  const country = text(m.issuer_country)?.toUpperCase() ?? null;
  return {
    brand,
    last4: text(m.last_four),
    exp_month: int(m.expiry_month),
    exp_year: int(m.expiry_year),
    country,
    funding: text(m.funding)?.toLowerCase() ?? null,
  };
}

/**
 * A Revolut method as served on the org-keyed payment-methods read: every
 * Revolut field verbatim, PLUS the Stripe-shaped `card` object when the method
 * is a card. Additive only; a non-card method is returned untouched.
 */
export function withStripeShapedCard(
  m: RevolutPaymentMethod
): RevolutPaymentMethod & { card?: StripeShapedCard } {
  if (m.type !== "card") return m;
  return { ...m, card: stripeShapedCard(m) };
}
