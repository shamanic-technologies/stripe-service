import crypto from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { revolutObjectSnapshots, revolutOrders } from "../db/schema";
import { getOrder, type RevolutOrder } from "./revolut-client";

export type RevolutObjectKind = "order" | "dispute";
export type RevolutSource = "webhook" | "poll" | "backfill";

/**
 * Bronze -> silver for Revolut, on exactly the contract the Stripe mirror uses:
 * nothing writes silver directly, and the projection reads the LATEST bronze
 * snapshot rather than whatever happened to arrive last.
 *
 * The ordering key is Revolut's own `updated_at`, which is monotonic per object
 * across state transitions — the role `event.created` plays on the Stripe side.
 * A snapshot that reaches us late therefore cannot roll silver back to a state
 * the object has already left.
 */

function snapshotId(
  kind: RevolutObjectKind,
  objectId: string,
  payload: unknown
): string {
  return crypto
    .createHash("sha256")
    .update(`${kind}|${objectId}|${JSON.stringify(payload)}`)
    .digest("hex");
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Store a fetched object verbatim in bronze, then re-project its silver row.
 *
 * Idempotent by construction: the primary key is a hash of the payload, so
 * re-fetching an unchanged object collapses onto the row already there instead
 * of appending a duplicate. That matters because all four freshness paths
 * (webhook, poll, back-fill, and a manual re-read) legitimately fetch the same
 * object, and none of them should be able to inflate the ledger.
 */
export async function recordRevolutObject(
  kind: RevolutObjectKind,
  object: { id: string; updated_at?: string; [key: string]: unknown },
  source: RevolutSource
): Promise<void> {
  await db
    .insert(revolutObjectSnapshots)
    .values({
      id: snapshotId(kind, object.id, object),
      objectKind: kind,
      objectId: object.id,
      objectUpdatedAt: parseDate(object.updated_at),
      payload: object as Record<string, unknown>,
      source,
    })
    .onConflictDoNothing();

  // Disputes are captured in bronze only until a real payload has been seen —
  // typed columns for a shape nobody has observed would be guesswork.
  if (kind === "order") {
    await projectRevolutOrder(object.id);
  }
}

/**
 * Re-derive one order's silver row from the newest bronze snapshot it has.
 *
 * `NULLS LAST` matters: an object we stored before Revolut gave it an
 * `updated_at` must never outrank a dated snapshot, or the undated one wins
 * forever and the row freezes.
 */
export async function projectRevolutOrder(orderId: string): Promise<void> {
  const rows = await db
    .select({ payload: revolutObjectSnapshots.payload })
    .from(revolutObjectSnapshots)
    .where(
      and(
        eq(revolutObjectSnapshots.objectKind, "order"),
        eq(revolutObjectSnapshots.objectId, orderId)
      )
    )
    .orderBy(
      sql`${revolutObjectSnapshots.objectUpdatedAt} DESC NULLS LAST`,
      desc(revolutObjectSnapshots.receivedAt)
    )
    .limit(1);

  if (rows.length === 0) return;
  await upsertRevolutOrder(rows[0].payload as RevolutOrder);
}

/**
 * The fee Revolut charged on this order, in minor units.
 *
 * Summed across every payment's every fee rather than read from one field:
 * `fees` is an ARRAY of typed entries (`acquiring` on the transaction we
 * observed), so taking `fees[0]` would silently under-report the moment Revolut
 * adds a second kind. Null when no payment has settled yet — an unsettled order
 * has no fee, which is different from a fee of zero.
 */
export function feeAmountOf(order: RevolutOrder): number | null {
  const payments = order.payments;
  if (!Array.isArray(payments) || payments.length === 0) return null;
  let total = 0;
  let seen = false;
  for (const payment of payments) {
    for (const fee of payment.fees ?? []) {
      if (typeof fee.amount === "number") {
        total += fee.amount;
        seen = true;
      }
    }
  }
  return seen ? total : null;
}

function settledAmountOf(order: RevolutOrder): number | null {
  for (const payment of order.payments ?? []) {
    if (typeof payment.settled_amount === "number") return payment.settled_amount;
  }
  return null;
}

function paymentMethodTypeOf(order: RevolutOrder): string | null {
  for (const payment of order.payments ?? []) {
    const type = payment.payment_method?.type;
    if (typeof type === "string") return type;
  }
  return null;
}

/**
 * Resolve the tenant for an order.
 *
 * A payment carries `metadata.org_id` because we stamp it at creation. A REFUND
 * does not — Revolut mints it as its own order with no metadata at all — so the
 * org is inherited from the payment it reverses via `related_order_id`. Same
 * principle as the Stripe mirror, where refunds and disputes carry no `org_id`
 * and resolve through the PaymentIntent: one home for the mapping, so a return
 * can never drift out of sync with the payment it belongs to.
 *
 * Returns null rather than a placeholder when neither source answers. An
 * unattributable row is honestly unattributed; inventing an `"unknown"` tenant
 * would put it in a bucket some future query treats as real.
 */
export async function resolveRevolutOrgId(
  order: RevolutOrder
): Promise<string | null> {
  const own = order.metadata?.org_id;
  if (typeof own === "string" && own.length > 0) return own;

  const parentId = order.related_order_id;
  if (typeof parentId !== "string" || parentId.length === 0) return null;

  const parent = await db
    .select({ orgId: revolutOrders.orgId })
    .from(revolutOrders)
    .where(eq(revolutOrders.id, parentId))
    .limit(1);
  return parent.length > 0 ? parent[0].orgId : null;
}

async function upsertRevolutOrder(order: RevolutOrder): Promise<void> {
  const orgId = await resolveRevolutOrgId(order);
  const values = {
    id: order.id,
    type: typeof order.type === "string" ? order.type : "unknown",
    state: order.state ?? null,
    orgId,
    relatedOrderId: order.related_order_id ?? null,
    amount: typeof order.amount === "number" ? order.amount : null,
    currency: order.currency ?? null,
    outstandingAmount:
      typeof order.outstanding_amount === "number"
        ? order.outstanding_amount
        : null,
    refundedAmount:
      typeof order.refunded_amount === "number" ? order.refunded_amount : null,
    settledAmount: settledAmountOf(order),
    feeAmount: feeAmountOf(order),
    paymentMethodType: paymentMethodTypeOf(order),
    description: order.description ?? null,
    metadata: order.metadata ?? null,
    createdAtStripe: parseDate(order.created_at),
    updatedAtRevolut: parseDate(order.updated_at),
    rawJson: order as unknown as Record<string, unknown>,
    syncedAt: new Date(),
  };

  await db
    .insert(revolutOrders)
    .values(values)
    .onConflictDoUpdate({ target: revolutOrders.id, set: values });
}

/**
 * Fetch an order from Revolut and mirror it. This is the ONLY path a webhook
 * takes: a delivery tells us WHICH order changed and we ask Revolut what it now
 * says, rather than trusting a body we did not authenticate the contents of.
 * It also means the mirror does not depend on the shape of any webhook payload,
 * which is the one Revolut shape we have still never observed.
 */
export async function fetchAndMirrorOrder(
  orderId: string,
  source: RevolutSource
): Promise<RevolutOrder> {
  const order = await getOrder(orderId);
  await recordRevolutObject("order", order, source);

  // A refund's parent carries `refunded_amount`, which only changes on the
  // parent object — so a refund we just learned about leaves the payment stale
  // until we re-read it too.
  const parentId = order.related_order_id;
  if (typeof parentId === "string" && parentId.length > 0) {
    const parent = await getOrder(parentId);
    await recordRevolutObject("order", parent, source);
  }
  return order;
}
