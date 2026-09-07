import crypto from "crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { acquirerRollout, customers } from "../db/schema";
import {
  DEFAULT_ACQUIRER,
  pinAcquirer,
  resolveAcquirer,
  type Acquirer,
  type AcquirerPin,
} from "./acquirer";
import { hasChargeablePaymentMethod } from "./chargeable-method";
import { createCustomer } from "./revolut-client";

/**
 * How much of the NEW business goes to a second acquirer.
 *
 * The owner's requirement is that Stripe's share can be reduced deliberately
 * and put back in seconds if the other acquirer misbehaves, without a deploy
 * per org. So the share is DATA — one row, written through an internal route —
 * and setting `percent` to 0 sends every subsequent org back to Stripe with no
 * code change and nothing to undo.
 *
 * Absent row means 0%, which is precisely the behaviour every org has today.
 */
export interface Rollout {
  acquirer: Acquirer;
  percent: number;
}

export const NO_ROLLOUT: Rollout = { acquirer: DEFAULT_ACQUIRER, percent: 0 };

export async function readRollout(): Promise<Rollout> {
  const rows = await db
    .select({
      acquirer: acquirerRollout.acquirer,
      percent: acquirerRollout.percent,
    })
    .from(acquirerRollout)
    .where(eq(acquirerRollout.id, 1))
    .limit(1);

  if (rows.length === 0) return NO_ROLLOUT;
  const stored = rows[0].acquirer;
  if (stored !== "stripe" && stored !== "revolut") {
    // Fail loud, exactly as the per-org pin does. A rollout row we cannot read
    // must not quietly become "route everyone somewhere".
    throw new Error(`Rollout names an unknown acquirer "${stored}"`);
  }
  return { acquirer: stored, percent: rows[0].percent };
}

export async function writeRollout(rollout: Rollout): Promise<void> {
  const values = {
    id: 1,
    acquirer: rollout.acquirer,
    percent: rollout.percent,
    updatedAt: new Date(),
  };
  await db
    .insert(acquirerRollout)
    .values(values)
    .onConflictDoUpdate({
      target: acquirerRollout.id,
      set: {
        acquirer: values.acquirer,
        percent: values.percent,
        updatedAt: values.updatedAt,
      },
    });
}

/**
 * Which bucket (0-99) an org falls in.
 *
 * Deterministic on the org id, not random per request: a customer who opens a
 * checkout, abandons it and comes back must meet the same acquirer, or they
 * would be shown one page and then another for no reason. It also means raising
 * the share only ever ADDS orgs — nobody who was already selected falls out.
 */
export function rolloutBucket(orgId: string): number {
  const digest = crypto.createHash("sha256").update(orgId).digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Which acquirer takes this org's checkout — pinning it if the rollout selects
 * it, and leaving it alone in every other case.
 *
 * ⚠️ The one invariant that must hold by construction: an org that ALREADY has
 * a saved payment method is never moved. A card lives with one acquirer and
 * cannot be charged through the other, so moving such an org would leave its
 * next automatic reload failing against an acquirer that has never seen its
 * card — silently, because nothing about the pin fails. That is checked here
 * with the same LIVE read the pin routes use (`hasChargeablePaymentMethod`),
 * against the acquirer the org is on today, rather than remembered from a
 * column that could go stale.
 *
 * Progressive therefore means NEW customers, by definition rather than by
 * discipline: the selection can only ever fire for an org with nothing to
 * strand.
 *
 * Order of the checks is deliberate, so an org at 0% rollout costs exactly one
 * extra DB read and NOTHING else — no acquirer call, no Stripe call, no write.
 * The Stripe path stays what it was for everybody who has not opted in.
 */
export async function selectAcquirerForCheckout(
  orgId: string
): Promise<AcquirerPin> {
  const pin = await resolveAcquirer(orgId);
  // An org that was pinned — either way, by anyone — has had its decision made.
  if (pin.pinned) return pin;

  const rollout = await readRollout();
  if (rollout.percent <= 0 || rollout.acquirer === DEFAULT_ACQUIRER) return pin;
  if (rolloutBucket(orgId) >= rollout.percent) return pin;

  // The invariant. Read live from the acquirer the org is on now; an acquirer
  // we cannot reach propagates rather than being read as "no card", because
  // "we could not ask" is not an answer that makes a move safe.
  if (await hasChargeablePaymentMethod(orgId, pin)) return pin;

  if (rollout.acquirer !== "revolut") return pin;

  // A saved card is saved against a customer, so the org needs one before its
  // first checkout can store anything.
  const contact = await db
    .select({ email: customers.email, name: customers.name })
    .from(customers)
    .where(eq(customers.orgId, orgId))
    .orderBy(desc(customers.syncedAt))
    .limit(1);

  const created = await createCustomer({
    email: contact[0]?.email ?? undefined,
    full_name: contact[0]?.name ?? undefined,
  });
  await pinAcquirer({ orgId, acquirer: "revolut", customerId: created.id });
  console.log(
    `[stripe-service] Rollout selected org ${orgId} for revolut (bucket ${rolloutBucket(orgId)} < ${rollout.percent}%)`
  );
  return { acquirer: "revolut", customerId: created.id, pinned: true };
}
