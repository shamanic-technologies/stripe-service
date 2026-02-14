import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";

// ===== Main payment records =====

export const stripePayments = pgTable(
  "stripe_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id"),
    runId: text("run_id"),
    brandId: text("brand_id"),
    appId: text("app_id"),
    campaignId: text("campaign_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripeCustomerId: text("stripe_customer_id"),
    amountInCents: integer("amount_in_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    status: text("status").notNull().default("pending"),
    description: text("description"),
    metadata: text("metadata"), // JSON string
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_stripe_payments_org_id").on(table.orgId),
    index("idx_stripe_payments_run_id").on(table.runId),
    index("idx_stripe_payments_brand_id").on(table.brandId),
    index("idx_stripe_payments_app_id").on(table.appId),
    index("idx_stripe_payments_campaign_id").on(table.campaignId),
    index("idx_stripe_payments_payment_intent_id").on(table.stripePaymentIntentId),
    index("idx_stripe_payments_checkout_session_id").on(table.stripeCheckoutSessionId),
  ]
);

// ===== Payment success events =====

export const stripePaymentSuccesses = pgTable(
  "stripe_payment_successes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripePaymentIntentId: text("stripe_payment_intent_id").notNull(),
    stripeChargeId: text("stripe_charge_id"),
    amountInCents: integer("amount_in_cents").notNull(),
    currency: text("currency").notNull(),
    receiptUrl: text("receipt_url"),
    rawPayload: text("raw_payload"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_payment_successes_intent_id").on(table.stripePaymentIntentId),
  ]
);

// ===== Payment failure events =====

export const stripePaymentFailures = pgTable(
  "stripe_payment_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripePaymentIntentId: text("stripe_payment_intent_id").notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    rawPayload: text("raw_payload"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_payment_failures_intent_id").on(table.stripePaymentIntentId),
  ]
);

// ===== Refund events =====

export const stripeRefunds = pgTable(
  "stripe_refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeRefundId: text("stripe_refund_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeChargeId: text("stripe_charge_id").notNull(),
    amountInCents: integer("amount_in_cents").notNull(),
    currency: text("currency").notNull(),
    reason: text("reason"),
    status: text("status").notNull(),
    rawPayload: text("raw_payload"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_refunds_refund_id").on(table.stripeRefundId),
    index("idx_refunds_payment_intent_id").on(table.stripePaymentIntentId),
  ]
);

// ===== Dispute events =====

export const stripeDisputes = pgTable(
  "stripe_disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeDisputeId: text("stripe_dispute_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeChargeId: text("stripe_charge_id").notNull(),
    amountInCents: integer("amount_in_cents").notNull(),
    currency: text("currency").notNull(),
    reason: text("reason"),
    status: text("status").notNull(),
    rawPayload: text("raw_payload"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_disputes_dispute_id").on(table.stripeDisputeId),
    index("idx_disputes_payment_intent_id").on(table.stripePaymentIntentId),
  ]
);

// ===== Checkout session completed events =====

export const stripeCheckoutSessions = pgTable(
  "stripe_checkout_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeSessionId: text("stripe_session_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeCustomerId: text("stripe_customer_id"),
    amountTotalInCents: integer("amount_total_in_cents"),
    currency: text("currency"),
    paymentStatus: text("payment_status").notNull(),
    status: text("status").notNull(),
    rawPayload: text("raw_payload"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_checkout_sessions_session_id").on(table.stripeSessionId),
    index("idx_checkout_sessions_payment_intent_id").on(table.stripePaymentIntentId),
  ]
);
