-- Uma linha por execução do evo-payment-checker (job das 01:00). O dashboard usa
-- a última execução e a última com sucesso para avisar que a conferência com o
-- EVO falhou e que receita/rankings estão incompletos.
-- status: RUNNING (em andamento ou o container morreu no meio), OK, PARTIAL
-- (algumas vendas deram erro), FAILED (login ou falha geral; nada conferido).
CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."payment_check_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"started_at" timestamptz NOT NULL DEFAULT now(),
	"finished_at" timestamptz,
	"status" text NOT NULL DEFAULT 'RUNNING',
	"sales_to_check" integer NOT NULL DEFAULT 0,
	"paid" integer NOT NULL DEFAULT 0,
	"pending" integer NOT NULL DEFAULT 0,
	"not_paid" integer NOT NULL DEFAULT 0,
	"errors" integer NOT NULL DEFAULT 0,
	"failed_units" integer NOT NULL DEFAULT 0,
	"login_method" text,
	"message" text,
	CONSTRAINT "payment_check_runs_status_valid" CHECK ("status" IN ('RUNNING', 'OK', 'PARTIAL', 'FAILED'))
);

CREATE INDEX ASYNC IF NOT EXISTS "payment_check_runs_started_idx"
	ON "gym-conversion-tracker"."payment_check_runs" ("started_at");
