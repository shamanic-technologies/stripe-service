CREATE TABLE "stripe_checkout_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_session_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"stripe_customer_id" text,
	"amount_total_in_cents" integer,
	"currency" text,
	"payment_status" text NOT NULL,
	"status" text NOT NULL,
	"raw_payload" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_dispute_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"stripe_charge_id" text NOT NULL,
	"amount_in_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"raw_payload" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_payment_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_payment_intent_id" text NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"raw_payload" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_payment_successes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_payment_intent_id" text NOT NULL,
	"stripe_charge_id" text,
	"amount_in_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"receipt_url" text,
	"raw_payload" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text,
	"run_id" text,
	"brand_id" text,
	"app_id" text,
	"campaign_id" text,
	"stripe_payment_intent_id" text,
	"stripe_checkout_session_id" text,
	"stripe_customer_id" text,
	"amount_in_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"description" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_refund_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"stripe_charge_id" text NOT NULL,
	"amount_in_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"raw_payload" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_checkout_sessions_session_id" ON "stripe_checkout_sessions" USING btree ("stripe_session_id");--> statement-breakpoint
CREATE INDEX "idx_checkout_sessions_payment_intent_id" ON "stripe_checkout_sessions" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_disputes_dispute_id" ON "stripe_disputes" USING btree ("stripe_dispute_id");--> statement-breakpoint
CREATE INDEX "idx_disputes_payment_intent_id" ON "stripe_disputes" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "idx_payment_failures_intent_id" ON "stripe_payment_failures" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_payment_successes_intent_id" ON "stripe_payment_successes" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_payments_org_id" ON "stripe_payments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_payments_run_id" ON "stripe_payments" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_payments_brand_id" ON "stripe_payments" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_payments_app_id" ON "stripe_payments" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_payments_campaign_id" ON "stripe_payments" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_payments_payment_intent_id" ON "stripe_payments" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "idx_stripe_payments_checkout_session_id" ON "stripe_payments" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_refunds_refund_id" ON "stripe_refunds" USING btree ("stripe_refund_id");--> statement-breakpoint
CREATE INDEX "idx_refunds_payment_intent_id" ON "stripe_refunds" USING btree ("stripe_payment_intent_id");