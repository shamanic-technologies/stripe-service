import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  jsonb,
  bigint,
  uuid,
} from "drizzle-orm/pg-core";

// ===== Stripe-shape mirror tables =====
// PK = Stripe ID (cus_..., pi_..., cs_..., evt_...).
// raw_json holds unmapped fields. synced_at = last upsert time (webhook or write-back).

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(), // cus_...
    orgId: text("org_id").notNull(),
    email: text("email"),
    name: text("name"),
    description: text("description"),
    phone: text("phone"),
    metadata: jsonb("metadata"),
    livemode: text("livemode"),
    createdStripe: bigint("created_stripe", { mode: "number" }),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_customers_org_id").on(table.orgId),
    index("idx_customers_email").on(table.email),
  ]
);

export const checkoutSessions = pgTable(
  "checkout_sessions",
  {
    id: text("id").primaryKey(), // cs_...
    orgId: text("org_id").notNull(),
    customer: text("customer"),
    paymentIntent: text("payment_intent"),
    mode: text("mode"),
    status: text("status"),
    paymentStatus: text("payment_status"),
    amountTotal: bigint("amount_total", { mode: "number" }),
    currency: text("currency"),
    url: text("url"),
    successUrl: text("success_url"),
    cancelUrl: text("cancel_url"),
    metadata: jsonb("metadata"),
    livemode: text("livemode"),
    createdStripe: bigint("created_stripe", { mode: "number" }),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_checkout_sessions_org_id").on(table.orgId),
    index("idx_checkout_sessions_customer").on(table.customer),
    index("idx_checkout_sessions_payment_intent").on(table.paymentIntent),
  ]
);

export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: text("id").primaryKey(), // pi_...
    orgId: text("org_id").notNull(),
    customer: text("customer"),
    amount: bigint("amount", { mode: "number" }).notNull(),
    amountReceived: bigint("amount_received", { mode: "number" }),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
    description: text("description"),
    paymentMethod: text("payment_method"),
    latestCharge: text("latest_charge"),
    clientSecret: text("client_secret"),
    metadata: jsonb("metadata"),
    lastPaymentError: jsonb("last_payment_error"),
    livemode: text("livemode"),
    createdStripe: bigint("created_stripe", { mode: "number" }),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_payment_intents_org_id").on(table.orgId),
    index("idx_payment_intents_customer").on(table.customer),
    index("idx_payment_intents_status").on(table.status),
    // Refunds/disputes reference the charge when Stripe leaves their
    // `payment_intent` null; this index backs that fallback attribution.
    index("idx_payment_intents_latest_charge").on(table.latestCharge),
  ]
);

// ===== Money-returned mirrors =====
// Stripe never mutates the original payment when money goes back out: the
// PaymentIntent stays `succeeded` for its full `amount_received` forever, and
// the return lives on a SEPARATE object (a Refund, or a lost Dispute). These
// two tables mirror those objects so "how much of this payment came back" is a
// QUERY over current object state, never a hand-maintained accumulator.
//
// Deliberately NO `org_id` column: the org lives on the referenced
// PaymentIntent row and is resolved by joining through it. One home for the
// mapping means these rows can never drift out of sync with it, and a refund
// whose PaymentIntent is mirrored later starts attributing automatically.

// Stripe Refund (re_...). Money returned to the customer on our initiative.
// `status` is the source of truth for whether the money actually left:
// only `succeeded` counts. A refund that later fails or is canceled flips its
// own status, so it drops out of every sum by construction.
export const refunds = pgTable(
  "refunds",
  {
    id: text("id").primaryKey(), // re_...
    paymentIntent: text("payment_intent"),
    charge: text("charge"),
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    // pending | requires_action | succeeded | failed | canceled
    status: text("status"),
    reason: text("reason"),
    // NB: no `livemode` — the Stripe Refund object does not carry one, and
    // inventing a value would be a lie. Use the referenced PaymentIntent's.
    createdStripe: bigint("created_stripe", { mode: "number" }),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_refunds_payment_intent").on(table.paymentIntent),
    index("idx_refunds_charge").on(table.charge),
    index("idx_refunds_status").on(table.status),
  ]
);

// Stripe Dispute (dp_...). Money pulled back by the cardholder's bank. Only a
// dispute we ultimately LOSE is money gone (same as a refund); `won` and the
// `*_closed` outcomes leave the funds with us. Again the object's own `status`
// decides, so a dispute that flips won->lost (or the reverse) re-projects and
// every sum follows automatically.
export const disputes = pgTable(
  "disputes",
  {
    id: text("id").primaryKey(), // dp_...
    paymentIntent: text("payment_intent"),
    charge: text("charge"),
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    // warning_needs_response | warning_under_review | warning_closed |
    // needs_response | under_review | won | lost
    status: text("status"),
    reason: text("reason"),
    livemode: text("livemode"),
    createdStripe: bigint("created_stripe", { mode: "number" }),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_disputes_payment_intent").on(table.paymentIntent),
    index("idx_disputes_charge").on(table.charge),
    index("idx_disputes_status").on(table.status),
  ]
);

// Append-only webhook event ledger. Idempotent: PK is Stripe event ID.
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(), // evt_...
    type: text("type").notNull(),
    apiVersion: text("api_version"),
    livemode: text("livemode"),
    createdStripe: bigint("created_stripe", { mode: "number" }),
    objectId: text("object_id"), // e.g. cus_..., pi_..., cs_... referenced by the event
    payload: jsonb("payload").notNull(),
    source: text("source").notNull(), // "webhook" | "poll"
    receivedAt: timestamp("received_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_events_type").on(table.type),
    index("idx_events_object_id").on(table.objectId),
    index("idx_events_received_at").on(table.receivedAt),
  ]
);

// Cursor for reconciliation poller. Single row.
export const eventSyncCursor = pgTable("event_sync_cursor", {
  id: integer("id").primaryKey(), // always 1
  lastEventId: text("last_event_id"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow().notNull(),
});

// Audit log of API calls into stripe-service. Identity headers logged when present.
export const apiCallLog = pgTable(
  "api_call_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    statusCode: integer("status_code"),
    orgId: text("org_id"),
    userId: text("user_id"),
    brandId: text("brand_id"),
    campaignId: text("campaign_id"),
    workflowSlug: text("workflow_slug"),
    stripeObjectId: text("stripe_object_id"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_api_call_log_org_id_created").on(table.orgId, table.createdAt),
    index("idx_api_call_log_stripe_object_id").on(table.stripeObjectId),
  ]
);
