/**
 * The ONE conversion rule for an acquiring fee into USD cents, shared by the
 * runs-service declaration (`declare-fees`) and the monthly history read
 * (`acquiring-fees`) so the two can never state the same fee differently.
 *
 * Stripe states a balance transaction in the account's SETTLEMENT currency: this
 * account settled in EUR until 2026-08-13. Its own `exchange_rate` converts the
 * charge currency (USD) into that settlement currency, so USD = fee / rate. No
 * guessed, global or external rate, ever: a non-USD fee with no rate of its own
 * is UNCONVERTIBLE (`null`), never summed as USD.
 *
 * Revolut records no rate on an order's fee, so a non-USD Revolut fee is
 * unconvertible too.
 */
export function stripeFeeUsdCents(
  fee: number,
  currency: string,
  exchangeRate: number | null | undefined
): number | null {
  if (currency.toLowerCase() === "usd") return fee;
  if (!exchangeRate) return null;
  return Math.round(fee / exchangeRate);
}

export function revolutFeeUsdCents(fee: number, currency: string): number | null {
  return currency.toLowerCase() === "usd" ? fee : null;
}
