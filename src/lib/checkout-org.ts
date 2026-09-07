import type Stripe from "stripe";
import { VERIFICATION_AMOUNT } from "./card-setup";
import { getPlatformStripe } from "./event-processor";
import { createOrder } from "./revolut-client";
import { mirrorOrderById } from "./revolut-processor";

/**
 * The hosted checkout an org's customer is sent to, on an acquirer that is not
 * Stripe.
 *
 * Deliberately NOT a Stripe Checkout Session. The shape differs because the
 * capability differs, which is the same rule the neutral charge already follows
 * here — a consumer that needs something Stripe-specific can see it is absent
 * rather than being handed a fabrication of it. What every acquirer CAN answer
 * is: send the buyer here, this is what they will be asked for, this is what
 * the thing is called afterwards.
 *
 * `url` is the field a caller redirecting a browser actually reads, and it is
 * named the same as Stripe's, so a consumer that only redirects keeps working
 * without learning an acquirer exists.
 */
export interface NeutralCheckout {
  object: "checkout";
  /** Diagnostic only. A consumer must not branch on it. */
  acquirer: "revolut";
  id: string;
  /** Where to send the buyer. */
  url: string;
  mode: "payment" | "setup";
  /**
   * What the buyer is asked for, minor units. For `setup` this is the
   * authorisation placed to store the card — never captured, released
   * automatically once the card is saved.
   */
  amount: number;
  currency: string;
  /** The acquirer's own state for the order, at creation. */
  status: string | null;
}

/** A checkout this acquirer cannot perform. Always fails loud, never degrades. */
export class UnsupportedCheckout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedCheckout";
  }
}

interface LineItemLike {
  price?: string;
  price_data?: {
    currency?: string;
    unit_amount?: number;
    product_data?: { name?: string };
  };
  quantity?: number;
}

/**
 * What the buyer is being charged, read off the Stripe-shaped line items the
 * caller already sends.
 *
 * A line item that names a Stripe `price` id instead of inline `price_data`
 * cannot be resolved on another acquirer, and guessing an amount is the one
 * mistake that costs real money. So it throws.
 */
export function amountFromLineItems(items: LineItemLike[]): {
  amount: number;
  currency: string;
  description: string;
} {
  if (items.length === 0) {
    throw new UnsupportedCheckout("A payment checkout needs at least one line item");
  }
  let amount = 0;
  let currency: string | undefined;
  let description: string | undefined;
  for (const item of items) {
    const data = item.price_data;
    if (!data || typeof data.unit_amount !== "number" || !data.currency) {
      throw new UnsupportedCheckout(
        "This org's acquirer needs inline price_data (currency + unit_amount) on every line item; a Stripe price id cannot be resolved there"
      );
    }
    if (currency && currency !== data.currency) {
      throw new UnsupportedCheckout("Every line item must share one currency");
    }
    currency = data.currency;
    description ??= data.product_data?.name;
    amount += data.unit_amount * (item.quantity ?? 1);
  }
  return {
    amount,
    currency: (currency as string).toUpperCase(),
    description: description ?? "Payment",
  };
}

/**
 * What a Stripe coupon takes off this amount, in minor units.
 *
 * A discount reaches us as a Stripe coupon id, because that is what the caller
 * has and it must not have to learn otherwise. Another acquirer has no such
 * object, so the coupon is RESOLVED (platform key, the same single-account
 * model everything internal here uses) and its value comes off the amount the
 * buyer is asked for — with the saving named in the order description, so the
 * buyer SEES it rather than merely being charged less.
 *
 * Fails loud on a coupon we cannot resolve, on a currency mismatch, and on a
 * discount that would swallow the whole payment: an order for nothing cannot be
 * paid on this acquirer, so silently charging zero would strand the buyer on a
 * page that never completes.
 */
