/**
 * Mint the TWO billing-portal configurations this service pins, once, against
 * the platform Stripe account. Print their ids so they can be set on the box.
 *
 * Why configurations at all: the Stripe billing portal is the only place a
 * customer can DELETE a saved card, and Stripe refuses that deletion only when
 * the card backs an active subscription. We bill one-off PaymentIntents, so a
 * customer sitting on a negative postpaid balance could remove the one card the
 * debt would ever be collected on. Neither configuration below can reach the
 * payment-method management screen where that control lives:
 *
 *   card update      — payment_method_update ON, and the session pins it to the
 *                      single `payment_method_update` FLOW, which opens on the
 *                      add-a-card form and returns to the caller's return_url.
 *   invoice history  — invoice_history ON, payment_method_update OFF, so the
 *                      portal renders no card section at all.
 *
 * Idempotent by name: an existing active configuration whose metadata carries
 * the same purpose is reported rather than duplicated.
 *
 *   npx tsx scripts/create-portal-configurations.ts
 *
 * Then set on the box, in /root/distribute/env/stripe-service.env:
 *   STRIPE_PORTAL_CARD_UPDATE_CONFIGURATION_ID=bpc_...
 *   STRIPE_PORTAL_INVOICE_HISTORY_CONFIGURATION_ID=bpc_...
 */
import "dotenv/config";
import type Stripe from "stripe";
import { getPlatformStripe } from "../src/lib/event-processor";
import {
  CARD_UPDATE_CONFIGURATION_ENV,
  INVOICE_HISTORY_CONFIGURATION_ENV,
} from "../src/lib/portal-session";

const PURPOSE_KEY = "distribute_portal_purpose";

async function ensure(
  stripe: Stripe,
  purpose: "card_update" | "invoice_history",
  params: Stripe.BillingPortal.ConfigurationCreateParams
): Promise<string> {
  const existing = await stripe.billingPortal.configurations.list({
    active: true,
    limit: 100,
  });
  const found = existing.data.find(
    (c) => c.metadata?.[PURPOSE_KEY] === purpose
  );
  if (found) {
    console.log(`[stripe-service] ${purpose}: reusing ${found.id}`);
    return found.id;
  }
  const created = await stripe.billingPortal.configurations.create({
    ...params,
    metadata: { ...(params.metadata ?? {}), [PURPOSE_KEY]: purpose },
  });
  console.log(`[stripe-service] ${purpose}: created ${created.id}`);
  return created.id;
}

async function main(): Promise<void> {
  const stripe = await getPlatformStripe();

  const cardUpdate = await ensure(stripe, "card_update", {
    business_profile: {},
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: false },
      customer_update: { enabled: false },
    },
  });

  const invoiceHistory = await ensure(stripe, "invoice_history", {
    business_profile: {},
    features: {
      // OFF on purpose: with it on, the portal shows the saved cards and their
      // remove control, which is the whole thing this configuration exists to
      // keep away from a customer who owes us money.
      payment_method_update: { enabled: false },
      invoice_history: { enabled: true },
      customer_update: { enabled: false },
    },
  });

  console.log("");
  console.log(`${CARD_UPDATE_CONFIGURATION_ENV}=${cardUpdate}`);
  console.log(`${INVOICE_HISTORY_CONFIGURATION_ENV}=${invoiceHistory}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[stripe-service] portal configuration setup failed:", err);
    process.exit(1);
  }
);
