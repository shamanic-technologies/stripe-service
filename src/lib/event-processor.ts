import crypto from "crypto";
import type Stripe from "stripe";
import { db } from "../db";
import {
  events,
  customers,
  checkoutSessions,
  paymentIntents,
  refunds,
  disputes,
} from "../db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { resolvePlatformKey } from "./key-client";
import { makeStripeClient } from "./stripe-client";
import { promoteDefaultPaymentMethod } from "./promote-default-pm";
import { declareFeesForEvent, isFeeEvent } from "./declare-fees";
import {
  isChargeRefundEvent,
  mirrorRefundsForChargeEvent,
} from "./mirror-charge-refunds";

type ProcessSource = "webhook" | "poll";
type EventSource = ProcessSource | "api";
export type ObjectKind =
  | "customer"
  | "payment_intent"
  | "checkout_session"
  | "refund"
  | "dispute";

// Kinds whose silver row carries no `org_id` of its own — the org is resolved
// by joining through the referenced PaymentIntent. `orgId` is ignored for them.
const ORGLESS_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>([
  "refund",
  "dispute",
]);

// Lazy module-cached platform Stripe client for webhook-triggered side-effects.
// Same pattern as the webhook secret cache in routes/webhooks.ts — the
// platform key is static per environment.
let cachedPlatformStripe: Stripe | null = null;
export async function getPlatformStripe(): Promise<Stripe> {
  if (cachedPlatformStripe) return cachedPlatformStripe;
  const { key } = await resolvePlatformKey("stripe", {
    method: "INTERNAL",
    path: "/lib/event-processor",
  });
  cachedPlatformStripe = makeStripeClient(key);
  return cachedPlatformStripe;
}

/**
 * Insert event idempotently. After insert, project the referenced object's
 * silver row from the latest bronze event (race-safe). Side-effects run only
 * for real Stripe events (`source ∈ {webhook, poll}`), never for synthetic
 * api_snapshot events.
 *
 * Returns true if the event was processed (newly inserted), false if it was
 * already known.
 */
export async function processEvent(
  event: Stripe.Event,
  source: ProcessSource
): Promise<boolean> {
  const objectId = extractObjectId(event);

  const inserted = await db
    .insert(events)
    .values({
      id: event.id,
      type: event.type,
      apiVersion: event.api_version ?? null,
      livemode: event.livemode ? "true" : "false",
      createdStripe: event.created,
      objectId,
      payload: event as unknown as Record<string, unknown>,
      source,
    })
    .onConflictDoNothing()
    .returning({ id: events.id });

  if (inserted.length === 0) {
    return false;
  }

  if (objectId) {
    const orgId = await resolveOrgIdForEvent(event, objectId);
    await projectSilverFromBronze(objectId, orgId);
  }
  await runSideEffects(event);
  return true;
}

async function runSideEffects(event: Stripe.Event): Promise<void> {
  if (
    event.type === "checkout.session.completed" ||
    event.type === "setup_intent.succeeded"
  ) {
    const stripe = await getPlatformStripe();
    await promoteDefaultPaymentMethod(event, stripe);
  }

  if (isChargeRefundEvent(event.type)) {
    const stripe = await getPlatformStripe();
    await mirrorRefundsForChargeEvent(event, stripe);
  }

  if (isFeeEvent(event.type)) {
    const stripe = await getPlatformStripe();
    await declareFeesForEvent(event, stripe);
  }
}

function extractObjectId(event: Stripe.Event): string | null {
  const obj = event.data?.object as { id?: unknown } | undefined;
  if (obj && typeof obj.id === "string") return obj.id;
  return null;
}

/**
 * Stripe's own `object` discriminator → the silver table it projects into.
 * This is the AUTHORITATIVE routing key: every Stripe object states its type in
 * `data.object.object`, and that string is stable across payment rails.
 */
const OBJECT_TYPE_TO_KIND: Readonly<Record<string, ObjectKind>> = {
  customer: "customer",
  payment_intent: "payment_intent",
  "checkout.session": "checkout_session",
  refund: "refund",
  dispute: "dispute",
};

