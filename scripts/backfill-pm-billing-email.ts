/**
 * One-off repair (BILLING-LINK-PAYMENT-METHOD-1118): no saved payment method
 * keeps a STAFF email in its billing details. For EVERY customer in the mirror
 * (all orgs), every attached card and Link method whose `billing_details.email`
 * is staff, on a customer whose own email is NOT staff, takes the customer's
 * email (the payer, per payer-email.ts). Name/address untouched. The live side
 * of the same rule runs on each payment / saved card (src/lib/pm-billing-email.ts).
 *
 * Reads Stripe in both modes (the customer's live email and its methods);
 * writes only with --apply.
 *
 *   npx tsx scripts/backfill-pm-billing-email.ts           # dry-run (default)
 *   npx tsx scripts/backfill-pm-billing-email.ts --apply   # write to Stripe
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { getPlatformStripe } from "../src/lib/event-processor";
import { alignPaymentMethodEmails } from "../src/lib/pm-billing-email";

const APPLY = process.argv.includes("--apply");

interface Row {
  id: string;
  org_id: string;
}

function isMissing(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  return e?.code === "resource_missing" || e?.statusCode === 404;
}

async function main(): Promise<void> {
  const result = await db.execute(sql`SELECT id, org_id FROM customers ORDER BY org_id, id`);
  const rows = (result as unknown as { rows: Row[] }).rows;
  console.log(`${rows.length} customers in the mirror (${APPLY ? "APPLY" : "dry-run"})`);

  const stripe = await getPlatformStripe();
  let changed = 0;
  let missing = 0;
  for (const r of rows) {
    let changes;
    try {
      changes = await alignPaymentMethodEmails(stripe, r.id, { apply: APPLY });
    } catch (err) {
      if (!isMissing(err)) throw err;
      missing++;
      console.log(`skip ${r.id} (org ${r.org_id}): not found in Stripe`);
      continue;
    }
    for (const c of changes) {
      changed++;
      console.log(`${APPLY ? "fixed" : "would fix"} ${c.paymentMethodId} [${c.type}] (org ${r.org_id}, ${c.customerId}) ${c.from} -> ${c.to}`);
    }
  }
  console.log(`${changed} payment method(s) ${APPLY ? "fixed" : "would change"}; ${missing} customer(s) not found in Stripe`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
