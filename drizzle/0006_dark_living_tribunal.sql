CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_intent" text,
	"charge" text,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text,
	"reason" text,
	"livemode" text,
	"created_stripe" bigint,
	"raw_json" jsonb,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_intent" text,
	"charge" text,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text,
	"reason" text,
	"created_stripe" bigint,
	"raw_json" jsonb,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_disputes_payment_intent" ON "disputes" USING btree ("payment_intent");--> statement-breakpoint
CREATE INDEX "idx_disputes_charge" ON "disputes" USING btree ("charge");--> statement-breakpoint
CREATE INDEX "idx_disputes_status" ON "disputes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_refunds_payment_intent" ON "refunds" USING btree ("payment_intent");--> statement-breakpoint
CREATE INDEX "idx_refunds_charge" ON "refunds" USING btree ("charge");--> statement-breakpoint
CREATE INDEX "idx_refunds_status" ON "refunds" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_payment_intents_latest_charge" ON "payment_intents" USING btree ("latest_charge");