import type Stripe from "stripe";

/**
 * Detach EVERY payment method a Stripe customer holds.
 *
 * A customer who asks us to stop holding their card is asking about all of
 * them, not about the default one. Two reasons the scope is total rather than
 * "the card they are looking at":
 *
 *  - Leaving a second method attached means we still hold a card the customer
 *    told us to let go of, which is the thing they asked us not to do.
 *  - A method that survives WITHOUT being the customer default reads downstream
 *    as "no card" (`deriveHasPaymentMethod` follows
 *    `invoice_settings.default_payment_method`) while still sitting on file —
 *    the worst of both: nothing can be charged, and the card is still ours.
 *
 * Auto-paginated, so the answer is the whole set rather than a page of it, and
 * the list is taken with NO type filter: a Link or wallet method is not
 * chargeable off-session but it is still a method we hold.
 *
 * ## Idempotent, and never refused
 *
 * A method Stripe reports as already gone (`resource_missing`) is success —
 * the end state is the one the caller asked for — and it is counted as
 * `already_detached` rather than silently folded into the removals, so a
 * caller can tell a real detach from a replayed one. A customer with nothing
 * attached is a clean, empty answer, not an error.
 *
 * ## Fail loud on everything else
 *
 * Any other Stripe error propagates. This is a deliberate, explicit action a
 * customer asked for by name, and a caller that cannot tell whether the card
 * is gone must retry rather than report a removal that did not happen. The
 * detach is safe to repeat.
 */
export interface PaymentMethodRemoval {
  detached: string[];
  alreadyDetached: string[];
}

export async function detachAllPaymentMethods(
  stripe: Stripe,
  customerId: string
): Promise<PaymentMethodRemoval> {
  const ids: string[] = [];
  for await (const pm of stripe.paymentMethods.list({
    customer: customerId,
    limit: 100,
  })) {
    if (pm.id) ids.push(pm.id);
  }

  const detached: string[] = [];
  const alreadyDetached: string[] = [];

  for (const id of ids) {
    try {
      await stripe.paymentMethods.detach(id);
      detached.push(id);
    } catch (err) {
      if (isResourceMissing(err)) {
        alreadyDetached.push(id);
        continue;
      }
      throw err;
    }
  }

  return { detached, alreadyDetached };
}

/**
 * Read by SHAPE, never `instanceof`: the SDK is mocked in tests, and the
 * sibling helper in `stripe-client.ts` keys on `instanceof Stripe.errors`,
 * which a mock can never satisfy. Stripe states an already-gone object as
 * `code: "resource_missing"` on the error itself.
 */
function isResourceMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number } | null;
  return e?.code === "resource_missing" || e?.statusCode === 404;
}
