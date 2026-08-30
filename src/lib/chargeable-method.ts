import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { customers } from "../db/schema";
import type { AcquirerPin } from "./acquirer";
import {
  NoChargeablePaymentMethod,
  resolveStripeChargeablePaymentMethod,
} from "./charge-org";
import { getPlatformStripe } from "./event-processor";
import { listCustomerPaymentMethods } from "./revolut-client";

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
 * ⚠️ Never fails soft. An acquirer we cannot reach propagates, because "we
 * could not ask" and "there is no card" are different answers and only one of
 * them makes a move safe. Treating an outage as "no card" would let exactly the
 * move this exists to refuse go through.
 */
export async function hasChargeablePaymentMethod(
  orgId: string,
  pin: AcquirerPin
): Promise<boolean> {
  if (pin.acquirer === "revolut") {
    // No customer means nothing was ever saved against one, so there is nothing
    // to strand — the same reading `GET /internal/payment_methods` gives.
    if (!pin.customerId) return false;
    const methods = await listCustomerPaymentMethods(pin.customerId);
    return methods.some((m) => m.id);
  }

  const row = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.orgId, orgId))
    .orderBy(desc(customers.syncedAt))
    .limit(1);
  if (row.length === 0) return false;

  const stripe = await getPlatformStripe();
  try {
    await resolveStripeChargeablePaymentMethod(stripe, orgId, row[0].id);
    return true;
  } catch (err) {
    if (err instanceof NoChargeablePaymentMethod) return false;
    throw err;
  }
}
