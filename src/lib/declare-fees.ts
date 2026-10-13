import type Stripe from "stripe";
import { extractString } from "./event-processor";
import { recordStripeFeeTransaction } from "./acquiring-fees";
import { stripeFeeUsdCents } from "./fee-usd";
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
 * its account. This module records each fee as a PLATFORM cost on an org-less
 * synthetic platform-run, so it is measured and charged to no customer.
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
        },
      ];
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const refunds = charge.refunds?.data ?? [];
      const specs: FeeSpec[] = [];
      for (const refund of refunds) {
        const btId = extractString(refund.balance_transaction);
        if (!btId) continue;
        specs.push({
          taskName: "charge.refunded",
          costName: "stripe-refund-fee",
          balanceTransactionId: btId,
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
      const bts = dispute.balance_transactions ?? [];
      const specs: FeeSpec[] = [];
      for (const bt of bts) {
        specs.push({
          taskName: "charge.dispute.created",
          costName: "stripe-dispute-fee",
          balanceTransactionId: bt.id,
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

  // Mirror first: the per-org, per-month view of what we absorb reads it.
  await recordStripeFeeTransaction(bt);

  // The fee is the PLATFORM's cost, charged to NOBODY — owner 2026-10-13 ("arrêter
  // de prélever plus à un user que ce qu'il définit par campagne… prendre sur
  // nous: Stripe fees"). runs-service counts every platform-source cost that
  // carries an org into that org's usage, which billing reads as SPEND, so the
  // run carries NO org: the fee is recorded in platform cost reporting and in no
  // customer's balance. Per-org attribution lives in `stripe_fee_transactions`
  // (GET /internal/acquiring_fees/monthly), never on the charge.
  const costSource = "platform" as const;

  const idempotencyKey = `stripe:${spec.balanceTransactionId}`;

  const run = await createPlatformRun({
    taskName: spec.taskName,
    idempotencyKey,
    orgId: null,
  });

  try {
    await addPlatformRunCost({
      runId: run.id,
      costName: spec.costName,
      costSource,
      quantity: feeInUsdCents(bt),
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

/**
 * The fee in USD cents, which is the unit every `stripe-*-fee` cost name is
 * priced in. Stripe states a balance transaction in the account's SETTLEMENT
 * currency: this account settled in EUR until 2026-08-13, so those fees are EUR
 * cents, and declaring them as-is recorded EUR as USD (~15% low). Converted with
 * Stripe's own `exchange_rate` on the transaction (USD → settlement currency);
 * a non-USD fee with no rate is thrown, never declared at a guessed value.
 */
export function feeInUsdCents(bt: Stripe.BalanceTransaction): number {
  const usd = stripeFeeUsdCents(bt.fee, bt.currency, bt.exchange_rate);
  if (usd === null) {
    throw new Error(
      `Stripe balance transaction ${bt.id} states its fee in ${bt.currency} with no exchange_rate; refusing to declare it as USD`
    );
  }
  return usd;
}
