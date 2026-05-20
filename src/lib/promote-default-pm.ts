import type Stripe from "stripe";
import {
  upsertCustomer,
  resolveOrgId,
  extractOrgId,
  extractString,
} from "./event-processor";

/**
 * Auto-promote a customer's attached PaymentMethod to
 * `invoice_settings.default_payment_method` after a checkout completes or a
 * SetupIntent succeeds, when the customer has no default yet.
 *
 * Why: Stripe Checkout attaches the PM to the customer but does NOT set it as
 * the default. Without a default PM, billing-service `deriveHasPaymentMethod`
 * returns false (dashboard shows "No card") and off_session PaymentIntents
 * fail with `requires_payment_method`.
 *
 * Idempotent: if the customer already has a default PM, this is a no-op. If
 * Stripe later replays the event, the second pass observes the now-set default
 * and exits early.
 *
 * Errors propagate so the calling webhook returns 5xx and Stripe retries.
 */
export async function promoteDefaultPaymentMethod(
  event: Stripe.Event,
  stripe: Stripe
): Promise<void> {
  if (event.type === "checkout.session.completed") {
    await handleCheckoutSessionCompleted(
      event.data.object as Stripe.Checkout.Session,
      stripe
    );
    return;
  }

  if (event.type === "setup_intent.succeeded") {
    await handleSetupIntentSucceeded(
      event.data.object as Stripe.SetupIntent,
      stripe
    );
    return;
  }
}

async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  stripe: Stripe
): Promise<void> {
  // Subscriptions out of scope (Phase 2 per CLAUDE.md).
  if (session.mode === "subscription") return;

  const customerId = extractString(session.customer);
  if (!customerId) return;

  let paymentMethodId: string | null = null;
  if (session.mode === "payment") {
    const piId = extractString(session.payment_intent);
    if (!piId) return;
    const pi = await stripe.paymentIntents.retrieve(piId);
    paymentMethodId = extractString(pi.payment_method);
  } else if (session.mode === "setup") {
    const siId = extractString(session.setup_intent);
    if (!siId) return;
    const si = await stripe.setupIntents.retrieve(siId);
    paymentMethodId = extractString(si.payment_method);
  }

  if (!paymentMethodId) return;
  await maybePromote(stripe, customerId, paymentMethodId);
}

async function handleSetupIntentSucceeded(
  si: Stripe.SetupIntent,
  stripe: Stripe
): Promise<void> {
  const customerId = extractString(si.customer);
  if (!customerId) return;
  const paymentMethodId = extractString(si.payment_method);
  if (!paymentMethodId) return;
  await maybePromote(stripe, customerId, paymentMethodId);
}

async function maybePromote(
  stripe: Stripe,
  customerId: string,
  paymentMethodId: string
): Promise<void> {
  const customer = await stripe.customers.retrieve(customerId);
  if (isDeletedCustomer(customer)) return;
  if (customer.invoice_settings?.default_payment_method) return;

  // Precondition: the PM must be attached to this customer before Stripe
  // accepts it as `invoice_settings.default_payment_method`. Stripe Checkout
  // sessions created with `saved_payment_method_options.payment_method_save:
  // null` (the pre-2026-05-20 default) attach the PM to the PaymentIntent
  // but NOT to the customer — `customers.update` then 400s with
  // "payment method must be attached to the customer".
  //
  // Two cases short-circuit here, both fail-loud-clean (no try/catch swallow):
  //   1. PM attached to a different customer — log warn + skip; safer than
  //      forcibly re-attaching, which would steal the PM from its rightful
  //      owner.
  //   2. PM unattached — call `paymentMethods.attach` first, then set the
  //      default. Heals legacy sessions whose Checkout config omitted
  //      `payment_method_save`. Forward sessions (post-billing-service fix)
  //      arrive already attached, so the attach call short-circuits via the
  //      pm.customer === customerId branch.
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  const pmOwner = extractString(pm.customer as Stripe.PaymentMethod["customer"]);
  if (pmOwner && pmOwner !== customerId) {
    console.warn(
      `[stripe-service] PM ${paymentMethodId} is attached to ${pmOwner}, not ${customerId}; skipping default-PM promotion`
    );
    return;
  }
  if (!pmOwner) {
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
  }

  const updated = await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  const orgId = await resolveOrgId(extractOrgId(updated.metadata), customerId);
  await upsertCustomer(updated, orgId);

  console.log(
    `[stripe-service] Promoted default PM ${paymentMethodId} for customer ${customerId} (org=${orgId})`
  );
}

function isDeletedCustomer(
  c: Stripe.Customer | Stripe.DeletedCustomer
): c is Stripe.DeletedCustomer {
  return (c as Stripe.DeletedCustomer).deleted === true;
}
