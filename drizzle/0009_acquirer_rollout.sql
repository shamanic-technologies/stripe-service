CREATE TABLE "acquirer_rollout" (
	"id" integer PRIMARY KEY NOT NULL,
	"acquirer" text NOT NULL,
	"percent" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
