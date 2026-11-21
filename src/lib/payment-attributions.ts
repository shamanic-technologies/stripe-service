import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { paymentIntents, paymentOrgAttributions, revolutOrders } from "../db/schema";
import { UNATTRIBUTED_ORG } from "./platform-billing-stats";

/**
 * A STAFF statement: "this org-less payment belongs to org X"
 * (SAAS-CASH-1121-AGENCY).
 *
 * Some money reaches us with no org on its row: a Stripe PaymentIntent on the
 * `unknown` sentinel, a Revolut order (top-up or staff payment link) with a
 * null `org_id`. The only way to tie it to an org is a named staff member
 * saying so. This records that statement, once, append-only.
 *
 * READ ONLY BY the cash-by-org-day read (`cash-by-org-day.ts`), which moves the
 * payment and its returns from the org-less row to the stated org's row. It
 * never feeds the per-org payment summary, credited, paying-account counts,
 * first-payment instants, public stats or anything that grants credit: a
 * reporting attribution is not money arriving on an org.
 *
 * Refused: a payment we do not mirror (404), a payment whose row already
 * carries an org (409 `payment_has_org`), a payment already attributed to a
 * DIFFERENT org (409 `attributed_to_other_org`). The same org again is an
 * idempotent replay (the first statement stands, nothing changes).
 */

export const ATTRIBUTION_ACQUIRERS = ["stripe", "revolut"] as const;
export type AttributionAcquirer = (typeof ATTRIBUTION_ACQUIRERS)[number];

/** Revolut order types that are money IN (a refund follows its parent). */
const REVOLUT_PAYMENT_TYPES = ["payment", "payment_request"];

export type PaymentAttribution = typeof paymentOrgAttributions.$inferSelect;

export class PaymentNotFound extends Error {
  constructor(acquirer: string, paymentId: string) {
    super(`No mirrored ${acquirer} payment ${paymentId}`);
  }
}

export class PaymentHasOrg extends Error {
  constructor(public readonly orgId: string) {
    super(`This payment already carries org ${orgId}; nothing to attribute`);
  }
}

export class AttributedToOtherOrg extends Error {
  constructor(public readonly existing: PaymentAttribution) {
    super(
      `This payment is already attributed to org ${existing.orgId} (by ${existing.recordedBy})`
    );
  }
}

export type RecordAttributionInput = {
  acquirer: AttributionAcquirer;
  paymentId: string;
  orgId: string;
  recordedBy: string;
  note: string;
};

/** The org the payment's OWN row carries, null when it carries none. Throws when not mirrored. */
async function nativeOrgOf(acquirer: AttributionAcquirer, paymentId: string): Promise<string | null> {
  if (acquirer === "stripe") {
    const [pi] = await db
      .select({ orgId: paymentIntents.orgId })
      .from(paymentIntents)
      .where(eq(paymentIntents.id, paymentId));
    if (!pi) throw new PaymentNotFound(acquirer, paymentId);
    return pi.orgId === UNATTRIBUTED_ORG || pi.orgId === "" ? null : pi.orgId;
  }
  const [order] = await db
    .select({ orgId: revolutOrders.orgId })
    .from(revolutOrders)
    .where(
      and(eq(revolutOrders.id, paymentId), inArray(revolutOrders.type, REVOLUT_PAYMENT_TYPES))
    );
  if (!order) throw new PaymentNotFound(acquirer, paymentId);
  return order.orgId ?? null;
}

export async function recordPaymentAttribution(
  input: RecordAttributionInput
): Promise<{ attribution: PaymentAttribution; created: boolean }> {
  const native = await nativeOrgOf(input.acquirer, input.paymentId);
  if (native !== null) throw new PaymentHasOrg(native);

  const inserted = await db
    .insert(paymentOrgAttributions)
    .values({
      acquirer: input.acquirer,
      paymentId: input.paymentId,
      orgId: input.orgId,
      recordedBy: input.recordedBy,
      note: input.note,
    })
    .onConflictDoNothing({
      target: [paymentOrgAttributions.acquirer, paymentOrgAttributions.paymentId],
    })
    .returning();
  if (inserted.length > 0) return { attribution: inserted[0], created: true };

  const [existing] = await db
    .select()
    .from(paymentOrgAttributions)
    .where(
      and(
        eq(paymentOrgAttributions.acquirer, input.acquirer),
        eq(paymentOrgAttributions.paymentId, input.paymentId)
      )
    );
  if (!existing) throw new Error("payment attribution conflict but no row found");
  if (existing.orgId !== input.orgId) throw new AttributedToOtherOrg(existing);
  return { attribution: existing, created: false };
}

export async function listPaymentAttributions(): Promise<PaymentAttribution[]> {
  return db
    .select()
    .from(paymentOrgAttributions)
    .orderBy(asc(paymentOrgAttributions.recordedAt), asc(paymentOrgAttributions.paymentId));
}
