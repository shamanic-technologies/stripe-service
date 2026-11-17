/**
 * One-off repair (ETHAN-STAFF-CHECKOUT-1118): every Stripe customer takes the
 * identity (email + name) of the LAST person who completed a checkout on it.
 *
 * Before this ship only the EMAIL followed the payer, and only on success, so
 * a customer created by staff kept the staff member's NAME forever (prod
 * 2026-11-17: Ethan's customer still named "Kevin Lourd" after he paid).
 *
 * Source of "who paid last": the mirrored checkout sessions' own
 * `payer_user_id` (status `complete`), the same evidence the live side-effect
 * reads. A customer no checkout ever completed on is left alone.
 *
 *   npx tsx scripts/backfill-payer-identity.ts           # dry-run (default)
 *   npx tsx scripts/backfill-payer-identity.ts --apply   # write to Stripe + mirror
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { getPlatformStripe } from "../src/lib/event-processor";
import { getUserById, joinName } from "../src/lib/client-service-client";
import { makeCustomerThePerson } from "../src/lib/payer-email";

const APPLY = process.argv.includes("--apply");

interface Row {
  customer_id: string;
  org_id: string;
  email: string | null;
  name: string | null;
  payer: string;
}

async function main(): Promise<void> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (cs.customer)
      cs.customer AS customer_id, c.org_id, c.email, c.name,
      cs.metadata->>'payer_user_id' AS payer
    FROM checkout_sessions cs
    JOIN customers c ON c.id = cs.customer
    WHERE cs.status = 'complete' AND cs.metadata->>'payer_user_id' IS NOT NULL
    ORDER BY cs.customer, cs.created_stripe DESC
  `);
  const rows = (result as unknown as { rows: Row[] }).rows;
  console.log(`${rows.length} customers have a completed checkout with a named payer`);

  const stripe = APPLY ? await getPlatformStripe() : null;
  let differ = 0;
  for (const r of rows) {
    const who = await getUserById(r.payer);
    if (!who?.email) {
      console.log(`skip ${r.customer_id} (org ${r.org_id}): payer ${r.payer} has no email on record`);
      continue;
    }
    const name = joinName(who);
    const emailDiffers = (r.email ?? "").toLowerCase() !== who.email.toLowerCase();
    const nameDiffers = name !== null ? name !== r.name : emailDiffers && !!r.name;
    if (!emailDiffers && !nameDiffers) continue;
    differ++;
    console.log(
      `${APPLY ? "fix" : "would fix"} ${r.customer_id} (org ${r.org_id}): ` +
        `${r.email ?? "-"} / ${r.name ?? "-"}  ->  ${who.email} / ${name ?? "(no name)"}`
    );
    if (stripe) await makeCustomerThePerson(stripe, r.customer_id, r.payer, "was the last payer (backfill)");
  }
  console.log(`${differ} customer(s) ${APPLY ? "fixed" : "would change"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
