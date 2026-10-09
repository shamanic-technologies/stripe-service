ALTER TABLE "revolut_orders" ADD COLUMN "fee_declared_at" timestamp;--> statement-breakpoint
-- Payments completed before the Revolut fee was charged to customers are NOT
-- charged retroactively here; whether history is charged is a separate owner
-- decision, applied by hand if taken.
UPDATE "revolut_orders" SET "fee_declared_at" = now() WHERE "type" = 'payment' AND "state" = 'completed';
