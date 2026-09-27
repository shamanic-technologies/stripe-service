ALTER TABLE "events" ADD COLUMN "side_effects_completed_at" timestamp;--> statement-breakpoint
-- Real events stored before this column existed are treated as handled: there
-- is no record of which of them failed, and re-running years of side-effects
-- on a stray redelivery is not what this column is for.
UPDATE "events" SET "side_effects_completed_at" = "received_at" WHERE "source" IN ('webhook', 'poll');
