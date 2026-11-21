import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  directPayments,
  paymentAgencyClassifications,
  paymentIntents,
  revolutOrders,
} from "../db/schema";
import { REVOLUT_AGENCY_TYPE } from "./platform-billing-stats";

/**
 * A STAFF statement: "this recorded payment is AGENCY money, not SaaS"
 * (SAAS-CASH-1121-AGENCY-KIND). Owner 2026-11-21: some money counted as SaaS
 * was an agency fee (a journalist expert quote paid by payment link, a direct
 * payment from an agency client).
 *
 * READ ONLY BY the cash-by-org-day read (`cash-by-org-day.ts`), which moves the
 * payment (and its refunds / lost disputes) from the SaaS fields to the agency
 * fields of the SAME (org, day) row. It never feeds payment_summary, credited,
 * any balance, paying-account counts, first-payment instants or public stats:
 * a reporting kind, not money moving.
 *
 * Accepted: a mirrored Stripe PaymentIntent, a Revolut `payment` order, a
 * direct payment. Refused: unknown payment (404), a Revolut `payment_request`
 * (409 `already_agency`: it is agency money by construction). A replay is
 * idempotent (the first statement stands). Nothing to undo for now.
 */

export const AGENCY_CLASSIFICATION_ACQUIRERS = ["stripe", "revolut", "direct"] as const;
export type AgencyClassificationAcquirer = (typeof AGENCY_CLASSIFICATION_ACQUIRERS)[number];

export type PaymentAgencyClassification = typeof paymentAgencyClassifications.$inferSelect;

export class ClassifiedPaymentNotFound extends Error {
  constructor(acquirer: string, paymentId: string) {
    super(`No recorded ${acquirer} payment ${paymentId}`);
  }
}

export class PaymentAlreadyAgency extends Error {
  constructor(paymentId: string) {
    super(`Revolut order ${paymentId} is a payment link: already agency money`);
  }
}

export type RecordAgencyClassificationInput = {
  acquirer: AgencyClassificationAcquirer;
  paymentId: string;
  recordedBy: string;
  note: string;
};

/** Throws when the payment is not recorded here, or is already agency money. */
async function assertClassifiable(
  acquirer: AgencyClassificationAcquirer,
  paymentId: string
): Promise<void> {
  if (acquirer === "stripe") {
    const [pi] = await db
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(eq(paymentIntents.id, paymentId));
    if (!pi) throw new ClassifiedPaymentNotFound(acquirer, paymentId);
    return;
  }
  if (acquirer === "revolut") {
    const [order] = await db
      .select({ type: revolutOrders.type })
      .from(revolutOrders)
      .where(eq(revolutOrders.id, paymentId));
    if (!order || (order.type !== "payment" && order.type !== REVOLUT_AGENCY_TYPE)) {
      throw new ClassifiedPaymentNotFound(acquirer, paymentId);
    }
    if (order.type === REVOLUT_AGENCY_TYPE) throw new PaymentAlreadyAgency(paymentId);
    return;
  }
  const [dp] = await db
    .select({ id: directPayments.id })
    .from(directPayments)
    .where(sql`${directPayments.id}::text = ${paymentId}`);
  if (!dp) throw new ClassifiedPaymentNotFound(acquirer, paymentId);
}

export async function recordAgencyClassification(
  input: RecordAgencyClassificationInput
): Promise<{ classification: PaymentAgencyClassification; created: boolean }> {
  await assertClassifiable(input.acquirer, input.paymentId);

  const inserted = await db
    .insert(paymentAgencyClassifications)
    .values({
      acquirer: input.acquirer,
      paymentId: input.paymentId,
      recordedBy: input.recordedBy,
      note: input.note,
    })
    .onConflictDoNothing({
      target: [paymentAgencyClassifications.acquirer, paymentAgencyClassifications.paymentId],
    })
    .returning();
  if (inserted.length > 0) return { classification: inserted[0], created: true };

  const [existing] = await db
    .select()
    .from(paymentAgencyClassifications)
    .where(
      and(
        eq(paymentAgencyClassifications.acquirer, input.acquirer),
        eq(paymentAgencyClassifications.paymentId, input.paymentId)
      )
    );
  if (!existing) throw new Error("agency classification conflict but no row found");
  return { classification: existing, created: false };
}

export async function listAgencyClassifications(): Promise<PaymentAgencyClassification[]> {
  return db
    .select()
    .from(paymentAgencyClassifications)
    .orderBy(asc(paymentAgencyClassifications.recordedAt), asc(paymentAgencyClassifications.paymentId));
}
