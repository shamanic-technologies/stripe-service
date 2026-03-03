DROP INDEX "idx_stripe_payments_app_id";--> statement-breakpoint
ALTER TABLE "stripe_payments" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE INDEX "idx_stripe_payments_user_id" ON "stripe_payments" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "stripe_payments" DROP COLUMN "app_id";