import type { AcquirerPin } from "./acquirer";
import { confirmSavedPaymentMethod } from "./saved-method";

/**
 * Can this org be charged right now, on the acquirer it is currently on?
 *
 * The same question the neutral charge asks itself before taking money, asked
 * ahead of time so a pin operation can refuse to make the answer go from true
 * to false. It is read LIVE from the acquirer for the same reason the charge
 * reads it live: a card that was detached, replaced or made ineligible is only
 * knowable at the acquirer, and a cached "yes" here would let a move strand a
 * card that is no longer there.
 *
 * It is a thin reading of `confirmSavedPaymentMethod`, deliberately: "does this
 * org have a chargeable card" must have exactly ONE implementation, or the pin
 * guard, the rollout guard and the answer we give a caller can disagree about
 * the same org at the same instant.
 *
 * ⚠️ Never fails soft. An acquirer we cannot reach propagates, because "we
 * could not ask" and "there is no card" are different answers and only one of
 * them makes a move safe. Treating an outage as "no card" would let exactly the
 * move this exists to refuse go through.
 */
export async function hasChargeablePaymentMethod(
  orgId: string,
  pin: AcquirerPin
): Promise<boolean> {
  const confirmation = await confirmSavedPaymentMethod(orgId, pin);
  return confirmation.saved;
}
