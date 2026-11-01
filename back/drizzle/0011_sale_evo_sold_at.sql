-- Data efetiva da venda no EVO (dtVenda da venda que confirmou o pagamento).
-- O dashboard soma receita por essa data, não pela data em que a venda foi
-- lançada no tracker, que pode ser dias depois (renovações) ou antes.
ALTER TABLE "gym-conversion-tracker"."sales"
	ADD COLUMN IF NOT EXISTS "evo_sold_at" timestamptz;

-- Backfill das vendas já confirmadas a partir da nota do job
-- ("Venda EVO #123 em 26/10/2026: ..."), que só guarda o dia: quando o dia
-- bate com o lançamento usa o horário do lançamento, senão meio-dia local.
UPDATE "gym-conversion-tracker"."sales" s
SET "evo_sold_at" = CASE
	WHEN (s."created_at" AT TIME ZONE 'America/Sao_Paulo')::date = n.evo_day THEN s."created_at"
	ELSE (n.evo_day + time '12:00') AT TIME ZONE 'America/Sao_Paulo'
END
FROM (
	SELECT
		"id",
		to_date(substring("payment_check_note" from 'Venda EVO #[0-9]+ em ([0-9]{2}/[0-9]{2}/[0-9]{4})'), 'DD/MM/YYYY') AS evo_day
	FROM "gym-conversion-tracker"."sales"
	WHERE "payment_status" = 'PAGO' AND "evo_sold_at" IS NULL
) n
WHERE n."id" = s."id" AND n.evo_day IS NOT NULL;

CREATE INDEX IF NOT EXISTS "sales_evo_sold_at_idx"
	ON "gym-conversion-tracker"."sales" ("evo_sold_at");
