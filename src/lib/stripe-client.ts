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

export function constructWebhookEvent(
  payload: string | Buffer,
  signature: string,
  secret: string
): Stripe.Event {
  const stripe = getClient();
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

// ===== Products =====

export async function createProduct(params: {
  name: string;
  description?: string;
  metadata?: Record<string, string>;
  active?: boolean;
}): Promise<Stripe.Product> {
  const stripe = getClient();
  return stripe.products.create(params);
}

export async function listProducts(params?: {
  active?: boolean;
  limit?: number;
}): Promise<Stripe.ApiList<Stripe.Product>> {
  const stripe = getClient();
  return stripe.products.list(params);
}

export async function getProduct(id: string): Promise<Stripe.Product> {
  const stripe = getClient();
  return stripe.products.retrieve(id);
}

export async function updateProduct(
  id: string,
  params: { name?: string; description?: string; active?: boolean; metadata?: Record<string, string> }
): Promise<Stripe.Product> {
  const stripe = getClient();
  return stripe.products.update(id, params);
}

// ===== Prices =====

export async function createPrice(params: {
  product: string;
  unitAmountInCents: number;
  currency?: string;
  recurring?: { interval: "day" | "week" | "month" | "year"; intervalCount?: number };
  metadata?: Record<string, string>;
}): Promise<Stripe.Price> {
  const stripe = getClient();
  return stripe.prices.create({
    product: params.product,
    unit_amount: params.unitAmountInCents,
    currency: params.currency || "usd",
    recurring: params.recurring
      ? { interval: params.recurring.interval, interval_count: params.recurring.intervalCount }
      : undefined,
    metadata: params.metadata,
  });
}

export async function listPrices(params?: {
  product?: string;
  active?: boolean;
  limit?: number;
}): Promise<Stripe.ApiList<Stripe.Price>> {
  const stripe = getClient();
  return stripe.prices.list(params);
}

export async function getPrice(id: string): Promise<Stripe.Price> {
  const stripe = getClient();
  return stripe.prices.retrieve(id);
}

// ===== Coupons =====

export async function createCoupon(params: {
  percentOff?: number;
  amountOffInCents?: number;
  currency?: string;
  duration: "once" | "repeating" | "forever";
  durationInMonths?: number;
  name?: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.Coupon> {
  const stripe = getClient();
  return stripe.coupons.create({
    percent_off: params.percentOff,
    amount_off: params.amountOffInCents,
    currency: params.amountOffInCents ? (params.currency || "usd") : undefined,
    duration: params.duration,
    duration_in_months: params.durationInMonths,
    name: params.name,
    metadata: params.metadata,
  });
}

export async function listCoupons(params?: {
  limit?: number;
}): Promise<Stripe.ApiList<Stripe.Coupon>> {
  const stripe = getClient();
  return stripe.coupons.list(params);
}

export async function getCoupon(id: string): Promise<Stripe.Coupon> {
  const stripe = getClient();
  return stripe.coupons.retrieve(id);
}

export async function deleteCoupon(id: string): Promise<Stripe.DeletedCoupon> {
  const stripe = getClient();
  return stripe.coupons.del(id);
}

// ===== Customers =====

export async function createCustomer(params: {
  email?: string;
  name?: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.Customer> {
  const stripe = getClient();
  return stripe.customers.create(params);
}

export async function listCustomers(params?: {
  email?: string;
  limit?: number;
}): Promise<Stripe.ApiList<Stripe.Customer>> {
  const stripe = getClient();
  return stripe.customers.list(params);
}

export async function getCustomer(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
  const stripe = getClient();
  return stripe.customers.retrieve(id);
}

export async function updateCustomer(
  id: string,
  params: { email?: string; name?: string; metadata?: Record<string, string> }
): Promise<Stripe.Customer> {
  const stripe = getClient();
  return stripe.customers.update(id, params);
}
