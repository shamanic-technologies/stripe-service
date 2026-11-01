import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { cardHolds, paymentIntents, revolutOrders } from "../db/schema";
import { returnedByPaymentIntent } from "./returned-amounts";
import { standingDirectPayments } from "./direct-payments";

/**
 * One payment an org made, whichever acquirer took it.
 *
 * This is the gold-layer answer to "show me what this org has paid", and it is
 * deliberately NOT a vendor object. A consumer rendering a payment history
 * needs an amount, a currency, when it happened, whether it worked and how much
 * came back — every acquirer can answer those, and none of them agree on the
 * object that carries them.
 *
 * `status` is canonicalised rather than passed through: Stripe says
 * `succeeded`, Revolut says `completed`, and a history that showed both would
 * make one org's payments look different from another's for no reason a
 * customer could understand.
 */
export interface OrgPayment {
  id: string;
  /**
   * Diagnostic only. A consumer must not branch on it. `direct` = money staff
   * recorded as paid outside any acquirer (no vendor object behind it).
   */
  acquirer: "stripe" | "revolut" | "direct";
  amount: number;
  currency: string;
  status: "succeeded" | "failed" | "pending";
  /** Unix seconds, so one sort key orders payments from every acquirer. */
  created: number;
  description: string | null;
  /** Settled refunds + lost disputes against this payment, minor units. */
  amount_returned: number;
}

/**
 * What a captured card hold PAID FOR, and when the card was charged.
 *
 * A hold is placed with the description of a hold ("card check, nothing is
 * charged") on the day the credit line opens; days later billing captures it to
 * pay the org's campaign spend. Listing it under the acquirer object's own
 * description and creation date tells the customer two false things beside a
 * real amount: that nothing was charged, and that it happened the day of the
 * hold (Beyond Logic, held 27 Oct, captured 31 Oct for $40.13). A capture is
 * ALWAYS a payment of spend already made (billing only captures for money
 * owed), so the label is that spend, in the month the card was charged (UTC).
 * Derived on read from `card_holds`, so a hold captured before this existed
 * reads right too.
 */
