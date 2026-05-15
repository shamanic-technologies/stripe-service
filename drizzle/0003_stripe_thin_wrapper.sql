CREATE TABLE IF NOT EXISTS "api_call_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status_code" integer,
	"org_id" text,
	"user_id" text,
	"brand_id" text,
	"campaign_id" text,
	"workflow_slug" text,
	"stripe_object_id" text,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checkout_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"customer" text,
	"payment_intent" text,
	"mode" text,
	"status" text,
	"payment_status" text,
	"amount_total" bigint,
	"currency" text,
	"url" text,
	"success_url" text,
	"cancel_url" text,
	"metadata" jsonb,
	"livemode" text,
	"created_stripe" bigint,
	"raw_json" jsonb,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text,
	"name" text,
	"description" text,
	"phone" text,
	"metadata" jsonb,
	"livemode" text,
	"created_stripe" bigint,
	"raw_json" jsonb,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_sync_cursor" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_event_id" text,
	"last_synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"api_version" text,
	"livemode" text,
	"created_stripe" bigint,
	"object_id" text,
	"payload" jsonb NOT NULL,
	"source" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"customer" text,
	"amount" bigint NOT NULL,
	"amount_received" bigint,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"description" text,
	"payment_method" text,
	"latest_charge" text,
	"client_secret" text,
	"metadata" jsonb,
	"last_payment_error" jsonb,
	"livemode" text,
	"created_stripe" bigint,
	"raw_json" jsonb,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE IF EXISTS "stripe_checkout_sessions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "stripe_disputes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "stripe_payment_failures" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "stripe_payment_successes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "stripe_payments" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "stripe_refunds" CASCADE;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_call_log_org_id_created" ON "api_call_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_call_log_stripe_object_id" ON "api_call_log" USING btree ("stripe_object_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_checkout_sessions_org_id" ON "checkout_sessions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_checkout_sessions_customer" ON "checkout_sessions" USING btree ("customer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_checkout_sessions_payment_intent" ON "checkout_sessions" USING btree ("payment_intent");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_customers_org_id" ON "customers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_customers_email" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_type" ON "events" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_object_id" ON "events" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_events_received_at" ON "events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_intents_org_id" ON "payment_intents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_intents_customer" ON "payment_intents" USING btree ("customer");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_intents_status" ON "payment_intents" USING btree ("status");