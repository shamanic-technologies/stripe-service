/**
 * One-off cleanup: remove duplicate Stripe customers for orgs that ended up with
 * more than one (pre-#81, `POST /v1/customers` created unconditionally, so caller
 * retries / parallel account-setup paths minted a second `cus_…`). #81 makes the
 * create idempotent per org, so no NEW duplicates form — this reconciles the
 * historical ones.
 *
 * Per org with >1 customer:
 *   - Keeper rule: prefer the twin that has an email; else the newest created.
 *   - Each non-keeper ("loser") is deleted ONLY when it has zero activity:
 *     no mirrored PaymentIntents AND no live Stripe PaymentMethods. A loser with
 *     ANY activity is SKIPPED and reported (never silently deleted).
 *   - Delete is delete-at-Stripe (platform key) THEN tombstone the mirror via
 *     `recordApiSnapshot({deleted:true})` — same durable path as org-teardown, so
 *     boot re-projection / historical back-fill cannot resurrect it.
 *
 * Stripe delete is IRREVERSIBLE. Default is --dry-run (prints decisions, mutates
 * nothing). Pass --apply to execute.
 *
 *   npm run cleanup:dup-customers            # dry-run
 *   npm run cleanup:dup-customers -- --apply # execute
 */
import "dotenv/config";
import type Stripe from "stripe";
import { db } from "../src/db";
import { customers, paymentIntents } from "../src/db/schema";
import { eq } from "drizzle-orm";
import {
  getPlatformStripe,
  recordApiSnapshot,
} from "../src/lib/event-processor";
import { isResourceMissing } from "../src/lib/stripe-client";

const APPLY = process.argv.includes("--apply");

interface Row {
  id: string;
  orgId: string;
  email: string | null;
  livemode: string;
  created: number;
}

function pickKeeper(rows: Row[]): Row {
  // Prefer a twin with an email; tie-break on newest created, then id (stable).
  return [...rows].sort((a, b) => {
    const ae = a.email ? 1 : 0;
    const be = b.email ? 1 : 0;
    if (ae !== be) return be - ae; // email-bearing first
    if (a.created !== b.created) return b.created - a.created; // newest first
    return a.id < b.id ? -1 : 1;
  })[0];
}

async function loserHasActivity(
  stripe: Stripe | null,
  loserId: string
): Promise<{ active: boolean; reason: string }> {
  const piRows = await db
    .select({ id: paymentIntents.id })
    .from(paymentIntents)
    .where(eq(paymentIntents.customer, loserId));
  if (piRows.length > 0) {
    return { active: true, reason: `${piRows.length} mirrored payment_intents` };
  }
  // PMs are not mirrored — must check live Stripe (the safety net). Only
  // available with the platform key (--apply, in-env). In dry-run `stripe` is
  // null, so the PM check is deferred and reported as such.
  if (!stripe) {
    return { active: false, reason: "no PIs (live PM check deferred to --apply)" };
  }
  const pms = await stripe.paymentMethods.list({ customer: loserId, limit: 1 });
  if (pms.data.length > 0) {
    return { active: true, reason: "has attached Stripe payment_method(s)" };
  }
  return { active: false, reason: "no PIs, no PMs" };
}

async function main() {
  console.log(
    `\n=== duplicate-customer cleanup (${APPLY ? "APPLY" : "DRY-RUN"}) ===\n`
  );

  const all = await db
    .select({
      id: customers.id,
      orgId: customers.orgId,
      email: customers.email,
      livemode: customers.livemode,
      rawJson: customers.rawJson,
    })
    .from(customers);

  const byOrg = new Map<string, Row[]>();
  for (const c of all) {
    const created = Number(
      (c.rawJson as Record<string, unknown> | null)?.["created"] ?? 0
    );
    const row: Row = {
      id: c.id,
      orgId: c.orgId,
      email: c.email,
      livemode: c.livemode,
      created,
    };
    const arr = byOrg.get(c.orgId) ?? [];
    arr.push(row);
    byOrg.set(c.orgId, arr);
  }

  const dupOrgs = [...byOrg.entries()].filter(([, rows]) => rows.length > 1);
  if (dupOrgs.length === 0) {
    console.log("No orgs with duplicate customers. Nothing to do.\n");
    return;
  }

  // Platform Stripe client only when applying (needs KEY_SERVICE creds — in-env).
  const stripe = APPLY ? await getPlatformStripe() : null;
  let deleted = 0;
  let skipped = 0;

  for (const [orgId, rows] of dupOrgs) {
    const keeper = pickKeeper(rows);
    const losers = rows.filter((r) => r.id !== keeper.id);
    console.log(
      `org ${orgId}  KEEP ${keeper.id} (${keeper.email ?? "no-email"})`
    );

    for (const loser of losers) {
      const { active, reason } = await loserHasActivity(stripe, loser.id);
      if (active) {
        skipped++;
        console.log(`   SKIP ${loser.id} — ${reason} (manual review)`);
        continue;
      }
      if (!APPLY) {
        console.log(`   would DELETE ${loser.id} — ${reason}`);
        continue;
      }
      // Delete Stripe FIRST, then tombstone (same order as org-teardown so a
      // crash mid-op re-runs cleanly). resource_missing => already gone, ok.
      try {
        await stripe.customers.del(loser.id);
      } catch (err) {
        if (!isResourceMissing(err)) throw err;
      }
      const tombstone = {
        id: loser.id,
        deleted: true,
        livemode: loser.livemode === "true",
      };
      await recordApiSnapshot(tombstone, "customer", orgId);
      deleted++;
      console.log(`   DELETED ${loser.id} — ${reason}`);
    }
  }

  console.log(
    `\n=== ${APPLY ? "applied" : "dry-run"}: ${deleted} deleted, ${skipped} skipped, ${dupOrgs.length} orgs ===\n`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("cleanup failed:", err);
    process.exit(1);
  });
