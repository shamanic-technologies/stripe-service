CREATE TABLE "card_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"acquirer" text NOT NULL,
	"reference" text,
	"payment_method" text,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"session" text NOT NULL,
	"amount_captured" bigint,
	"decline_code" text,
	"decline_message" text,
	"idempotency_key" text NOT NULL,
	"description" text,
	"metadata" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_card_holds_org_idempotency" ON "card_holds" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_card_holds_org" ON "card_holds" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_card_holds_status" ON "card_holds" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_card_holds_reference" ON "card_holds" USING btree ("reference");
