import { resolveAcquirer } from "./acquirer";
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
      /**
       * The acquirer's browser SDK, to load in the page. Given rather than
       * hardcoded so the environment is decided here, next to the key that
       * created the order, instead of in a dashboard build.
       */
      script_url: string;
      /** The SDK's environment argument. */
      environment: "prod" | "sandbox";
      /**
       * The PER-ORDER PUBLIC identifier the SDK is initialised with. This is
       * the only credential the browser gets, it is scoped to this one order,
       * and it is not a secret.
       *
       * Verified against the SDK the page actually loads (@revolut/checkout
       * 1.1.25, `RevolutCheckoutLoader(token, mode)`), whose own doc comment
       * reads: "@param token `public_id` from create payment order API
       * request". No merchant key is involved on this path — the publishable
       * key belongs to the `payments()` / `embeddedCheckout()` entry points,
       * and NEITHER of those can save a card.
       */
      token: string;
      /**
       * What the browser must pass when it submits the card field. Saving for
       * MERCHANT use is the whole point: a card saved for the customer's own
       * checkouts cannot be charged with nobody on the page, so automatic
       * top-up could never use it.
       *
       * This is a WIDGET parameter, not an order parameter — it belongs to the
       * card field's options and to its `submit(meta)`, per the SDK's own
       * types (`CommonOptions.savePaymentMethodFor`, `SubmitMeta`). The order
       * carries the same request server-side; the widget is what actually
       * performs the save.
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
 *
 * ⚠️ And the order alone does NOT save a card. Verified in production on
 * 2026-09-08: a hosted-checkout order that took real money (completed,
 * captured, 3-D Secure verified, full card detail on the payment) left the
 * customer's saved-method list EMPTY. The parameter that saves a card belongs
 * to the acquirer's BROWSER widget, and only to its card field — the SDK's own
 * types put `savePaymentMethodFor` on the card field's options and on its
 * `submit(meta)`, while the newer unified module exposes no card field at all
 * (`RevolutPaymentsModuleInstance` = revolutPay / paymentRequest / payByBank).
 * So an org that must be chargeable later is sent through the card field, and
 * the hosted page stays what it is good at: a one-off payment.
 *
 * Where the card data goes: the card field renders in an IFRAME the acquirer
 * hosts, so card details never enter our page or reach our servers — only the
 * per-order token does. See the PCI note in the repo CLAUDE.md.
 */
/**
 * The amount an authorisation is placed for so a card can be verified. Never
 * captured — the hold is released as soon as the method is saved.
 */
export const VERIFICATION_AMOUNT = 100;

/**
 * Where the acquirer's browser SDK is served from, production.
 *
 * Read out of the SDK package itself (@revolut/checkout 1.1.25 constants:
 * `https://merchant.revolut.com/embed.js` for prod,
 * `https://sandbox-merchant.revolut.com/embed.js` for sandbox) rather than from
 * prose, because a docs page can describe an older loader than the one npm
 * ships.
 */
export const REVOLUT_SDK_SCRIPT_URL = "https://merchant.revolut.com/embed.js";

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
      customerId: pin.customerId,
      // Without this the card is never stored for merchant-initiated use, which
      // is the entire point of setting one up.
      save_payment_method_for: "merchant",
      metadata: { org_id: params.orgId, purpose: "card-setup" },
    });
    const token = order.token;
    if (typeof token !== "string" || token.length === 0) {
      // Without it the page has nothing to mount the card field against, and a
      // descriptor that cannot work would move the failure into the customer's
      // browser where nobody of ours can read it.
      throw new Error(
        `Org ${params.orgId}: acquirer returned no order token to set a card up with`
      );
    }
    return {
      object: "card_setup",
      mode: "embedded_widget",
      script_url: REVOLUT_SDK_SCRIPT_URL,
      environment: "prod",
      token,
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
