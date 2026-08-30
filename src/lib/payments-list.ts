import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { paymentIntents, revolutOrders } from "../db/schema";
import { returnedByPaymentIntent } from "./returned-amounts";

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
  /** Diagnostic only. A consumer must not branch on it. */
  acquirer: "stripe" | "revolut";
  amount: number;
  currency: string;
  status: "succeeded" | "failed" | "pending";
  /** Unix seconds, so one sort key orders payments from every acquirer. */
  created: number;
  description: string | null;
  /** Settled refunds + lost disputes against this payment, minor units. */
  amount_returned: number;
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
  const [stripeRows, revolutRows] = await Promise.all([
    db
      .select({
        id: paymentIntents.id,
        amount: paymentIntents.amount,
        currency: paymentIntents.currency,
        status: paymentIntents.status,
        description: paymentIntents.description,
        created: paymentIntents.createdStripe,
        latestCharge: paymentIntents.latestCharge,
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
  ]);

  const returned = await returnedByPaymentIntent(
    stripeRows.map((r) => ({ id: r.id, latestCharge: r.latestCharge }))
  );

  // Card-verification orders are OUR artifact, not something the customer
  // bought. An acquirer that cannot store a card without an authorisation makes
  // us place one; showing it as a pending payment in someone's history invites
  // exactly the question it has no good answer to.
  const customerFacing = revolutRows.filter(
    (r) => (r.metadata as { purpose?: string } | null)?.purpose !== "card-setup"
  );

  const payments: OrgPayment[] = [
    ...stripeRows.map((r) => ({
      id: r.id,
      acquirer: "stripe" as const,
      amount: r.amount,
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
    })),
  ];

  return payments.sort((a, b) => b.created - a.created);
}
