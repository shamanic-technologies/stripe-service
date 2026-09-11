import type Stripe from "stripe";

/**
 * The Stripe billing portal is the ONE surface where a customer can DELETE a
 * saved card, and Stripe only refuses that deletion when the card backs an
 * active subscription. We bill one-off PaymentIntents, so nothing there
 * protects us: a customer sitting on a negative postpaid balance can remove
 * the only card the debt would ever be collected on, and no code of ours is on
 * the request to stop it.
 *
 * So this service never creates an unscoped portal session. Every session it
 * mints is one of exactly two shapes, and neither reaches the payment-method
 * MANAGEMENT screen where the remove control lives:
 *
 *   - CARD UPDATE  — `flow_data: { type: "payment_method_update" }`. A portal
 *     session carrying `flow_data` opens directly into that single flow and
 *     returns to `return_url` when it completes, so the customer sees the
 *     add-a-card form and nothing else. Adding a card through it makes the new
 *     card the customer's default, which is what off-session charges read.
 *
 *   - INVOICE HISTORY — a portal CONFIGURATION whose
 *     `features.payment_method_update` is disabled. With that feature off the
 *     portal renders no payment-method section at all, so invoices are listed
 *     and there is nothing to remove.
 *
 * Both configurations are created ONCE against the platform Stripe account and
 * their ids are read from the environment. They are deliberately not created on
 * the fly: a configuration minted per request is a configuration nobody can
 * audit, and the guarantee this file exists for is only as good as the
 * configuration behind it. A missing id FAILS LOUD rather than falling back to
 * the account's default configuration — the default one is exactly the full
 * portal we are protecting the customer's card from.
 */

export const CARD_UPDATE_CONFIGURATION_ENV =
  "STRIPE_PORTAL_CARD_UPDATE_CONFIGURATION_ID";
export const INVOICE_HISTORY_CONFIGURATION_ENV =
  "STRIPE_PORTAL_INVOICE_HISTORY_CONFIGURATION_ID";

function requireConfiguration(envName: string): string {
  const value = process.env[envName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${envName} is not set. A billing portal session cannot be created without it: ` +
        `without a pinned configuration Stripe serves the full portal, where the customer can ` +
        `remove the only card we collect on.`
    );
  }
  return value.trim();
}

export type PortalSessionInput = {
  customer: string;
  return_url?: string;
};

/**
 * Session that lets the customer ADD or REPLACE their card, and offers no way
 * to remove one. The new card becomes the default payment method, which is
 * what off-session charges resolve against.
 */
export function cardUpdatePortalParams(
  input: PortalSessionInput
): Stripe.BillingPortal.SessionCreateParams {
  const flowData: Stripe.BillingPortal.SessionCreateParams.FlowData = {
    type: "payment_method_update",
  };
  if (input.return_url) {
    flowData.after_completion = {
      type: "redirect",
      redirect: { return_url: input.return_url },
    };
  }
  return {
    customer: input.customer,
    ...(input.return_url ? { return_url: input.return_url } : {}),
    configuration: requireConfiguration(CARD_UPDATE_CONFIGURATION_ENV),
    flow_data: flowData,
  };
}

/**
 * Session that shows invoice history. Its configuration has payment-method
 * management disabled, so the portal renders no card section and there is
 * nothing to detach.
 */
export function invoiceHistoryPortalParams(
  input: PortalSessionInput
): Stripe.BillingPortal.SessionCreateParams {
  return {
    customer: input.customer,
    ...(input.return_url ? { return_url: input.return_url } : {}),
    configuration: requireConfiguration(INVOICE_HISTORY_CONFIGURATION_ENV),
  };
}