/**
 * Id-prefix fallback, used ONLY when a payload carries no `object` field (old
 * hand-written fixtures, a truncated payload). Note the two prefixes Stripe
 * uses for one and the same object type — `re_` for a refund of a card charge,
 * `pyr_` for a refund of a non-card payment (Link, bank debits). Routing on the
 * prefix alone is what dropped every Link refund on the floor (#100); this map
 * exists as a safety net, not as the primary path.
 */
const ID_PREFIX_TO_KIND: ReadonlyArray<readonly [string, ObjectKind]> = [
  ["cus_", "customer"],
  ["pi_", "payment_intent"],
  ["cs_", "checkout_session"],
  ["re_", "refund"],
  ["pyr_", "refund"],
  ["dp_", "dispute"],
  ["du_", "dispute"],
];

/**
 * Stripe object types we knowingly do not mirror. Listing them explicitly is
 * what lets an object type we have NEVER seen be logged loudly instead of
 * dropped in silence — the failure mode of #100.
 */
const UNMIRRORED_OBJECT_TYPES: ReadonlySet<string> = new Set([
  "account",
  "application",
  "balance",
  "billing_portal.configuration",
  "billing_portal.session",
  "capability",
  "card",
  "charge",
  "coupon",
  "credit_note",
  "customer_balance_transaction",
  "invoice",
  "invoice_payment",
  "invoiceitem",
  "mandate",
  "payment_link",
  "payment_method",
  "payout",
  "person",
  "plan",
  "price",
  "product",
  "promotion_code",
  "quote",
  "review",
  "setup_intent",
  "source",
  "subscription",
  "subscription_item",
  "subscription_schedule",
  "tax_rate",
  "topup",
  "transfer",
]);

/**
 * Route a bronze payload object to its silver table.
 *
 * `object.object` first — Stripe states the type authoritatively on every
 * object, and it does not vary with the payment rail. The id prefix does: a
 * Refund is `re_…` on a card charge and `pyr_…` on a Link payment, which is
 * exactly how Link refunds went unmirrored while card refunds worked.
 */
export function detectObjectKind(
  obj: unknown,
  objectId: string
): ObjectKind | null {
  const objectType = (obj as { object?: unknown } | null | undefined)?.object;
  if (typeof objectType === "string") {
    return OBJECT_TYPE_TO_KIND[objectType] ?? null;
  }
  for (const [prefix, kind] of ID_PREFIX_TO_KIND) {
    if (objectId.startsWith(prefix)) return kind;
  }
  return null;
}

/**
 * An object we could not route. Known-unmirrored Stripe types are a documented
 * decision and stay quiet; anything else is logged loudly, because a silently
 * dropped object is money we stop seeing.
 */
function reportUnroutable(objectId: string, obj: unknown): string {
  const objectType = (obj as { object?: unknown } | null | undefined)?.object;
  const label = typeof objectType === "string" ? objectType : "<no object field>";
  if (!UNMIRRORED_OBJECT_TYPES.has(label)) {
    console.warn(
      `[stripe-service] Unroutable Stripe object — not mirrored: object='${label}' id='${objectId}'. ` +
        `Add it to OBJECT_TYPE_TO_KIND (mirror it) or UNMIRRORED_OBJECT_TYPES (deliberately skip it).`
    );
  }
  return label;
}

/**
 * Synthesize a bronze "api_snapshot" event from a Stripe API response and
 * insert it into the events ledger. Mirrors the Stripe event shape:
 * `{ id, type, created, data: { object } }`. Used by API-response paths
 * (POST create, GET fallback, backfill, customer.update side-effects).
 *
 * `created_stripe` is set to current server time in seconds. A real webhook
 * arriving later with a higher `event.created` will dominate via the
 * projection's `ORDER BY created_stripe DESC` ordering. Side-effects do NOT
 * fire for `api_snapshot.*` types — those are caller-initiated observations,
 * not external state transitions.
 */
export async function insertSyntheticEvent(
  stripeObject: { id: string; livemode?: boolean },
  kind: ObjectKind
): Promise<void> {
  const id = `api_${crypto.randomUUID()}`;
  const createdSeconds = Math.floor(Date.now() / 1000);
  const type = `api_snapshot.${kind}`;
  // Not every Stripe object carries `livemode` (a Refund does not). Record null
  // rather than defaulting a live object to "false".
  const livemode =
    typeof stripeObject.livemode === "boolean" ? stripeObject.livemode : null;
  const payload = {
    id,
    type,
    api_version: null,
    livemode,
    created: createdSeconds,
    data: { object: stripeObject as unknown as Record<string, unknown> },
  };
  await db.insert(events).values({
    id,
    type,
    apiVersion: null,
    livemode: livemode === null ? null : livemode ? "true" : "false",
    createdStripe: createdSeconds,
    objectId: stripeObject.id,
    payload: payload as unknown as Record<string, unknown>,
    source: "api" satisfies EventSource,
  });
}

