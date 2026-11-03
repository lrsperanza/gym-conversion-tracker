-- Gravação contínua do microfone da recepção, em trechos de ~1 min.
-- O áudio fica no bucket privado do GCS (AUDIO_GCS_BUCKET), que apaga os objetos
-- após 30 dias; a linha aqui só indexa o trecho por horário para a auditoria.
-- (device_id, started_at) é único para que o reenvio de um trecho seja idempotente.
-- O DSQL só aceita CREATE INDEX ASYNC, mesmo com a tabela vazia.
CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."audio_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"academy_id" uuid,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"device_label" text,
	"started_at" timestamptz NOT NULL,
	"ended_at" timestamptz NOT NULL,
	"duration_ms" integer NOT NULL,
	"object_name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "audio_segments_window_valid" CHECK ("ended_at" > "started_at")
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "audio_segments_device_started_idx"
	ON "gym-conversion-tracker"."audio_segments" ("device_id", "started_at");

CREATE INDEX ASYNC IF NOT EXISTS "audio_segments_academy_started_idx"
	ON "gym-conversion-tracker"."audio_segments" ("academy_id", "started_at");

CREATE INDEX ASYNC IF NOT EXISTS "audio_segments_started_idx"
	ON "gym-conversion-tracker"."audio_segments" ("started_at");
