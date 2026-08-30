CREATE TABLE "org_acquirers" (
	"org_id" text PRIMARY KEY NOT NULL,
	"acquirer" text NOT NULL,
	"acquirer_customer_id" text,
	"pinned_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
