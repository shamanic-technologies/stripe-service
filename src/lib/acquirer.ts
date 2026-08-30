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
    return { acquirer: DEFAULT_ACQUIRER, customerId: null };
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
  return { acquirer: stored, customerId: rows[0].customerId };
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
