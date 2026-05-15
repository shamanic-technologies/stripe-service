CREATE TABLE IF NOT EXISTS "customer_balance_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"customer" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"type" text NOT NULL,
	"credit_note" text,
	"invoice" text,
	"description" text,
	"metadata" jsonb,
	"livemode" text,
	"created_stripe" bigint,
	"raw_json" jsonb,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cbt_org_id" ON "customer_balance_transactions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cbt_customer" ON "customer_balance_transactions" USING btree ("customer");
