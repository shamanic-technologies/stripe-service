import type Stripe from "stripe";
import { resolveOrgId, extractString } from "./event-processor";
import { getKeySource } from "./key-client";
import {
  createPlatformRun,
  addPlatformRunCost,
  updatePlatformRunStatus,
} from "./runs-client";

/**
 * Webhook fee declaration to runs-service.
 *
 * Stripe charges processing fees (2.9% + 30¢ per charge), refund fees (30¢
 * flat retained on refund), dispute fees (~$15), and payout-failure fees on
 * its connected account. Pre-this-module those fees were invisible to billing
 * — every reload over-credited the org by the processing fee. This module
 * records each fee as a cost on a synthetic platform-run owned by the org so
 * billing-service's downstream `spent_cents` aggregate sees them.
 *
 * Idempotency: the Stripe balance-transaction id (`txn_...`) is sent as the
 * runs-service `idempotencyKey` on both the run and the cost. Stripe webhook
 * redelivery is therefore safe — runs-service returns the existing rows on
 * the second call.
 *
 * Errors propagate: webhook handler returns 500 and Stripe retries.
 */

interface FeeSpec {
  taskName: string;
  costName: string;
  balanceTransactionId: string;
  customerId: string | null;
  forcePlatformSource: boolean;
}

const FEE_EVENT_TYPES = new Set<string>([
  "charge.succeeded",
  "charge.refunded",
  "charge.dispute.created",
  "payout.failed",
]);

export function isFeeEvent(eventType: string): boolean {
  return FEE_EVENT_TYPES.has(eventType);
}

export async function declareFeesForEvent(
  event: Stripe.Event,
  stripe: Stripe
): Promise<void> {
  if (!isFeeEvent(event.type)) return;

  const specs = extractFeeSpecs(event);
  for (const spec of specs) {
    await declareSingleFee(spec, stripe);
  }
}

function extractFeeSpecs(event: Stripe.Event): FeeSpec[] {
  switch (event.type) {
    case "charge.succeeded": {
      const charge = event.data.object as Stripe.Charge;
      const btId = extractString(charge.balance_transaction);
      if (!btId) return [];
      return [
        {
          taskName: "charge.succeeded",
          costName: "stripe-processing-fee",
          balanceTransactionId: btId,
          customerId: extractString(charge.customer as never),
          forcePlatformSource: false,
        },
      ];
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const customerId = extractString(charge.customer as never);
      const refunds = charge.refunds?.data ?? [];
      const specs: FeeSpec[] = [];
      for (const refund of refunds) {
        const btId = extractString(refund.balance_transaction);
        if (!btId) continue;
        specs.push({
          taskName: "charge.refunded",
          costName: "stripe-refund-fee",
          balanceTransactionId: btId,
          customerId,
          forcePlatformSource: false,
        });
      }
      return specs;
    }
    case "charge.dispute.created": {
      // Stripe puts ≤2 BTs on a dispute: the funds-held BT (negative amount of
      // the disputed charge) and, when applicable, a separate dispute-fee BT.
      // We declare the first BT — `bt.fee === 0` filtering in
      // `declareSingleFee` skips the funds-held BT and only the actual fee
      // gets surfaced as a cost. Capture is best-effort: if Stripe folds the
      // fee into the held BT, the dispute fee won't be recorded here. Refine
      // when we have empirical BT shapes from prod.
      const dispute = event.data.object as Stripe.Dispute;
      const chargeObj =
        typeof dispute.charge === "object" && dispute.charge !== null
          ? (dispute.charge as Stripe.Charge)
          : null;
      const customerId = chargeObj
        ? extractString(chargeObj.customer as never)
        : null;
      const bts = dispute.balance_transactions ?? [];
      const specs: FeeSpec[] = [];
      for (const bt of bts) {
        specs.push({
          taskName: "charge.dispute.created",
          costName: "stripe-dispute-fee",
          balanceTransactionId: bt.id,
          customerId,
          forcePlatformSource: false,
        });
      }
      return specs;
    }
    case "payout.failed": {
      const payout = event.data.object as Stripe.Payout;
      const btId = extractString(payout.balance_transaction);
      if (!btId) return [];
      return [
        {
          taskName: "payout.failed",
          costName: "stripe-payout-failure-fee",
          balanceTransactionId: btId,
          customerId: null,
          forcePlatformSource: true,
        },
      ];
    }
    default:
      return [];
  }
}

async function declareSingleFee(spec: FeeSpec, stripe: Stripe): Promise<void> {
  const bt = await stripe.balanceTransactions.retrieve(spec.balanceTransactionId);
  if (bt.fee === 0) return;

  const orgForHeader = await resolveOrgForFee(spec.customerId);
  const costSource: "platform" | "org" =
    spec.forcePlatformSource || !orgForHeader
      ? "platform"
      : (await getKeySource(orgForHeader, "stripe")).keySource;

  const idempotencyKey = `stripe:${spec.balanceTransactionId}`;

  const run = await createPlatformRun({
    taskName: spec.taskName,
    idempotencyKey,
    orgId: orgForHeader,
  });

  try {
    await addPlatformRunCost({
      runId: run.id,
      costName: spec.costName,
      costSource,
      quantity: bt.fee,
      idempotencyKey,
    });
    await updatePlatformRunStatus({ runId: run.id, status: "completed" });
  } catch (err) {
    try {
      await updatePlatformRunStatus({ runId: run.id, status: "failed" });
    } catch (patchErr) {
      console.warn(
        `[stripe-service] Failed to PATCH run ${run.id} to failed status:`,
        patchErr
      );
    }
    throw err;
  }
}

async function resolveOrgForFee(
  customerId: string | null
): Promise<string | null> {
  if (!customerId) return null;
  const orgId = await resolveOrgId(null, customerId);
  return orgId === "unknown" ? null : orgId;
}
