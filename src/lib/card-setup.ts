import { resolveAcquirer } from "./acquirer";
import { resolvePlatformKey } from "./key-client";
import { createOrder } from "./revolut-client";

/**
 * How a customer adds a card, described so the caller does not have to know
 * which acquirer it is talking to.
 *
 * The two acquirers do NOT do this the same way, and no amount of wrapping
 * makes them. Stripe hosts a billing portal we redirect to; Revolut has no
 * portal at all and saves a card only through a browser widget it must mount
 * itself. So this returns a DESCRIPTOR of the mechanism rather than pretending
 * there is one mechanism — the same rule as everywhere else here: a capability
 * difference is surfaced, never flattened.
 *
 * A consumer switches on `mode`, which is a UI concern it owns anyway. It still
 * never names an acquirer, never resolves a key, and never learns that a
 * particular vendor exists — add a third and only this file changes.
 */
export type CardSetup =
  | {
      object: "card_setup";
      mode: "hosted_redirect";
      /** Send the customer here. */
      url: string;
    }
  | {
      object: "card_setup";
      mode: "embedded_widget";
      /** Publishable key for the acquirer's browser SDK. Safe to expose. */
      public_key: string;
      /** Order token the SDK mounts against. */
      token: string;
      /**
       * What the SDK must be told to save the card FOR. Merchant-initiated is
       * the whole point: without it the card is stored for the customer's own
       * future checkouts and cannot be charged off-session.
       */
      save_payment_method_for: "merchant";
    };

/**
 * Build the card-setup descriptor for an org.
 *
 * ⚠️ Some acquirers cannot store a card without a payment. Revolut is one: "you
 * cannot create a payment method explicitly, they are generated as part of a
 * payment", and there is no zero-amount verification. A zero-amount order is
 * ACCEPTED at create (201) and then cannot be paid — the widget fails with a
 * bare `Transaction failed` and the order sits `pending` with no payment
 * attempt recorded. Verified in production.
 *
 * That does NOT mean the customer must pay to change their card. The standard
 * answer is an AUTHORISATION that is never captured: create the order with
 * `capture_mode: "manual"`, let the customer authorise it, keep the payment
 * method, then cancel the order so the hold is released. No money moves, and
 * nobody has to pick an amount to update a card.
 *
 * `VERIFICATION_AMOUNT` exists only to give the authorisation something to be
 * for. It is never captured, and `cancelCardSetupHold` releases it as soon as
 * the card is saved.
 *
 * Unlike `save_payment_method_for`, `capture_mode` is a REAL field on this
 * endpoint — it is echoed back in the response, which is the only way to tell
 * an accepted parameter from a silently dropped one on an API that returns 201
 * either way.
 */
/**
 * The amount an authorisation is placed for so a card can be verified. Never
 * captured — the hold is released as soon as the method is saved.
 */
export const VERIFICATION_AMOUNT = 100;

export async function buildCardSetup(params: {
  orgId: string;
  /** Where a hosted flow should return the customer to. */
  returnUrl: string;
  /** Currency for the verification authorisation. */
  currency?: string;
  /** Builds the hosted session for the default acquirer. */
  hostedSession: (customerId: string) => Promise<string>;
  /** The org's mirrored customer on the default acquirer. */
  defaultCustomerId: string | null;
}): Promise<CardSetup> {
  const pin = await resolveAcquirer(params.orgId);

  if (pin.acquirer === "revolut") {
    if (!pin.customerId) {
      throw new Error(
        `Org ${params.orgId} is pinned to Revolut but has no acquirer customer`
      );
    }
    const order = await createOrder({
      amount: VERIFICATION_AMOUNT,
      currency: params.currency ?? "USD",
      // Authorise only. The hold is released once the card is saved, so the
      // customer is never charged for updating a card.
      capture_mode: "manual",
      description: "Card verification (released immediately, not charged)",
      customer_id: pin.customerId,
      metadata: { org_id: params.orgId, purpose: "card-setup" },
    });
    const { key } = await resolvePlatformKey("revolut-public", {
      method: "POST",
      path: "/internal/card_setup",
    });
    return {
      object: "card_setup",
      mode: "embedded_widget",
      public_key: key,
      token: order.token as string,
      save_payment_method_for: "merchant",
    };
  }

  if (!params.defaultCustomerId) {
    throw new Error(`Org ${params.orgId} has no customer to set a card up for`);
  }
  return {
    object: "card_setup",
    mode: "hosted_redirect",
    url: await params.hostedSession(params.defaultCustomerId),
  };
}
