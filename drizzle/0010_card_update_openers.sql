CREATE TABLE "card_update_openers" (
	"customer_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL
);