/**
 * Insert a synthetic event for a Stripe API response AND immediately project
 * silver. Default entry point for API-response code paths.
 */
export async function recordApiSnapshot(
  stripeObject: { id: string; livemode?: boolean },
  kind: ObjectKind,
  orgId: string | null
): Promise<void> {
  await insertSyntheticEvent(stripeObject, kind);
  await projectSilverFromBronze(stripeObject.id, orgId);
}

/**
 * Project silver from the latest bronze event for an object_id. Ordered by
 * `events.created_stripe DESC, received_at DESC` so the freshest snapshot
 * wins regardless of webhook arrival order.
 *
 * Race-safe by construction: Stripe `event.created` is strictly monotonic per
 * object across state transitions (`payment_intent.created` < `succeeded`).
 * Out-of-order delivery can no longer clobber silver.
 */
export async function projectSilverFromBronze(
  objectId: string,
  orgId: string | null
): Promise<void> {
  const obj = await latestBronzeObject(objectId);
  if (!obj) return;
  await projectBronzeObject(objectId, obj, orgId);
}

/**
 * The freshest bronze snapshot of an object, or null when we hold none.
 * Ordered by `created_stripe DESC, received_at DESC` — see the projection
 * contract above.
 */
async function latestBronzeObject(objectId: string): Promise<object | null> {
  const rows = await db
    .select({ payload: events.payload })
    .from(events)
    .where(eq(events.objectId, objectId))
    .orderBy(desc(events.createdStripe), desc(events.receivedAt))
    .limit(1);

  if (rows.length === 0) return null;
  const payload = rows[0].payload as { data?: { object?: unknown } } | null;
  const obj = payload?.data?.object;
  if (!obj || typeof obj !== "object") return null;
  return obj;
}

/**
 * Route one already-read bronze object into its silver table. Split out of
 * `projectSilverFromBronze` so the boot repair can reuse a payload it has
 * already fetched — and so kind detection always sees the payload, never just
 * the id.
 */
async function projectBronzeObject(
  objectId: string,
  obj: object,
  orgId: string | null
): Promise<void> {
  const kind = detectObjectKind(obj, objectId);
  if (!kind) {
    reportUnroutable(objectId, obj);
    return;
  }

  // Only refund/dispute silver is org-less (it joins through the PaymentIntent).
  // For every other kind an absent org would silently mis-tenant the row.
  if (orgId === null && !ORGLESS_KINDS.has(kind)) {
    throw new Error(
      `[stripe-service] projectSilverFromBronze: orgId is required for kind '${kind}' (${objectId})`
    );
  }

  if (kind === "refund") {
    await upsertRefund(obj as Stripe.Refund);
    return;
  }
  if (kind === "dispute") {
    await upsertDispute(obj as Stripe.Dispute);
    return;
  }

  // Every remaining kind is org-tenanted; the guard at the top proved orgId is set.
  const tenantOrgId = orgId as string;

  if (kind === "customer") {
    const customer = obj as Stripe.Customer | Stripe.DeletedCustomer;
    if ((customer as Stripe.DeletedCustomer).deleted) {
      await db.delete(customers).where(eq(customers.id, customer.id!));
      return;
    }
    await upsertCustomer(customer as Stripe.Customer, tenantOrgId);
  } else if (kind === "payment_intent") {
    await upsertPaymentIntent(obj as Stripe.PaymentIntent, tenantOrgId);
  } else if (kind === "checkout_session") {
    await upsertCheckoutSession(obj as Stripe.Checkout.Session, tenantOrgId);
  }
}

/**
 * One-time repair: re-project every distinct object_id's silver row from
 * the latest bronze event. Bounded by `COUNT(DISTINCT object_id) FROM events`.
 * Idempotent. Runs at boot to heal any rows clobbered by out-of-order webhook
 * arrivals before the projection refactor landed.
 */
