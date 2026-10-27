-- Conferência de pagamento no EVO. Venda lançada no tracker só soma no
-- dashboard depois que o job evo-payment-checker confirma o recebimento.
DO $$ BEGIN
	CREATE TYPE "gym-conversion-tracker"."sale_payment_status" AS ENUM (
		'A_CONFERIR',
		'PAGO',
		'PAGAMENTO_PENDENTE',
		'NAO_PAGO'
	);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "gym-conversion-tracker"."sales"
	ADD COLUMN IF NOT EXISTS "payment_status" "gym-conversion-tracker"."sale_payment_status" NOT NULL DEFAULT 'A_CONFERIR',
	ADD COLUMN IF NOT EXISTS "payment_checked_at" timestamptz,
	ADD COLUMN IF NOT EXISTS "payment_confirmed_at" timestamptz,
	ADD COLUMN IF NOT EXISTS "payment_check_count" integer NOT NULL DEFAULT 0,
	ADD COLUMN IF NOT EXISTS "payment_check_note" text,
	ADD COLUMN IF NOT EXISTS "evo_client_id" integer,
	ADD COLUMN IF NOT EXISTS "evo_sale_id" integer,
	ADD COLUMN IF NOT EXISTS "evo_paid_cents" integer;

CREATE INDEX IF NOT EXISTS "sales_payment_status_idx"
	ON "gym-conversion-tracker"."sales" ("payment_status", "created_at");

-- Uma venda do EVO confirma no máximo uma venda do tracker.
CREATE UNIQUE INDEX IF NOT EXISTS "sales_evo_sale_id_idx"
	ON "gym-conversion-tracker"."sales" ("evo_sale_id")
	WHERE "evo_sale_id" IS NOT NULL;
