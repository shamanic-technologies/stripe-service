CREATE TABLE "direct_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"note" text NOT NULL,
	"recorded_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_direct_payments_org_idempotency" ON "direct_payments" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_direct_payments_org" ON "direct_payments" USING btree ("org_id");