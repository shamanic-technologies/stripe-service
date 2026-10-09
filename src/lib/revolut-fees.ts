import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db";
import { revolutOrders } from "../db/schema";
import {
  addPlatformRunCost,
  createPlatformRun,
  updatePlatformRunStatus,
} from "./runs-client";

/**
 * The Revolut acquiring fee is CHARGED to the org, exactly like the Stripe fee.
 *
 * Owner 2026-10-09: "make the charge on them, as we say in our pricing
 * catalogue… Stripe fee or Revolut fees, same". costs-service prices this name
 * pass-through (1 USD cent per cent of fee), and runs-service counts a
 * platform-source cost carrying an org into that org's usage, which billing
 * reads as spend — so the org on the run IS the charge.
 *
 * ## Why a sweep, not a webhook side-effect
 *
 * Revolut sends `ORDER_*` events only, and an order is mirrored many times over
 * (webhook, poll, back-fill, re-reads). The fee is declared once per payment,
 * remembered in `revolut_orders.fee_declared_at`, by a sweep the 5-minute
 * Revolut poller runs over completed payments carrying a fee and an org. The
 * runs-service idempotency key (`revolut:<order id>`) makes a crash between
 * the declaration and the stamp safe: the retry returns the existing rows.
 *
 * Fees are USD on this account (all observed fees are `acquiring`, USD). A fee
 * in another currency is NOT converted and NOT dropped: it throws, so it is
 * loud in the log and stays undeclared until someone decides what it costs.
 */
export const REVOLUT_FEE_COST_NAME = "revolut-acquiring-fee";

const BATCH = 100;

export async function declarePendingRevolutFees(): Promise<number> {
  const rows = await db
    .select({
      id: revolutOrders.id,
      orgId: revolutOrders.orgId,
      feeAmount: revolutOrders.feeAmount,
      rawJson: revolutOrders.rawJson,
    })
    .from(revolutOrders)
    .where(
      and(
        eq(revolutOrders.type, "payment"),
        eq(revolutOrders.state, "completed"),
        isNotNull(revolutOrders.orgId),
        gt(revolutOrders.feeAmount, 0),
        isNull(revolutOrders.feeDeclaredAt)
      )
    )
    .orderBy(asc(revolutOrders.createdAtRevolut))
    .limit(BATCH);

  let declared = 0;
  for (const row of rows) {
    // One bad row must not hold every other org's fee hostage: it is logged
    // loud, stays undeclared, and is retried on the next sweep.
    try {
      assertUsdFees(row.id, row.rawJson);
      await declareOne(row.id, row.orgId as string, row.feeAmount as number);
      await db
        .update(revolutOrders)
        .set({ feeDeclaredAt: new Date() })
        .where(eq(revolutOrders.id, row.id));
      declared += 1;
    } catch (err) {
      console.error(
        `[stripe-service] Declaring the Revolut fee for order ${row.id} (org ${row.orgId}) failed; retried next sweep:`,
        err
      );
    }
  }
  return declared;
}

async function declareOne(
  orderId: string,
  orgId: string,
  feeCents: number
): Promise<void> {
  const idempotencyKey = `revolut:${orderId}`;
  const run = await createPlatformRun({
    taskName: "revolut.payment.completed",
    idempotencyKey,
    orgId,
  });
  try {
    await addPlatformRunCost({
      runId: run.id,
      costName: REVOLUT_FEE_COST_NAME,
      // Single merchant account: the platform key always took the payment.
      costSource: "platform",
      quantity: feeCents,
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

function assertUsdFees(orderId: string, rawJson: unknown): void {
  const payments =
    (rawJson as { payments?: Array<{ fees?: Array<{ currency?: string }> }> })
      ?.payments ?? [];
  for (const payment of payments) {
    for (const fee of payment.fees ?? []) {
      if (fee.currency && fee.currency.toUpperCase() !== "USD") {
        throw new Error(
          `Revolut order ${orderId} carries a ${fee.currency} fee; only USD fees are priced, so it is left undeclared`
        );
      }
    }
  }
}
