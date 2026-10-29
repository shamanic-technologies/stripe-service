import type Stripe from "stripe";
import { extractString, resolveOrgId } from "./event-processor";
import { orgOfStripeFeeSource, recordStripeFeeTransaction } from "./acquiring-fees";
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
 * its account. This module records each fee as a cost on a synthetic
 * platform-run carrying the org whose payment it came from, so billing debits it
 * from that org like any other cost, at cost (costs-service prices these names
 * pass-through). A fee that belongs to no org (a failed payout, a payment of no
 * org of ours) stays on an org-less run: the platform's.
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
  /** Whose payment the fee came from, as the event states it. None = the platform's (payout). */
  payer: FeePayerHints | null;
}

/** What the event says about the payment the fee came from. */
interface FeePayerHints {
  metadataOrgId: string | null;
  customerId: string | null;
}

function payerOfCharge(charge: Stripe.Charge): FeePayerHints {
  return {
    metadataOrgId: charge.metadata?.org_id || null,
    customerId: extractString(charge.customer as never),
  };
}

const FEE_EVENT_TYPES = new Set<string>([
  "charge.succeeded",
  // A manual-capture charge (a card hold) has NO balance transaction when it
  // succeeds — only an authorisation exists. Its fee appears when it is
  // captured, so the capture is where it is declared (once per txn id).
  "charge.captured",
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
    case "charge.succeeded":
    case "charge.captured": {
      const charge = event.data.object as Stripe.Charge;
      const btId = extractString(charge.balance_transaction);
      if (!btId) return [];
      return [
        {
          taskName: event.type,
          costName: "stripe-processing-fee",
          balanceTransactionId: btId,
          payer: payerOfCharge(charge),
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
          payer: payerOfCharge(charge),
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
      const charge =
        typeof dispute.charge === "object" && dispute.charge !== null
          ? (dispute.charge as Stripe.Charge)
          : null;
      // An unexpanded charge says nothing here: the fee's own source (the
      // disputed charge) is attributed through the mirror below.
      const payer: FeePayerHints = charge
        ? payerOfCharge(charge)
        : { metadataOrgId: null, customerId: null };
      const bts = dispute.balance_transactions ?? [];
      const specs: FeeSpec[] = [];
      for (const bt of bts) {
        specs.push({
          taskName: "charge.dispute.created",
          costName: "stripe-dispute-fee",
          balanceTransactionId: bt.id,
          payer,
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
          // A payout is our own money leaving to our bank: no customer paid it.
          payer: null,
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

  // Mirror first: the per-org, per-month fee view reads it, and the org
  // fallback below attributes through it.
  await recordStripeFeeTransaction(bt);

  // The fee is BILLED to the org that paid — owner 2026-10-29 (« dans ce monde
  // sans marge tous les couts de supports sont refacturés à l'org cliente,
  // incluant l'onboarding, stripe, les chat etc »), reversing 2026-10-13.
  // runs-service counts a platform-source cost carrying an org into that org's
  // usage, which billing reads as spend: the org on the run IS the charge, at
  // cost (pass-through price). The card is charged the top-up amount, unchanged:
  // this cost is the only place the fee is billed. No org = the platform's.
  const orgId = spec.payer ? await orgOfFee(spec.payer, bt) : null;

  const idempotencyKey = `stripe:${spec.balanceTransactionId}`;

  const run = await createPlatformRun({
    taskName: spec.taskName,
    idempotencyKey,
    orgId,
  });

  try {
    await addPlatformRunCost({
      runId: run.id,
      costName: spec.costName,
      // Single platform account: our key always took the payment.
      costSource: "platform",
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
 * The org whose payment the fee came from: the event's own statement first
 * (`metadata.org_id`, then the customer's org), then the fee mirror joined to the
 * payment (the same attribution GET /internal/acquiring_fees/monthly serves).
 * Null = no org of ours: the fee stays the platform's.
 */
async function orgOfFee(
  payer: FeePayerHints,
  bt: Stripe.BalanceTransaction
): Promise<string | null> {
  const stated = await resolveOrgId(payer.metadataOrgId, payer.customerId);
  if (stated !== "unknown") return stated;
  return orgOfStripeFeeSource(extractString(bt.source as never));
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
