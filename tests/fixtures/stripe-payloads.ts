import type Stripe from "stripe";

export function makePaymentIntentSucceeded(
  overrides: Partial<Stripe.PaymentIntent> = {}
): Stripe.PaymentIntent {
  return {
    id: "pi_test_succeeded",
    object: "payment_intent",
    amount: 2000,
    currency: "usd",
    status: "succeeded",
    latest_charge: "ch_test_123",
    last_payment_error: null,
    metadata: {},
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    ...overrides,
  } as Stripe.PaymentIntent;
}

export function makePaymentIntentFailed(
  overrides: Partial<Stripe.PaymentIntent> = {}
): Stripe.PaymentIntent {
  return {
    id: "pi_test_failed",
    object: "payment_intent",
    amount: 2000,
    currency: "usd",
    status: "requires_payment_method",
    latest_charge: null,
    last_payment_error: {
      code: "card_declined",
      message: "Your card was declined.",
      type: "card_error",
    } as any,
    metadata: {},
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    ...overrides,
  } as Stripe.PaymentIntent;
}

export function makeChargeRefunded(
  overrides: Partial<Stripe.Charge> = {}
): Stripe.Charge {
  return {
    id: "ch_test_refunded",
    object: "charge",
    amount: 2000,
    currency: "usd",
    payment_intent: "pi_test_refunded",
    refunded: true,
    refunds: {
      object: "list",
      data: [
        {
          id: "re_test_123",
          object: "refund",
          amount: 2000,
          currency: "usd",
          reason: "requested_by_customer",
          status: "succeeded",
        } as any,
      ],
      has_more: false,
      url: "/v1/charges/ch_test_refunded/refunds",
    },
    ...overrides,
  } as Stripe.Charge;
}

export function makeDisputeCreated(
  overrides: Partial<Stripe.Dispute> = {}
): Stripe.Dispute {
  return {
    id: "dp_test_123",
    object: "dispute",
    amount: 2000,
    currency: "usd",
    charge: "ch_test_disputed",
    payment_intent: "pi_test_disputed",
    reason: "fraudulent",
    status: "needs_response",
    ...overrides,
  } as Stripe.Dispute;
}

export function makeCheckoutSessionCompleted(
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return {
    id: "cs_test_123",
    object: "checkout.session",
    amount_total: 5000,
    currency: "usd",
    payment_intent: "pi_test_checkout",
    customer: "cus_test_123",
    payment_status: "paid",
    status: "complete",
    mode: "payment",
    ...overrides,
  } as Stripe.Checkout.Session;
}
