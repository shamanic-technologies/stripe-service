import { resolvePlatformKey } from "./key-client";
import { makeStripeClient } from "./stripe-client";
import {
  upsertCustomer,
  upsertCheckoutSession,
  upsertPaymentIntent,
  extractOrgId,
  extractString,
  resolveOrgId,
} from "./event-processor";

/**
 * Boot-time back-fill of every locally mirrored Stripe object.
 *
 * Stripe events have a 30-day retention, so the event poller cannot recover
 * older history. This function uses the object-list APIs (no time bound) to
 * rebuild every row in `customers`, `payment_intents`, and
 * `checkout_sessions` from Stripe truth.
 *
 * All upserts use `ON CONFLICT DO UPDATE` so re-runs are idempotent and
 * refresh stale `raw_json` / status. Runs on every boot — no gate.
 */
export async function backfillHistorical(): Promise<void> {
  const { key } = await resolvePlatformKey("stripe", {
    method: "POST",
    path: "/internal/backfill",
  });
  const stripe = makeStripeClient(key);

  console.log("[stripe-service] Historical back-fill starting");

  let custCount = 0;
  for await (const cust of stripe.customers.list({ limit: 100 })) {
    await upsertCustomer(cust, extractOrgId(cust.metadata) ?? "unknown");
    custCount += 1;
  }

  let piCount = 0;
  for await (const pi of stripe.paymentIntents.list({ limit: 100 })) {
    const orgId = await resolveOrgId(
      extractOrgId(pi.metadata),
      extractString(pi.customer)
    );
    await upsertPaymentIntent(pi, orgId);
    piCount += 1;
  }

  let csCount = 0;
  for await (const cs of stripe.checkout.sessions.list({ limit: 100 })) {
    const orgId = await resolveOrgId(
      extractOrgId(cs.metadata),
      extractString(cs.customer)
    );
    await upsertCheckoutSession(cs, orgId);
    csCount += 1;
  }

  console.log(
    `[stripe-service] Historical back-fill complete: customers=${custCount}, pi=${piCount}, cs=${csCount}`
  );
}
