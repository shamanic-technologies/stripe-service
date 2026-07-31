/**
 * One-off reconciliation: attach the provenance an invoiced charge ALREADY has
 * at Stripe to the PaymentIntent that consumers actually read.
 *
 * Between the off-session invoice route shipping (#89) and the fix that stamps
 * the PaymentIntent, the caller's metadata landed on the Invoice only: Stripe
 * copies nothing onto the PaymentIntent it creates to pay an invoice, and on our
 * API version that PaymentIntent carries no `invoice` back-reference either. So
 * those payments mirror as anonymous `succeeded` rows with empty metadata.
 *
 * This walks the mirrored PaymentIntents that have NO metadata, finds the
 * invoice that paid each one (`invoice.payments[].payment.payment_intent`, the
 * only link Stripe exposes), and copies THAT invoice's own metadata onto the
 * PaymentIntent — plus `invoice_id`. Nothing is invented: a PaymentIntent with
 * no invoice, or an invoice with no metadata of its own, is SKIPPED and
 * reported. A PaymentIntent that already carries metadata is never touched.
 *
 * Idempotent (re-running finds nothing left to do) and reversible in the sense
 * that every written key is either the invoice's own or the factual
 * `invoice_id`. Default is --dry-run; pass --apply to write.
 *
 *   npx tsx scripts/backfill-invoice-provenance.ts           # dry-run
 *   npx tsx scripts/backfill-invoice-provenance.ts --apply   # execute
 */
import "dotenv/config";
import type Stripe from "stripe";
import { db } from "../src/db";
import { paymentIntents } from "../src/db/schema";
import { isNull, or, sql } from "drizzle-orm";
import {
  getPlatformStripe,
  recordApiSnapshot,
} from "../src/lib/event-processor";
import {
  paymentIntentIdFromInvoice,
  paymentIntentProvenance,
} from "../src/lib/invoice-provenance";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  const stripe = await getPlatformStripe();

  // Mirrored payments with no provenance at all. A row whose metadata already
  // has keys (org_id from the Checkout path, type=auto_reload from the legacy
  // bare-PaymentIntent path) is out of scope by construction.
  const blanks = await db
    .select({
      id: paymentIntents.id,
      orgId: paymentIntents.orgId,
      customer: paymentIntents.customer,
    })
    .from(paymentIntents)
    .where(
      or(
        isNull(paymentIntents.metadata),
        sql`${paymentIntents.metadata}::jsonb = '{}'::jsonb`
      )
    );

  console.log(
    `[backfill] ${blanks.length} mirrored PaymentIntent(s) with no metadata${APPLY ? "" : " (dry-run)"}`
  );

  // Invoice -> PaymentIntent is only walkable in that direction, so build the
  // reverse map once per distinct customer rather than per payment.
  const byCustomer = new Map<string, typeof blanks>();
  let noCustomer = 0;
  for (const row of blanks) {
    if (!row.customer) {
      noCustomer += 1;
      continue;
    }
    const bucket = byCustomer.get(row.customer) ?? [];
    bucket.push(row);
    byCustomer.set(row.customer, bucket);
  }

  let stamped = 0;
  let noInvoice = 0;
  let invoiceHadNoMetadata = 0;

  for (const [customer, rows] of byCustomer) {
    const provenanceByPi = new Map<
      string,
      { invoiceId: string; metadata: Record<string, string> }
    >();

    for await (const invoice of stripe.invoices.list({
      customer,
      limit: 100,
      expand: ["data.payments"],
    })) {
      const piId = paymentIntentIdFromInvoice(invoice);
      const invoiceId = invoice.id;
      if (!piId || !invoiceId) continue;
      provenanceByPi.set(piId, {
        invoiceId,
        metadata: (invoice.metadata ?? {}) as Record<string, string>,
      });
    }

    for (const row of rows) {
      const found = provenanceByPi.get(row.id);
      if (!found) {
        noInvoice += 1;
        console.log(`[backfill] SKIP ${row.id} — no invoice references it`);
        continue;
      }
      if (Object.keys(found.metadata).length === 0) {
        invoiceHadNoMetadata += 1;
        console.log(
          `[backfill] SKIP ${row.id} — invoice ${found.invoiceId} carries no metadata of its own`
        );
        continue;
      }

      const metadata = paymentIntentProvenance(
        found.metadata,
        found.invoiceId
      );
      console.log(
        `[backfill] ${APPLY ? "STAMP" : "WOULD STAMP"} ${row.id} <- ${found.invoiceId} ${JSON.stringify(metadata)}`
      );

      if (APPLY) {
        const pi: Stripe.PaymentIntent = await stripe.paymentIntents.update(
          row.id,
          { metadata }
        );
        await recordApiSnapshot(pi, "payment_intent", row.orgId);
      }
      stamped += 1;
    }
  }

  console.log(
    `[backfill] done — ${APPLY ? "stamped" : "would stamp"} ${stamped}, skipped ${noInvoice} (no invoice) + ${invoiceHadNoMetadata} (invoice had no metadata) + ${noCustomer} (no customer on the mirror row)`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  });
