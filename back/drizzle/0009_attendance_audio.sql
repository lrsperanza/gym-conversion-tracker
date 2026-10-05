DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'gym-conversion-tracker' AND t.typname = 'audio_part') THEN
		CREATE TYPE "gym-conversion-tracker"."audio_part" AS ENUM ('FULL', 'HEAD', 'TAIL');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'gym-conversion-tracker' AND t.typname = 'audio_part_status') THEN
		CREATE TYPE "gym-conversion-tracker"."audio_part_status" AS ENUM ('UPLOADED', 'MISSING');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'gym-conversion-tracker' AND t.typname = 'transcription_status') THEN
		CREATE TYPE "gym-conversion-tracker"."transcription_status" AS ENUM ('NOT_REQUESTED', 'QUEUED', 'PROCESSING', 'DONE', 'FAILED');
	END IF;
END $$;

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."attendance_audio_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"attendance_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."attendances"("id"),
	"academy_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."academies"("id"),
	"part" "gym-conversion-tracker"."audio_part" NOT NULL,
	"status" "gym-conversion-tracker"."audio_part_status" NOT NULL,
	"close_event_id" uuid REFERENCES "gym-conversion-tracker"."attendance_events"("id"),
	"window_start" timestamptz NOT NULL,
	"window_end" timestamptz NOT NULL,
	"recorded_by_user_id" uuid REFERENCES "gym-conversion-tracker"."users"("id"),
	"device_id" uuid,
	"device_label" text,
	"covered_seconds" integer NOT NULL DEFAULT 0,
	"gaps" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"blob_name" text,
	"mime" text,
	"size_bytes" integer,
	"sha256" text,
	"participants" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"transcription_status" "gym-conversion-tracker"."transcription_status" NOT NULL DEFAULT 'NOT_REQUESTED',
	"superseded_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "attendance_audio_window_valid" CHECK ("window_end" > "window_start"),
	CONSTRAINT "attendance_audio_uploaded_has_blob" CHECK (
		"status" <> 'UPLOADED' OR (
			"recorded_by_user_id" IS NOT NULL
			AND "device_id" IS NOT NULL
			AND "blob_name" IS NOT NULL
			AND "mime" IS NOT NULL
			AND "size_bytes" IS NOT NULL
			AND "sha256" IS NOT NULL
		)
	)
);

CREATE INDEX IF NOT EXISTS "attendance_audio_attendance_idx"
	ON "gym-conversion-tracker"."attendance_audio_parts" ("attendance_id", "created_at");

CREATE INDEX IF NOT EXISTS "attendance_audio_academy_created_idx"
	ON "gym-conversion-tracker"."attendance_audio_parts" ("academy_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "attendance_audio_active_uploaded_part_idx"
	ON "gym-conversion-tracker"."attendance_audio_parts" ("attendance_id", "part")
	WHERE "superseded_at" IS NULL AND "status" = 'UPLOADED';
