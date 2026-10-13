CREATE TABLE "stripe_fee_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"source" text,
	"fee" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_stripe" bigint NOT NULL,
	"raw_json" jsonb NOT NULL,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_stripe_fee_transactions_source" ON "stripe_fee_transactions" USING btree ("source");--> statement-breakpoint
-- The acquiring fee is now the PLATFORM's cost (owner 2026-10-13), declared on an
-- org-less platform run so it is recorded and charged to nobody. Payments stamped
-- by 0013 were never declared at all; clearing the stamp lets the sweep record
-- them once, still charged to nobody.
UPDATE "revolut_orders" SET "fee_declared_at" = NULL;
