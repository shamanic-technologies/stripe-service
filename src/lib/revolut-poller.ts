import { listOrders, listDisputes, getOrder } from "./revolut-client";
import { recordRevolutObject } from "./revolut-processor";

/**
 * Periodic reconciliation against Revolut, the backstop for anything the
 * webhook never delivered.
 *
 * The Stripe side polls an EVENT feed since a cursor. Revolut has no such feed,
 * so this walks the ORDER collection newest-first and stops at the first page
 * older than the window. That is enough because `GET /orders` returns payments
 * AND refunds in one collection — a refund is an order of `type: "refund"` — so
 * one walk reconciles both halves of the money-returned mirror. There is no
 * separate refunds endpoint to forget.
 *
 * ⚠️ **The list is DISCOVERY ONLY.** `GET /orders` returns a SUMMARY that omits
 * `payments` and `refunded_amount` — the fee, the settled amount, and how much
 * came back. So every id it yields is fetched individually and the DETAIL is
 * what gets mirrored. Storing the summary would let a poll overwrite a full
 * snapshot with a hollow one and blank real money fields.
 *
 * Re-mirroring an unchanged order is free: bronze is keyed on a hash of the
 * payload, so an identical re-read collapses onto the row already stored.
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
// Deliberately far wider than the interval. A poll that only looked back five
// minutes would lose anything that happened during a deploy or a brief outage,
// and re-reading a day of orders on an account with this volume costs nothing.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function pollRevolutOnce(nowMs: number = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - LOOKBACK_MS);
  let createdBefore: string | undefined;
  let mirrored = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const list = await listOrders({ limit: PAGE_LIMIT, createdBefore });
    const orders = list.orders ?? [];
    if (orders.length === 0) break;

    let oldest: string | undefined;
    for (const summary of orders) {
      if (!summary?.id) continue;
      const detail = await getOrder(summary.id);
      await recordRevolutObject("order", detail, "poll");
      mirrored += 1;
      if (summary.created_at) oldest = summary.created_at;
    }

    if (!oldest || new Date(oldest) < cutoff) break;
    if (orders.length < PAGE_LIMIT) break;
    createdBefore = oldest;
  }

  // Disputes are captured verbatim into bronze. No silver projection until a
  // real dispute payload has been observed — see the schema comment.
  try {
    const disputes = await listDisputes();
    for (const dispute of Array.isArray(disputes) ? disputes : []) {
      const d = dispute as { id?: string; updated_at?: string };
      if (typeof d?.id === "string") {
        await recordRevolutObject("dispute", d as { id: string }, "poll");
        mirrored += 1;
      }
    }
  } catch (err) {
    // A dispute-list failure must not cost us the order walk that already
    // succeeded — the two are independent reconciliations.
    console.error("[stripe-service] Revolut dispute poll failed:", err);
  }

  return mirrored;
}

/**
 * One-time full walk of the order history at boot, fire-and-forget.
 *
 * The poller's 24-hour window is a reconciliation, not a back-fill: it can
 * never reach an order older than that, and Revolut has no event feed to replay
 * from. So a fresh deploy (or a service that was down for a day) needs one walk
 * with no cutoff to establish the mirror. Idempotent like everything else here,
 * so re-running it on every boot only refreshes rows.
 */
export async function backfillRevolutHistory(): Promise<number> {
  let createdBefore: string | undefined;
  let mirrored = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const list = await listOrders({ limit: PAGE_LIMIT, createdBefore });
    const orders = list.orders ?? [];
    if (orders.length === 0) break;

    let oldest: string | undefined;
    for (const summary of orders) {
      if (!summary?.id) continue;
      const detail = await getOrder(summary.id);
      await recordRevolutObject("order", detail, "backfill");
      mirrored += 1;
      if (summary.created_at) oldest = summary.created_at;
    }
    if (!oldest || orders.length < PAGE_LIMIT) break;
    createdBefore = oldest;
  }

  console.log(`[stripe-service] Revolut back-fill mirrored ${mirrored} order(s)`);
  return mirrored;
}

export function startRevolutPoller(): void {
  if (process.env.RUN_REVOLUT_POLLER === "false") {
    console.log("[stripe-service] Revolut poller disabled");
    return;
  }
  const tick = () => {
    pollRevolutOnce().catch((err) => {
      // Never throw out of a timer: an unhandled rejection here would take the
      // process down over a third party being briefly unreachable.
      console.error("[stripe-service] Revolut poll failed:", err);
    });
  };
  setInterval(tick, POLL_INTERVAL_MS);
  tick();
  console.log("[stripe-service] Revolut poller started (5 min)");
}
