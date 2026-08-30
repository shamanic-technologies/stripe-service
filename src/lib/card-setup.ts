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
 * ⚠️ Some acquirers CANNOT store a card without taking a payment. Revolut is
 * one: "you cannot create a payment method explicitly, they are generated as
 * part of a payment", and there is no zero-amount verification. A zero-amount
 * order is ACCEPTED at create (201) and then simply cannot be paid — the widget
 * fails with a bare "Transaction failed" and the order sits `pending` with no
 * payment attempt recorded at all. Verified in production, the hard way.
 *
 * So a widget flow needs a REAL amount, and the honest product shape is to fold
 * card-saving into a payment the customer wanted to make anyway rather than
 * charge them a token sum for nothing.
 *
 * ⚠️ `save_payment_method_for` is NOT sent on the order: this API silently
 * ignores unknown fields there, and it was verified to do exactly that — a real
 * card paid a real order carrying it and no method was saved. The flag only
 * takes effect when the browser SDK is initialised with it, which is why it is
 * returned here for the consumer to pass on rather than set server-side.
 */
export class CardSetupNeedsAmount extends Error {
  constructor() {
    super(
      "This org's acquirer cannot store a card without taking a payment: " +
        "pass the amount the customer is paying, and the card is saved with it"
    );
    this.name = "CardSetupNeedsAmount";
  }
}

export async function buildCardSetup(params: {
  orgId: string;
  /** Where a hosted flow should return the customer to. */
  returnUrl: string;
  /**
   * Minor units the customer is paying now. Required for an acquirer that can
   * only save a card during a payment; ignored by one with a hosted portal,
   * which stores a card on its own.
   */
  amount?: number;
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
    if (!params.amount || params.amount <= 0) throw new CardSetupNeedsAmount();
    const order = await createOrder({
      amount: params.amount,
      currency: params.currency ?? "USD",
      description: "Top-up, saving the card for automatic top-ups",
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
