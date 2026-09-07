import { eq } from "drizzle-orm";
import { db } from "../db";
import { orgAcquirers } from "../db/schema";

/**
 * Which acquirer charges an org.
 *
 * This service already owns the other half of the same fact — which KEY charges
 * an org, resolved per org from key-service — so which acquirer that key
 * belongs to is our business too. A caller asks us to charge an org; it does
 * not name a vendor, and it must never learn one exists.
 *
 * Absent means Stripe. Every org that predates the table keeps its behaviour
 * with no backfill, and a lookup failure can never silently reroute an org's
 * money to the wrong acquirer — the default is the one that has been charging
 * it all along.
 */
export type Acquirer = "stripe" | "revolut";

export const DEFAULT_ACQUIRER: Acquirer = "stripe";

export interface AcquirerPin {
  acquirer: Acquirer;
  /** The acquirer's own customer id, when one has been established. */
  customerId: string | null;
  /**
   * Whether a row actually exists for this org, as opposed to it taking the
   * default. `acquirer` alone cannot say: an org explicitly pinned to Stripe
   * and one that was never pinned both read `stripe`, and only the second is a
   * candidate for a rollout to move.
   */
  pinned: boolean;
}

export async function resolveAcquirer(orgId: string): Promise<AcquirerPin> {
  const rows = await db
    .select({
      acquirer: orgAcquirers.acquirer,
      customerId: orgAcquirers.acquirerCustomerId,
    })
    .from(orgAcquirers)
    .where(eq(orgAcquirers.orgId, orgId))
    .limit(1);

  if (rows.length === 0) {
    return { acquirer: DEFAULT_ACQUIRER, customerId: null, pinned: false };
  }
  const stored = rows[0].acquirer;
  if (stored !== "stripe" && stored !== "revolut") {
    // Fail loud rather than fall back: a row we cannot read is a mis-pinned org,
    // and charging it on the default would put the money through the wrong
    // acquirer with the customer's saved card living on the other one.
    throw new Error(
      `Org ${orgId} is pinned to an unknown acquirer "${stored}"`
    );
  }
  return { acquirer: stored, customerId: rows[0].customerId, pinned: true };
}

/**
 * Return an org to the DEFAULT acquirer by deleting its pin.
 *
 * Absent means Stripe, so removing the row is what "back to the default" means
 * — the org ends up byte-identical to one that was never pinned, rather than
 * carrying a row that says the same thing in a second way.
 *
 * This exists because a mis-pin used to have no way back. `pinAcquirer` refuses
 * to move an org that holds a customer on the other acquirer, which is right
 * for a card that must not be stranded but also refused the correction itself —
 * so recovering meant deleting the row by hand in the database. It is the
 * CALLER's job to have established that the org holds no chargeable method on
 * the acquirer it is leaving; the route above this does that.
 *
 * Idempotent: an org with no pin is already on the default, and deleting
 * nothing is success.
 */
export async function unpinAcquirer(orgId: string): Promise<void> {
  await db.delete(orgAcquirers).where(eq(orgAcquirers.orgId, orgId));
}

/**
 * Pin an org to an acquirer, or record the acquirer's customer id for one
 * already pinned.
 *
 * Re-pinning an org that already holds a saved payment method is REFUSED. A
 * saved card lives with one acquirer and cannot be moved, so flipping the pin
 * would leave the org unable to be charged while its dashboard still shows a
 * card on file — the failure would surface as a decline nobody can explain.
 */
export async function pinAcquirer(params: {
  orgId: string;
  acquirer: Acquirer;
  customerId?: string | null;
}): Promise<void> {
  const existing = await db
    .select({ acquirer: orgAcquirers.acquirer, customerId: orgAcquirers.acquirerCustomerId })
    .from(orgAcquirers)
    .where(eq(orgAcquirers.orgId, params.orgId))
    .limit(1);

  if (
    existing.length > 0 &&
    existing[0].acquirer !== params.acquirer &&
    existing[0].customerId
  ) {
    throw new Error(
      `Refusing to re-pin org ${params.orgId} from ${existing[0].acquirer} to ` +
        `${params.acquirer}: it already has a customer on the first acquirer, ` +
        "and a saved card cannot move between them"
    );
  }

  const values = {
    orgId: params.orgId,
    acquirer: params.acquirer,
    acquirerCustomerId: params.customerId ?? existing[0]?.customerId ?? null,
    updatedAt: new Date(),
  };
  await db
    .insert(orgAcquirers)
    .values(values)
    .onConflictDoUpdate({
      target: orgAcquirers.orgId,
      set: { acquirer: values.acquirer, acquirerCustomerId: values.acquirerCustomerId, updatedAt: values.updatedAt },
    });
}
