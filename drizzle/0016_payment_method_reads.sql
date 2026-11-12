CREATE TABLE IF NOT EXISTS "payment_method_reads" (
	"customer_id" text NOT NULL,
	"type" text NOT NULL,
	"body" jsonb NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_method_reads_customer_id_type_pk" PRIMARY KEY("customer_id","type")
);
