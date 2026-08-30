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

// ===== Revolut mirror =====
// A SECOND acquirer, mirrored beside Stripe rather than projected into Stripe's
// shapes. Its objects are its own: ids are bare UUIDs with no prefix, there is
// no `object` field (the discriminator is `type`), and one collection —
// `GET /orders` — holds BOTH payments and refunds, told apart by that `type`.
// A refund is a top-level order of `type: "refund"` carrying `related_order_id`,
// which is the direct analogue of Stripe's `refund.payment_intent`.
//
// Verified against a real production transaction on 2026-08-30, not against
// documentation: the shapes below are the fields that transaction actually
// returned.

// Bronze. Append-only snapshots of whatever we fetched from Revolut, verbatim.
//
// Keyed on a content HASH rather than on a vendor event id, because we never
// trust a webhook's body: a delivery only tells us WHICH order changed, and we
// then GET that order and store the authoritative answer. So a row is "this
// object, exactly as Revolut described it, at the moment we asked" — and an
// identical re-fetch collapses onto the same row instead of piling up.
//
// `object_updated_at` is Revolut's own `updated_at`, which is monotonic per
// object across state transitions. It plays the role Stripe's `event.created`
// plays for us: the projection orders by it, so an older snapshot arriving
// after a newer one can never clobber silver back to a stale state.
export const revolutObjectSnapshots = pgTable(
  "revolut_object_snapshots",
  {
    id: text("id").primaryKey(), // sha256(kind|object_id|payload)
    objectKind: text("object_kind").notNull(), // 'order' | 'dispute'
    objectId: text("object_id").notNull(),
    objectUpdatedAt: timestamp("object_updated_at", { withTimezone: true }),
    payload: jsonb("payload").notNull(),
    source: text("source").notNull(), // 'webhook' | 'poll' | 'backfill'
    receivedAt: timestamp("received_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_revolut_snapshots_object").on(
      table.objectKind,
      table.objectId,
      table.objectUpdatedAt
    ),
    index("idx_revolut_snapshots_received").on(table.receivedAt),
  ]
);

// Silver. One row per Revolut order, projected from the latest bronze snapshot.
//
// Deliberately ONE table for both payments and refunds, because that is what
// the vendor has — splitting them would be our invention, and the `type` column
// is the vendor's own discriminator. Money returned is therefore
// `type = 'refund' AND state = 'completed'`, joined to its payment through
// `related_order_id`: the same "one row per return, keyed by its own id, summed
// over current state" contract the Stripe mirror already guarantees.
//
// NO dispute table yet, on purpose. `GET /disputes` is listable and returns an
// empty list on this account, so no dispute payload has ever been observed —
// typed columns for it would be guessed. Disputes are captured in bronze and
// projected once a real one exists.
export const revolutOrders = pgTable(
  "revolut_orders",
  {
    id: text("id").primaryKey(), // bare UUID — Revolut ids carry no prefix
    type: text("type").notNull(), // 'payment' | 'refund'
    state: text("state"), // pending | completed | failed | cancelled | ...
    orgId: text("org_id"), // from metadata.org_id; null when unattributable
    relatedOrderId: text("related_order_id"), // set on a refund
    amount: bigint("amount", { mode: "number" }),
    currency: text("currency"),
    outstandingAmount: bigint("outstanding_amount", { mode: "number" }),
    refundedAmount: bigint("refunded_amount", { mode: "number" }),
    // Net of the acquiring fee, as Revolut settles it. Stripe puts this on a
    // separate balance_transaction; Revolut puts it on the payment itself.
    settledAmount: bigint("settled_amount", { mode: "number" }),
    feeAmount: bigint("fee_amount", { mode: "number" }),
    paymentMethodType: text("payment_method_type"),
    description: text("description"),
    metadata: jsonb("metadata"),
    createdAtRevolut: timestamp("created_at_revolut", { withTimezone: true }),
    updatedAtRevolut: timestamp("updated_at_revolut", { withTimezone: true }),
    rawJson: jsonb("raw_json"),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_revolut_orders_org").on(table.orgId),
    index("idx_revolut_orders_type_state").on(table.type, table.state),
    index("idx_revolut_orders_related").on(table.relatedOrderId),
  ]
);


// Which acquirer charges an org. Absent = Stripe, so every org that predates
// this table keeps its behaviour with no backfill.
//
// The pin lives HERE because this service already owns the other half of the
// same fact — which key charges an org, resolved per org from key-service. A
// caller asks us to charge an org; which acquirer that means is our business,
// not theirs. billing must never name a vendor.
//
// It is deliberately never changed silently for an existing customer: a saved
// card lives with ONE acquirer and cannot move, so re-pinning an org that has a
// stored payment method strands it.
export const orgAcquirers = pgTable("org_acquirers", {
  orgId: text("org_id").primaryKey(),
  acquirer: text("acquirer").notNull(), // 'stripe' | 'revolut'
  // The acquirer's own customer id, so a charge does not have to re-resolve it.
  acquirerCustomerId: text("acquirer_customer_id"),
  pinnedAt: timestamp("pinned_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
