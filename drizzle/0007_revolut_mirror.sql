CREATE TABLE "revolut_object_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" text NOT NULL,
	"object_updated_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"source" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revolut_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"state" text,
	"org_id" text,
	"related_order_id" text,
	"amount" bigint,
	"currency" text,
	"outstanding_amount" bigint,
	"refunded_amount" bigint,
	"settled_amount" bigint,
	"fee_amount" bigint,
	"payment_method_type" text,
	"description" text,
	"metadata" jsonb,
	"created_at_revolut" timestamp with time zone,
	"updated_at_revolut" timestamp with time zone,
	"raw_json" jsonb,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_revolut_snapshots_object" ON "revolut_object_snapshots" USING btree ("object_kind","object_id","object_updated_at");--> statement-breakpoint
CREATE INDEX "idx_revolut_snapshots_received" ON "revolut_object_snapshots" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_revolut_orders_org" ON "revolut_orders" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_revolut_orders_type_state" ON "revolut_orders" USING btree ("type","state");--> statement-breakpoint
CREATE INDEX "idx_revolut_orders_related" ON "revolut_orders" USING btree ("related_order_id");