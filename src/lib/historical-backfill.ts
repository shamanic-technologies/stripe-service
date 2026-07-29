import { resolvePlatformKey } from "./key-client";
import { makeStripeClient } from "./stripe-client";
import {
  recordApiSnapshot,
  extractOrgId,
  extractString,
  resolveOrgId,
} from "./event-processor";

/**
 * Boot-time back-fill of every locally mirrored Stripe object.
 *
 * Stripe events have a 30-day retention, so the event poller cannot recover
 * older history. This function uses the object-list APIs (no time bound) to
 * rebuild every row in `customers`, `payment_intents`, `checkout_sessions`,
 * `refunds`, and `disputes` from Stripe truth.
 *
 * Refunds and disputes are reconciled last, after the PaymentIntents they
 * attribute through are mirrored. They are org-less rows, so they need no
 * org resolution of their own.
 *
 * All upserts use `ON CONFLICT DO UPDATE` so re-runs are idempotent and
 * refresh stale `raw_json` / status. Runs on every boot — no gate. Called
 * fire-and-forget AFTER `app.listen()`: its size scales with Stripe
 * pagination, so it must never sit on the boot path.
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
    await recordApiSnapshot(cust, "customer", extractOrgId(cust.metadata) ?? "unknown");
    custCount += 1;
  }

  let piCount = 0;
  for await (const pi of stripe.paymentIntents.list({ limit: 100 })) {
    const orgId = await resolveOrgId(
      extractOrgId(pi.metadata),
      extractString(pi.customer)
    );
    await recordApiSnapshot(pi, "payment_intent", orgId);
    piCount += 1;
  }

  let csCount = 0;
  for await (const cs of stripe.checkout.sessions.list({ limit: 100 })) {
    const orgId = await resolveOrgId(
      extractOrgId(cs.metadata),
      extractString(cs.customer)
    );
    await recordApiSnapshot(cs, "checkout_session", orgId);
    csCount += 1;
  }

  // Money-returned mirrors. Reconciled from the object-list APIs so refunds and
  // disputes that predate this code — or whose webhook was never delivered —
  // are picked up without waiting for a new Stripe event to fire.
  let refundCount = 0;
  for await (const refund of stripe.refunds.list({ limit: 100 })) {
    await recordApiSnapshot(refund, "refund", null);
    refundCount += 1;
  }

  let disputeCount = 0;
  for await (const dispute of stripe.disputes.list({ limit: 100 })) {
    await recordApiSnapshot(dispute, "dispute", null);
    disputeCount += 1;
  }

  console.log(
    `[stripe-service] Historical back-fill complete: customers=${custCount}, pi=${piCount}, cs=${csCount}, refunds=${refundCount}, disputes=${disputeCount}`
  );
}
