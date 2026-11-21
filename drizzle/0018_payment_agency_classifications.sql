CREATE TABLE IF NOT EXISTS "payment_agency_classifications" (
	"acquirer" text NOT NULL,
	"payment_id" text NOT NULL,
	"recorded_by" text NOT NULL,
	"note" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_agency_classifications_acquirer_payment_id_pk" PRIMARY KEY("acquirer","payment_id")
);
