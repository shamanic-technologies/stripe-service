import Stripe from "stripe";

let stripeClient: Stripe | null = null;

function getClient(): Stripe {
  if (!stripeClient) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY not configured");
    }
    stripeClient = new Stripe(secretKey);
  }
  return stripeClient;
}

// --- Types ---

export interface CreateCheckoutSessionParams {
  lineItems: { priceId: string; quantity: number }[];
  successUrl: string;
  cancelUrl: string;
  customerId?: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
  mode?: "payment" | "subscription";
  discounts?: Array<{ coupon?: string; promotionCode?: string }>;
}

export interface CreateCheckoutSessionResult {
  success: boolean;
  sessionId?: string;
  url?: string;
  error?: string;
}

export interface CreatePaymentIntentParams {
  amountInCents: number;
  currency?: string;
  customerId?: string;
  description?: string;
  metadata?: Record<string, string>;
  automaticPaymentMethods?: boolean;
}

export interface CreatePaymentIntentResult {
  success: boolean;
  paymentIntentId?: string;
  clientSecret?: string;
  status?: string;
  error?: string;
}

// --- Public API ---

export async function createCheckoutSession(
  params: CreateCheckoutSessionParams
): Promise<CreateCheckoutSessionResult> {
  const stripe = getClient();

  try {
    const session = await stripe.checkout.sessions.create({
      line_items: params.lineItems.map((item) => ({
        price: item.priceId,
        quantity: item.quantity,
      })),
      mode: params.mode || "payment",
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      customer: params.customerId,
      customer_email: params.customerId ? undefined : params.customerEmail,
      metadata: params.metadata,
      discounts: params.discounts?.map((d) => ({
        coupon: d.coupon,
        promotion_code: d.promotionCode,
      })),
    });

    return {
      success: true,
      sessionId: session.id,
      url: session.url ?? undefined,
    };
  } catch (error: any) {
    console.error("Stripe checkout session error:", error);
    return {
      success: false,
      error: error.message || "Unknown error",
    };
  }
}

export async function createPaymentIntent(
  params: CreatePaymentIntentParams
): Promise<CreatePaymentIntentResult> {
  const stripe = getClient();

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: params.amountInCents,
      currency: params.currency || "usd",
      customer: params.customerId,
      description: params.description,
      metadata: params.metadata || {},
      automatic_payment_methods: params.automaticPaymentMethods !== false
        ? { enabled: true }
        : undefined,
    });

    return {
      success: true,
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret ?? undefined,
      status: paymentIntent.status,
    };
  } catch (error: any) {
    console.error("Stripe payment intent error:", error);
    return {
      success: false,
      error: error.message || "Unknown error",
    };
  }
}

// --- Types for Products/Prices ---

export interface CreateProductParams {
  name: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface CreateProductResult {
  success: boolean;
  productId?: string;
  name?: string;
  error?: string;
}

export interface CreatePriceParams {
  productId: string;
  unitAmountInCents: number;
  currency?: string;
  recurring?: {
    interval: "day" | "week" | "month" | "year";
    intervalCount?: number;
  };
  metadata?: Record<string, string>;
}

export interface CreatePriceResult {
  success: boolean;
  priceId?: string;
  productId?: string;
  unitAmountInCents?: number;
  currency?: string;
  error?: string;
}

// --- Public API (Products/Prices) ---

export async function createProduct(
  params: CreateProductParams
): Promise<CreateProductResult> {
  const stripe = getClient();

  try {
    const product = await stripe.products.create({
      name: params.name,
      description: params.description,
      metadata: params.metadata || {},
    });

    return {
      success: true,
      productId: product.id,
      name: product.name,
    };
  } catch (error: any) {
    console.error("Stripe create product error:", error);
    return {
      success: false,
      error: error.message || "Unknown error",
    };
  }
}

export async function createPrice(
  params: CreatePriceParams
): Promise<CreatePriceResult> {
  const stripe = getClient();

  try {
    const price = await stripe.prices.create({
      product: params.productId,
      unit_amount: params.unitAmountInCents,
      currency: params.currency || "usd",
      recurring: params.recurring
        ? {
            interval: params.recurring.interval,
            interval_count: params.recurring.intervalCount || 1,
          }
        : undefined,
      metadata: params.metadata || {},
    });

    return {
      success: true,
      priceId: price.id,
      productId:
        typeof price.product === "string"
          ? price.product
          : price.product.id,
      unitAmountInCents: price.unit_amount ?? undefined,
      currency: price.currency,
    };
  } catch (error: any) {
    console.error("Stripe create price error:", error);
    return {
      success: false,
      error: error.message || "Unknown error",
    };
  }
}

// --- Types for Coupons ---

export interface CreateCouponParams {
  name?: string;
  percentOff?: number;
  amountOffInCents?: number;
  currency?: string;
  duration?: "once" | "repeating" | "forever";
  durationInMonths?: number;
  maxRedemptions?: number;
  redeemBy?: number;
  metadata?: Record<string, string>;
}

export interface CreateCouponResult {
  success: boolean;
  couponId?: string;
  name?: string;
  percentOff?: number | null;
  amountOffInCents?: number | null;
  currency?: string | null;
  duration?: string;
  error?: string;
}

// --- Public API (Coupons) ---

export async function createCoupon(
  params: CreateCouponParams
): Promise<CreateCouponResult> {
  const stripe = getClient();

  try {
    const coupon = await stripe.coupons.create({
      name: params.name,
      percent_off: params.percentOff,
      amount_off: params.amountOffInCents,
      currency: params.currency,
      duration: params.duration || "once",
      duration_in_months: params.durationInMonths,
      max_redemptions: params.maxRedemptions,
      redeem_by: params.redeemBy,
      metadata: params.metadata || {},
    });

    return {
      success: true,
      couponId: coupon.id,
      name: coupon.name ?? undefined,
      percentOff: coupon.percent_off,
      amountOffInCents: coupon.amount_off,
      currency: coupon.currency,
      duration: coupon.duration,
    };
  } catch (error: any) {
    console.error("Stripe create coupon error:", error);
    return {
      success: false,
      error: error.message || "Unknown error",
    };
  }
}

export function constructWebhookEvent(
  payload: string | Buffer,
  signature: string,
  secret: string
): Stripe.Event {
  const stripe = getClient();
  return stripe.webhooks.constructEvent(payload, signature, secret);
}