export async function resolveDiscountAmount(params: {
  discounts: Array<Record<string, unknown>>;
  amount: number;
  currency: string;
}): Promise<number> {
  let total = 0;
  const stripe = await getPlatformStripe();
  for (const discount of params.discounts) {
    const couponId = discount.coupon;
    if (typeof couponId !== "string") {
      throw new UnsupportedCheckout(
        "A discount must name a coupon; this org's acquirer cannot apply a promotion code entered at checkout"
      );
    }
    const coupon = await stripe.coupons.retrieve(couponId);
    if (typeof coupon.amount_off === "number") {
      if ((coupon.currency ?? "").toUpperCase() !== params.currency) {
        throw new UnsupportedCheckout(
          `Coupon ${couponId} is in ${coupon.currency} but the checkout is in ${params.currency}`
        );
      }
      total += coupon.amount_off;
    } else if (typeof coupon.percent_off === "number") {
      total += Math.round((params.amount * coupon.percent_off) / 100);
    } else {
      throw new UnsupportedCheckout(`Coupon ${couponId} has neither amount_off nor percent_off`);
    }
  }
  if (total >= params.amount) {
    throw new UnsupportedCheckout(
      "The discount covers the whole payment; this org's acquirer cannot take an order for nothing"
    );
  }
  return total;
}

function money(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

/**
 * Create the hosted checkout for an org on Revolut.
 *
 * Two modes, and the difference between them is not cosmetic:
 *
 * - `payment` takes real money. The order is stamped with `metadata.org_id`,
 *   which is what makes it the org's payment everywhere the mirror is read — the
 *   per-org payment summary and history already span both acquirers, so the
 *   credit lands through the path that was already there. No balance
 *   arithmetic changes.
 *
 * - `setup` stores a card without selling anything. Revolut cannot do that for
 *   free: a zero-amount order is accepted at create and can then never be paid.
 *   So it AUTHORISES a small amount with `capture_mode: "manual"` and tags the
 *   order `purpose: "card-setup"` — the poller releases the hold ten minutes
 *   later (never sooner: cancelling it while the buyer is still on the page
 *   cancels the order out from under them), and the payment history already
 *   filters those out so nobody sees our own artifact listed as a purchase.
 *
 * Both save the card for merchant-initiated use, which is what auto-topup needs.
 */
export async function checkoutViaRevolut(params: {
  orgId: string;
  customerId: string;
  body: Stripe.Checkout.SessionCreateParams;
}): Promise<NeutralCheckout> {
  const { body } = params;
  if (body.mode === "subscription") {
    throw new UnsupportedCheckout(
      "This org's acquirer has no subscription object; charge it per top-up instead"
    );
  }
  const isSetup = body.mode === "setup";

  let amount: number;
  let currency: string;
  let description: string;
  if (isSetup) {
    amount = VERIFICATION_AMOUNT;
    currency = (body.currency ?? "usd").toUpperCase();
    description = "Card verification (released immediately, not charged)";
  } else {
    const parsed = amountFromLineItems((body.line_items ?? []) as LineItemLike[]);
    amount = parsed.amount;
    currency = parsed.currency;
    description = parsed.description;
    if (body.discounts && body.discounts.length > 0) {
      const off = await resolveDiscountAmount({
        discounts: body.discounts as unknown as Array<Record<string, unknown>>,
        amount,
        currency,
      });
      amount -= off;
      description = `${description} (${money(off, currency)} off)`;
    }
  }

  const order = await createOrder({
    amount,
    currency,
    description,
    customerId: params.customerId,
    capture_mode: isSetup ? "manual" : "automatic",
    // Store the card for charging later with nobody on the page. This is what
    // auto-topup runs on, and it is the reason the customer is attached above:
    // a card is saved against a customer, so an order without one has nowhere
    // to put it.
    save_payment_method_for: "merchant",
    ...(body.success_url ? { redirect_url: body.success_url } : {}),
    metadata: {
      ...((body.metadata as Record<string, string> | undefined) ?? {}),
      org_id: params.orgId,
      ...(isSetup ? { purpose: "card-setup" } : {}),
    },
  });

  if (!order.checkout_url) {
    throw new Error(
      `Revolut created order ${order.id} without a checkout_url; there is nowhere to send the buyer`
    );
  }

  // Mirror immediately so the order is readable the moment it exists, rather
  // than only once a webhook or the 5-minute poll arrives. Best effort: the
  // buyer's checkout URL must not be lost over a mirror that both the webhook
  // and the poller will redo anyway.
  await mirrorOrderById(order.id, "api").catch((err) =>
    console.error(`[stripe-service] Revolut checkout mirror failed for ${order.id}:`, err)
  );

  return {
    object: "checkout",
    acquirer: "revolut",
    id: order.id,
    url: order.checkout_url,
    mode: isSetup ? "setup" : "payment",
    amount,
    currency,
    status: order.state ?? null,
  };
}