export async function repairAllSilverFromBronze(): Promise<void> {
  const startedAt = Date.now();
  const rows = await db
    .selectDistinct({ objectId: events.objectId })
    .from(events)
    .where(sql`${events.objectId} IS NOT NULL`);

  let repaired = 0;
  let skipped = 0;
  // Object types we walked past, counted so a boot log states exactly what was
  // NOT mirrored rather than leaving it to be inferred from a total.
  const skippedByType = new Map<string, number>();
  for (const row of rows) {
    const objectId = row.objectId;
    if (!objectId) {
      skipped += 1;
      continue;
    }
    const obj = await latestBronzeObject(objectId);
    if (!obj) {
      skipped += 1;
      continue;
    }
    const kind = detectObjectKind(obj, objectId);
    if (!kind) {
      const label = reportUnroutable(objectId, obj);
      skippedByType.set(label, (skippedByType.get(label) ?? 0) + 1);
      skipped += 1;
      continue;
    }
    const orgId = await resolveOrgIdForRepair(objectId, kind, obj);
    await projectBronzeObject(objectId, obj, orgId);
    repaired += 1;
  }

  const durMs = Date.now() - startedAt;
  const skippedDetail = [...skippedByType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}=${count}`)
    .join(", ");
  console.log(
    `[stripe-service] Silver repair from bronze complete: repaired=${repaired}, skipped=${skipped}, duration_ms=${durMs}` +
      (skippedDetail ? `, skipped_object_types: ${skippedDetail}` : "")
  );
}

async function resolveOrgIdForRepair(
  objectId: string,
  kind: ObjectKind,
  latestObject: object
): Promise<string | null> {
  // Refund/dispute silver has no org column — nothing to resolve.
  if (ORGLESS_KINDS.has(kind)) return null;

  if (kind === "customer") {
    const r = await db
      .select({ orgId: customers.orgId })
      .from(customers)
      .where(eq(customers.id, objectId))
      .limit(1);
    if (r.length > 0 && r[0].orgId) return r[0].orgId;
  } else if (kind === "payment_intent") {
    const r = await db
      .select({ orgId: paymentIntents.orgId })
      .from(paymentIntents)
      .where(eq(paymentIntents.id, objectId))
      .limit(1);
    if (r.length > 0 && r[0].orgId) return r[0].orgId;
  } else if (kind === "checkout_session") {
    const r = await db
      .select({ orgId: checkoutSessions.orgId })
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, objectId))
      .limit(1);
    if (r.length > 0 && r[0].orgId) return r[0].orgId;
  }

  // Fallback: derive from the latest bronze payload's metadata / customer mirror.
  const obj = latestObject as {
    metadata?: Stripe.Metadata;
    customer?: string | { id: string };
  };
  const metadataOrgId = extractOrgId(obj.metadata);
  const customerId = extractString(obj.customer);
  return resolveOrgId(metadataOrgId, customerId);
}

async function resolveOrgIdForEvent(
  event: Stripe.Event,
  objectId: string
): Promise<string> {
  const obj = event.data?.object as
    | { metadata?: Stripe.Metadata; customer?: unknown }
    | undefined;
  const metadataOrgId = extractOrgId(obj?.metadata);
  if (metadataOrgId) return metadataOrgId;

  if (event.type.startsWith("customer.")) {
    // For customer.* events the object_id IS the customer id.
    return resolveOrgId(null, objectId);
  }
  const customerId = extractString(
    (obj as { customer?: string | { id: string } } | undefined)?.customer
  );
  return resolveOrgId(metadataOrgId, customerId);
}

export function extractOrgId(
  metadata: Stripe.Metadata | null | undefined
): string | null {
  if (!metadata) return null;
  const v = metadata.org_id ?? metadata.orgId;
  return typeof v === "string" ? v : null;
}

/**
 * Resolve org_id with customer-mirror fallback.
 *
 * Historical PaymentIntents and CheckoutSessions created before stripe-service
 * stamped `metadata.org_id` (or created server-side via Checkout where Stripe
 * does not propagate PI metadata) have no usable org_id on the object itself.
 * Their customer, however, does — so fall back to `customers.org_id` via the
 * local mirror. Returns "unknown" only when both sources are empty.
 */
export async function resolveOrgId(
  metadataOrgId: string | null,
  customerId: string | null
): Promise<string> {
  if (metadataOrgId) return metadataOrgId;
  if (!customerId) return "unknown";
  const rows = await db
    .select({ orgId: customers.orgId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (rows.length > 0 && rows[0].orgId) return rows[0].orgId;
  return "unknown";
}

// Silver upsert helpers. Exported for tests only — production callers MUST go
// through `projectSilverFromBronze` (which reads the latest bronze event) or
// `recordApiSnapshot` (which writes bronze then projects). Direct calls bypass
// the race guarantee.
export async function upsertCustomer(
  customer: Stripe.Customer,
  orgId: string
): Promise<void> {
  // Stripe `customer.balance` is contaminated by legacy `usage_applied` CBTs
  // written pre-#104; it no longer represents a pure prepaid credit balance.
  // Strip it on write so no downstream consumer can read the polluted value.
  const sanitizedRawJson = { ...(customer as unknown as Record<string, unknown>) };
  delete sanitizedRawJson.balance;

  await db
    .insert(customers)
    .values({
      id: customer.id,
      orgId,
      email: customer.email ?? null,
      name: customer.name ?? null,
      description: customer.description ?? null,
      phone: customer.phone ?? null,
      metadata: (customer.metadata ?? null) as unknown as Record<string, unknown> | null,
      livemode: customer.livemode ? "true" : "false",
      createdStripe: customer.created,
      rawJson: sanitizedRawJson,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: customers.id,
      set: {
        orgId: sql`EXCLUDED.org_id`,
        email: sql`EXCLUDED.email`,
        name: sql`EXCLUDED.name`,
        description: sql`EXCLUDED.description`,
        phone: sql`EXCLUDED.phone`,
        metadata: sql`EXCLUDED.metadata`,
        livemode: sql`EXCLUDED.livemode`,
        createdStripe: sql`EXCLUDED.created_stripe`,
        rawJson: sql`EXCLUDED.raw_json`,
        syncedAt: sql`now()`,
      },
    });
}

export async function upsertCheckoutSession(
  session: Stripe.Checkout.Session,
  orgId: string
): Promise<void> {
  await db
    .insert(checkoutSessions)
    .values({
      id: session.id,
      orgId,
      customer: extractString(session.customer),
      paymentIntent: extractString(session.payment_intent),
      mode: session.mode,
      status: session.status ?? null,
      paymentStatus: session.payment_status ?? null,
      amountTotal: session.amount_total ?? null,
      currency: session.currency ?? null,
      url: session.url ?? null,
      successUrl: session.success_url ?? null,
      cancelUrl: session.cancel_url ?? null,
      metadata: (session.metadata ?? null) as unknown as Record<string, unknown> | null,
      livemode: session.livemode ? "true" : "false",
      createdStripe: session.created,
      rawJson: session as unknown as Record<string, unknown>,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: checkoutSessions.id,
      set: {
        orgId: sql`EXCLUDED.org_id`,
        customer: sql`EXCLUDED.customer`,
        paymentIntent: sql`EXCLUDED.payment_intent`,
        mode: sql`EXCLUDED.mode`,
        status: sql`EXCLUDED.status`,
        paymentStatus: sql`EXCLUDED.payment_status`,
        amountTotal: sql`EXCLUDED.amount_total`,
        currency: sql`EXCLUDED.currency`,
        url: sql`EXCLUDED.url`,
        successUrl: sql`EXCLUDED.success_url`,
        cancelUrl: sql`EXCLUDED.cancel_url`,
        metadata: sql`EXCLUDED.metadata`,
        livemode: sql`EXCLUDED.livemode`,
        createdStripe: sql`EXCLUDED.created_stripe`,
        rawJson: sql`EXCLUDED.raw_json`,
        syncedAt: sql`now()`,
      },
    });
}

export async function upsertPaymentIntent(
  pi: Stripe.PaymentIntent,
  orgId: string
): Promise<void> {
  await db
    .insert(paymentIntents)
    .values({
      id: pi.id,
      orgId,
      customer: extractString(pi.customer),
      amount: pi.amount,
      amountReceived: pi.amount_received ?? null,
      currency: pi.currency,
      status: pi.status,
      description: pi.description ?? null,
      paymentMethod: extractString(pi.payment_method),
      latestCharge: extractString(pi.latest_charge),
      clientSecret: pi.client_secret ?? null,
      metadata: (pi.metadata ?? null) as unknown as Record<string, unknown> | null,
      lastPaymentError: (pi.last_payment_error ?? null) as unknown as
        | Record<string, unknown>
        | null,
      livemode: pi.livemode ? "true" : "false",
      createdStripe: pi.created,
      rawJson: pi as unknown as Record<string, unknown>,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: paymentIntents.id,
      set: {
        orgId: sql`EXCLUDED.org_id`,
        customer: sql`EXCLUDED.customer`,
        amount: sql`EXCLUDED.amount`,
        amountReceived: sql`EXCLUDED.amount_received`,
        currency: sql`EXCLUDED.currency`,
        status: sql`EXCLUDED.status`,
        description: sql`EXCLUDED.description`,
        paymentMethod: sql`EXCLUDED.payment_method`,
        latestCharge: sql`EXCLUDED.latest_charge`,
        clientSecret: sql`EXCLUDED.client_secret`,
        metadata: sql`EXCLUDED.metadata`,
        lastPaymentError: sql`EXCLUDED.last_payment_error`,
        livemode: sql`EXCLUDED.livemode`,
        createdStripe: sql`EXCLUDED.created_stripe`,
        rawJson: sql`EXCLUDED.raw_json`,
        syncedAt: sql`now()`,
      },
    });
}

/**
 * Silver upsert for a Stripe Refund. Org-less by design: the tenant is resolved
 * by joining `payment_intent` (or `charge`) back to the PaymentIntent mirror.
 * `status` is stored verbatim so a refund that later fails/cancels stops
 * counting as returned money on the very next projection — no accumulator to
 * unwind.
 */
export async function upsertRefund(refund: Stripe.Refund): Promise<void> {
  await db
    .insert(refunds)
    .values({
      id: refund.id,
      paymentIntent: extractString(refund.payment_intent),
      charge: extractString(refund.charge),
      amount: refund.amount,
      currency: refund.currency,
      status: refund.status ?? null,
      reason: refund.reason ?? null,
      createdStripe: refund.created,
      rawJson: refund as unknown as Record<string, unknown>,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: refunds.id,
      set: {
        paymentIntent: sql`EXCLUDED.payment_intent`,
        charge: sql`EXCLUDED.charge`,
        amount: sql`EXCLUDED.amount`,
        currency: sql`EXCLUDED.currency`,
        status: sql`EXCLUDED.status`,
        reason: sql`EXCLUDED.reason`,
        createdStripe: sql`EXCLUDED.created_stripe`,
        rawJson: sql`EXCLUDED.raw_json`,
        syncedAt: sql`now()`,
      },
    });
}

/**
 * Silver upsert for a Stripe Dispute. Org-less for the same reason as refunds.
 * Only `status = 'lost'` is money gone; storing the live status means a dispute
 * that flips won<->lost re-prices itself with no manual reconciliation.
 */
export async function upsertDispute(dispute: Stripe.Dispute): Promise<void> {
  await db
    .insert(disputes)
    .values({
      id: dispute.id,
      paymentIntent: extractString(dispute.payment_intent),
      charge: extractString(dispute.charge),
      amount: dispute.amount,
      currency: dispute.currency,
      status: dispute.status ?? null,
      reason: dispute.reason ?? null,
      livemode: dispute.livemode ? "true" : "false",
      createdStripe: dispute.created,
      rawJson: dispute as unknown as Record<string, unknown>,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: disputes.id,
      set: {
        paymentIntent: sql`EXCLUDED.payment_intent`,
        charge: sql`EXCLUDED.charge`,
        amount: sql`EXCLUDED.amount`,
        currency: sql`EXCLUDED.currency`,
        status: sql`EXCLUDED.status`,
        reason: sql`EXCLUDED.reason`,
        livemode: sql`EXCLUDED.livemode`,
        createdStripe: sql`EXCLUDED.created_stripe`,
        rawJson: sql`EXCLUDED.raw_json`,
        syncedAt: sql`now()`,
      },
    });
}

export function extractString(
  v: string | { id?: string } | null | undefined
): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  return v.id ?? null;
}
