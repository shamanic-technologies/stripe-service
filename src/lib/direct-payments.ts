import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { directPayments } from "../db/schema";
import type { CurrencyTotals } from "./returned-amounts";
import type { ReturnedBucketRow } from "./platform-billing-stats";

/**
 * Money an org paid us OUTSIDE any acquirer, recorded by staff.
 *
 * A staff member states "this org paid us X" (an agency client paid the owner
 * directly, or the owner funds his own org). It is a PAYMENT, not a gift: it
 * counts wherever a settled acquirer payment counts — the per-org summary
 * (bounded or not), the payment history and every platform revenue and
 * paying-account figure — dated at the instant it was recorded.
 *
 * It never pretends to be a vendor object. No acquirer is called, no Stripe or
 * Revolut object is minted, and listings name it `acquirer: "direct"`.
 *
 * A VOID is a correction, not a refund: a voided row is excluded from every
 * read as if it had never been recorded, so voiding brings every figure back
 * exactly — including the paying-account counts and the month it sat in.
 */

export type DirectPayment = typeof directPayments.$inferSelect;

/** Only rows that still stand. A voided row never counts anywhere. */
const standing = isNull(directPayments.voidedAt);

export type RecordDirectPaymentInput = {
  orgId: string;
  amount: number;
  currency: string;
  note: string;
  recordedBy: string;
  idempotencyKey: string;
};

/** Same Idempotency-Key, different payment: refused, never silently merged. */
export class IdempotencyKeyReused extends Error {
  constructor(public readonly existing: DirectPayment) {
    super(
      "Idempotency-Key already used for a different direct payment on this org"
    );
  }
}

/**
 * Record a direct payment, once per (org, Idempotency-Key).
 *
 * A replay with the same key and the same amount + currency returns the row
 * already there (`created: false`) and changes nothing. A replay with the same
 * key and a DIFFERENT amount or currency is a caller bug and throws
 * `IdempotencyKeyReused`: answering with the first row would report a payment
 * the caller did not ask for as if it had been recorded.
 */
export async function recordDirectPayment(
  input: RecordDirectPaymentInput
): Promise<{ payment: DirectPayment; created: boolean }> {
  const currency = input.currency.toLowerCase();
  const inserted = await db
    .insert(directPayments)
    .values({
      orgId: input.orgId,
      amount: input.amount,
      currency,
      note: input.note,
      recordedBy: input.recordedBy,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({
      target: [directPayments.orgId, directPayments.idempotencyKey],
    })
    .returning();
  if (inserted.length > 0) return { payment: inserted[0], created: true };

  const [existing] = await db
    .select()
    .from(directPayments)
    .where(
      and(
        eq(directPayments.orgId, input.orgId),
        eq(directPayments.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1);
  if (!existing) {
    throw new Error(
      "direct payment insert conflicted but no row carries its idempotency key"
    );
  }
  if (existing.amount !== input.amount || existing.currency !== currency) {
    throw new IdempotencyKeyReused(existing);
  }
  return { payment: existing, created: false };
}

/**
 * Void a direct payment recorded by mistake. Idempotent: an already-voided row
 * is returned as it is (`voided: false`), its first void untouched. `null` when
 * the org has no such payment.
 */
export async function voidDirectPayment(input: {
  orgId: string;
  id: string;
  voidedBy: string;
  reason: string | null;
}): Promise<{ payment: DirectPayment; voided: boolean } | null> {
  const updated = await db
    .update(directPayments)
    .set({
      voidedAt: sql`now()`,
      voidedBy: input.voidedBy,
      voidReason: input.reason,
    })
    .where(
      and(
        eq(directPayments.id, input.id),
        eq(directPayments.orgId, input.orgId),
        standing
      )
    )
    .returning();
  if (updated.length > 0) return { payment: updated[0], voided: true };

  const [existing] = await db
    .select()
    .from(directPayments)
    .where(
      and(eq(directPayments.id, input.id), eq(directPayments.orgId, input.orgId))
    )
    .limit(1);
  return existing ? { payment: existing, voided: false } : null;
}

/** Every direct payment recorded for the org, voided ones included, newest first. */
export async function listDirectPayments(orgId: string): Promise<DirectPayment[]> {
  return db
    .select()
    .from(directPayments)
    .where(eq(directPayments.orgId, orgId))
    .orderBy(desc(directPayments.recordedAt));
}

/** Standing direct payments for the org — what the payment history shows. */
export async function standingDirectPayments(
  orgId: string
): Promise<DirectPayment[]> {
  return db
    .select()
    .from(directPayments)
    .where(and(eq(directPayments.orgId, orgId), standing));
}

/**
 * The org's direct payments per currency, in the summary's shape. Nothing is
 * ever returned against a direct payment (a void removes it instead), so
 * received === net. `asOf` bounds to payments recorded STRICTLY before it,
 * exactly like the acquirer halves.
 */
export async function directTotalsByCurrency(
  orgId: string,
  asOf?: Date
): Promise<CurrencyTotals[]> {
  const rows = await db
    .select({
      currency: directPayments.currency,
      total: sql<string>`COALESCE(SUM(${directPayments.amount}), 0)::text`,
    })
    .from(directPayments)
    .where(
      and(
        eq(directPayments.orgId, orgId),
        standing,
        ...(asOf ? [lt(directPayments.recordedAt, asOf)] : [])
      )
    )
    .groupBy(directPayments.currency);

  return rows.map((row) => {
    const received = Number(row.total);
    return {
      currency: row.currency.toLowerCase(),
      amount_received: received,
      amount_refunded: 0,
      amount_disputed_lost: 0,
      amount_returned: 0,
      amount_net: received,
    };
  });
}

/** Platform-wide standing direct payments, grouped by (month, week) of recording. */
export async function directPaidBuckets(): Promise<ReturnedBucketRow[]> {
  const month = sql<Date>`date_trunc('month', ${directPayments.recordedAt})`;
  const week = sql<Date>`date_trunc('week', ${directPayments.recordedAt})`;
  return (await db
    .select({
      month,
      week,
      cents: sql<string>`SUM(${directPayments.amount})::text`,
    })
    .from(directPayments)
    .where(standing)
    .groupBy(month, week)) as ReturnedBucketRow[];
}
