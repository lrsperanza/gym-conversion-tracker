CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."academy_dvrs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"academy_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."academies"("id"),
	"name" text NOT NULL,
	"host" text NOT NULL,
	"rtsp_port" integer NOT NULL DEFAULT 554,
	"http_port" integer NOT NULL DEFAULT 80,
	"username" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"active" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "academy_dvrs_academy_idx"
	ON "gym-conversion-tracker"."academy_dvrs" ("academy_id");

CREATE UNIQUE INDEX IF NOT EXISTS "academy_dvrs_academy_name_idx"
	ON "gym-conversion-tracker"."academy_dvrs" ("academy_id", "name")
	WHERE "active" = true;

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."academy_cameras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"dvr_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."academy_dvrs"("id"),
	"name" text NOT NULL,
	"channel" integer NOT NULL,
	"is_default" boolean NOT NULL DEFAULT false,
	"active" boolean NOT NULL DEFAULT true,
	"sort_order" integer NOT NULL DEFAULT 0,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "academy_cameras_channel_positive" CHECK ("channel" >= 1)
);

CREATE INDEX IF NOT EXISTS "academy_cameras_dvr_idx"
	ON "gym-conversion-tracker"."academy_cameras" ("dvr_id");

CREATE UNIQUE INDEX IF NOT EXISTS "academy_cameras_dvr_channel_idx"
	ON "gym-conversion-tracker"."academy_cameras" ("dvr_id", "channel")
	WHERE "active" = true;

CREATE UNIQUE INDEX IF NOT EXISTS "academy_cameras_dvr_default_idx"
	ON "gym-conversion-tracker"."academy_cameras" ("dvr_id")
	WHERE "is_default" = true;