export function capturedHoldLabel(capturedAt: Date): string {
  const month = capturedAt.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Distribute campaigns, ${month}`;
}

function revolutStatus(state: string | null): OrgPayment["status"] {
  if (state === "completed") return "succeeded";
  if (state === "failed" || state === "cancelled") return "failed";
  return "pending";
}

/**
 * Every payment an org has made, newest first, across acquirers.
 *
 * The Stripe half keeps the exact predicate its own reads use, so an org with
 * no Revolut activity sees a byte-identical history to the one it saw before
 * this existed. The Revolut half counts `type='payment'` orders — a refund is
 * its own order there and belongs in `amount_returned`, not in the list as a
 * negative payment.
 */
export async function listOrgPayments(orgId: string): Promise<OrgPayment[]> {
  const [stripeRows, revolutRows, directRows, holdRows] = await Promise.all([
    db
      .select({
        id: paymentIntents.id,
        amount: paymentIntents.amount,
        currency: paymentIntents.currency,
        status: paymentIntents.status,
        description: paymentIntents.description,
        created: paymentIntents.createdStripe,
        latestCharge: paymentIntents.latestCharge,
        amountReceived: paymentIntents.amountReceived,
        metadata: paymentIntents.metadata,
      })
      .from(paymentIntents)
      .where(eq(paymentIntents.orgId, orgId)),
    db
      .select({
        id: revolutOrders.id,
        amount: revolutOrders.amount,
        currency: revolutOrders.currency,
        state: revolutOrders.state,
        description: revolutOrders.description,
        createdAt: revolutOrders.createdAtRevolut,
        refunded: revolutOrders.refundedAmount,
        metadata: revolutOrders.metadata,
      })
      .from(revolutOrders)
      .where(
        and(eq(revolutOrders.orgId, orgId), eq(revolutOrders.type, "payment"))
      ),
    standingDirectPayments(orgId),
    db
      .select({
        reference: cardHolds.reference,
        capturedAt: cardHolds.capturedAt,
        updatedAt: cardHolds.updatedAt,
      })
      .from(cardHolds)
      .where(eq(cardHolds.orgId, orgId)),
  ]);

  const returned = await returnedByPaymentIntent(
    stripeRows.map((r) => ({ id: r.id, latestCharge: r.latestCharge }))
  );

  // Card-verification orders are OUR artifact, not something the customer
  // bought. An acquirer that cannot store a card without an authorisation makes
  // us place one; showing it as a pending payment in someone's history invites
  // exactly the question it has no good answer to.
  //
  // A card HOLD is the same kind of artifact until it is captured: an
  // authorisation, released or lapsed, was never a payment. Once captured it
  // IS one, listed at what was taken (Revolut's order amount is overridden by
  // the mirror, Stripe's is `amount_received`).
  const purposeOf = (m: unknown) => (m as { purpose?: string } | null)?.purpose;
  const customerFacing = revolutRows.filter(
    (r) =>
      purposeOf(r.metadata) !== "card-setup" &&
      (purposeOf(r.metadata) !== "card-hold" || r.state === "completed")
  );
  const stripeFacing = stripeRows.filter(
    (r) => purposeOf(r.metadata) !== "card-hold" || r.status === "succeeded"
  );

  // A captured hold is dated the day the card was CHARGED and labelled with
  // what it paid for, never the hold's own day and wording. `capturedAt` is
  // null only for a Revolut capture still settling when its row was last
  // written; `updatedAt` is then the capture attempt itself (the row is written
  // with the captured amount right before the capture is sent).
  const holdByReference = new Map(
    holdRows.filter((h) => h.reference).map((h) => [h.reference!, h])
  );
  const capturedHold = (reference: string) => {
    const hold = holdByReference.get(reference);
    if (!hold) {
      throw new Error(
        `card-hold payment ${reference} of org ${orgId} has no card_holds row`
      );
    }
    const chargedAt = hold.capturedAt ?? hold.updatedAt;
    return {
      created: Math.floor(chargedAt.getTime() / 1000),
      description: capturedHoldLabel(chargedAt),
    };
  };

  const payments: OrgPayment[] = [
    ...stripeFacing.map((r) => ({
      id: r.id,
      acquirer: "stripe" as const,
      amount:
        purposeOf(r.metadata) === "card-hold" ? (r.amountReceived ?? r.amount) : r.amount,
      currency: (r.currency ?? "usd").toLowerCase(),
      status:
        r.status === "succeeded"
          ? ("succeeded" as const)
          : r.status === "canceled"
            ? ("failed" as const)
            : ("pending" as const),
      created: r.created ?? 0,
      description: r.description ?? null,
      amount_returned: returned.get(r.id)?.amount_returned ?? 0,
      ...(purposeOf(r.metadata) === "card-hold" ? capturedHold(r.id) : {}),
    })),
    ...customerFacing.map((r) => ({
      id: r.id,
      acquirer: "revolut" as const,
      amount: r.amount ?? 0,
      currency: (r.currency ?? "usd").toLowerCase(),
      status: revolutStatus(r.state),
      // Revolut dates its objects with an ISO timestamp; the list is sorted and
      // rendered on one scale, so it is converted rather than left in a second
      // format a consumer would have to sniff.
      created: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : 0,
      description: r.description ?? null,
      amount_returned: r.refunded ?? 0,
      ...(purposeOf(r.metadata) === "card-hold" ? capturedHold(r.id) : {}),
    })),
    // Money staff recorded as paid outside any acquirer. Settled by definition
    // (it was received before it was recorded); a voided one is not listed, as
    // it is counted nowhere. The staff note stays internal: it is not copy the
    // customer was meant to read.
    ...directRows.map((r) => ({
      id: r.id,
      acquirer: "direct" as const,
      amount: r.amount,
      currency: r.currency.toLowerCase(),
      status: "succeeded" as const,
      created: Math.floor(r.recordedAt.getTime() / 1000),
      description: "Direct payment",
      amount_returned: 0,
    })),
  ];

  return payments.sort((a, b) => b.created - a.created);
}
