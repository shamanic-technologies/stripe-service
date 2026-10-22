import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  jsonb,
  bigint,
  uuid,
  uniqueIndex,
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
    // Set once every side-effect of a real Stripe event has run. NULL on a
    // stored event means a side-effect threw: the next delivery of the same
    // event (Stripe's retry, or the poller) runs them again instead of
    // treating the event as done. Synthetic api_snapshot rows never run
    // side-effects and leave it NULL.
    sideEffectsCompletedAt: timestamp("side_effects_completed_at"),
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
    source: text("source").notNull(), // 'webhook' | 'poll' | 'backfill' | 'api'
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
    // When the fee was declared to runs-service as an org-less platform cost
    // (charged to nobody, see src/lib/revolut-fees.ts). Never written by the projection.
    feeDeclaredAt: timestamp("fee_declared_at"),
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

// How much of the NEW business goes to a second acquirer. One row, id = 1.
//
// A rollout control rather than a per-org decision: the owner's requirement is
// that Stripe's share can be reduced deliberately and put back in seconds if
// the other acquirer misbehaves, without a deploy per org. So the share is
// DATA, written through an internal route, and the row is absent until someone
// sets it — absent means 0%, which is the behaviour every org has today.
//
// It selects only orgs that have NO saved payment method yet. That is enforced
// where the selection happens (a live read at the acquirer), not remembered
// here: a card lives with one acquirer and cannot move, so an org that already
// has one must stay where it is or its next automatic reload fails against an
// acquirer that has never seen its card.
export const acquirerRollout = pgTable("acquirer_rollout", {
  id: integer("id").primaryKey(), // always 1 — a single row of config
  acquirer: text("acquirer").notNull(), // the acquirer new orgs are sent to
  percent: integer("percent").notNull(), // 0-100 share of eligible new orgs
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Who last opened a billing-portal CARD UPDATE for a Stripe customer.
//
// The customer's contact email follows the last person who pays or saves a
// card (src/lib/payer-email.ts). A Checkout session carries its opener in its
// own metadata, but a portal session has no metadata and the SetupIntent it
// creates carries nothing of ours — so the opener is remembered here at open
// time and CONSUMED (deleted) when that SetupIntent succeeds. One row per
// customer: the latest opener wins.
export const cardUpdateOpeners = pgTable("card_update_openers", {
  customerId: text("customer_id").primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  openedAt: timestamp("opened_at").defaultNow().notNull(),
});

// Money an org paid us OUTSIDE any acquirer, recorded by staff.
//
// An agency client pays the platform owner directly and he puts that money into
// the product through the org; or the owner funds his own dogfooding org. No
// acquirer took it, so no fee and no settlement delay, but it is still a
// PAYMENT: it counts in the org's paid total, in revenue for the month it was
// recorded and in every paying-account figure, exactly like a settled Stripe
// PaymentIntent or a completed Revolut order.
//
// It is deliberately NOT a vendor object: its own table, its own uuid id, and
// `acquirer: "direct"` wherever a payment is listed. No bank reference is
// required (owner rule).
//
// A void is a CORRECTION ("recorded by mistake"), not a refund: a voided row is
// excluded from every read, bounded or not, as if it had never been recorded.
// Money actually given back is a different fact and has no path here.
export const directPayments = pgTable(
  "direct_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(), // minor units, > 0
    currency: text("currency").notNull(), // lowercase ISO 4217
    note: text("note").notNull(),
    recordedBy: text("recorded_by").notNull(), // staff email
    // Caller's Idempotency-Key, unique per org: the same request twice records once.
    idempotencyKey: text("idempotency_key").notNull(),
    // The instant the money counts from (revenue month, as_of bound, first payment).
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by"),
    voidReason: text("void_reason"),
  },
  (table) => [
    uniqueIndex("uq_direct_payments_org_idempotency").on(
      table.orgId,
      table.idempotencyKey
    ),
    index("idx_direct_payments_org").on(table.orgId),
  ]
);

// Every fee-bearing Stripe balance transaction (`txn_…`): what Stripe kept of a
// payment, a refund, a dispute or a failed payout. The fee is OUR cost — the
// customer is never charged it (owner 2026-10-13) — and this mirror is what
// lets staff see it per org and per month, since inception.
//
// NO org_id, like `refunds` / `disputes`: the tenant is resolved on read by
// joining `source` to the payment it belongs to (a charge through
// `payment_intents.latest_charge`, a refund through `refunds.payment_intent`).
// A fee whose source maps to no payment of ours (a failed payout) is reported
// apart as unattributed, never dropped.
export const stripeFeeTransactions = pgTable(
  "stripe_fee_transactions",
  {
    id: text("id").primaryKey(), // txn_...
    type: text("type").notNull(), // charge | payment | refund | adjustment | payout_failure | ...
    source: text("source"), // ch_… / py_… / re_… / pyr_… / dp_… / po_…
    fee: bigint("fee", { mode: "number" }).notNull(), // minor units
    currency: text("currency").notNull(), // lowercase ISO 4217
    createdStripe: bigint("created_stripe", { mode: "number" }).notNull(),
    rawJson: jsonb("raw_json").notNull(),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (table) => [index("idx_stripe_fee_transactions_source").on(table.source)]
);

// An AMOUNT HOLD placed on an org's saved card: an authorisation the bank
// accepts or refuses, never a charge until it is CAPTURED. Owner 2026-10-22:
// before a postpaid org gets a credit line, its card must hold the first step
// ($50) — saving a card proves nothing about funds. A hold lasts the acquirer's
// own window (7 days on both) and is never renewed; if the org's spend reaches
// the step while it is alive the step is paid by capturing it, else it expires.
//
// One row per hold attempt, refused ones included (the refusal IS the answer
// the caller acts on). The acquirer object it rides on (Stripe PaymentIntent
// with `capture_method: manual`, Revolut order with `capture_mode: manual`) is
// mirrored like any other and carries `metadata.purpose = "card-hold"`.
export const cardHolds = pgTable(
  "card_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    acquirer: text("acquirer").notNull(), // 'stripe' | 'revolut'
    // The acquirer's id for the hold (pi_… / Revolut order uuid). Null only
    // between the row's insert and the acquirer's create answering.
    reference: text("reference"),
    paymentMethod: text("payment_method"),
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: text("currency").notNull(), // lowercase ISO 4217
    // pending | requires_action | held | refused | captured | released | expired
    status: text("status").notNull(),
    session: text("session").notNull(), // 'on_session' | 'off_session'
    amountCaptured: bigint("amount_captured", { mode: "number" }),
    declineCode: text("decline_code"),
    declineMessage: text("decline_message"),
    idempotencyKey: text("idempotency_key").notNull(),
    description: text("description"),
    metadata: jsonb("metadata"),
    // The acquirer's own capture deadline; the hold reads `expired` after it.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    // When a hold stopped being live without a capture: refused, released, expired.
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_card_holds_org_idempotency").on(table.orgId, table.idempotencyKey),
    index("idx_card_holds_org").on(table.orgId),
    index("idx_card_holds_status").on(table.status),
    index("idx_card_holds_reference").on(table.reference),
  ]
);
