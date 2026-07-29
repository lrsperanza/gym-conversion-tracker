CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS "gym-conversion-tracker";

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'gym-conversion-tracker' AND t.typname = 'role') THEN
		CREATE TYPE "gym-conversion-tracker"."role" AS ENUM ('ADMIN', 'SOCIO', 'GERENTE_REGIONAL', 'LIDER', 'RECEPCIONISTA');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'gym-conversion-tracker' AND t.typname = 'attendance_status') THEN
		CREATE TYPE "gym-conversion-tracker"."attendance_status" AS ENUM ('DRAFT', 'IN_PROGRESS', 'PENDING', 'FINALIZED');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'gym-conversion-tracker' AND t.typname = 'presenter') THEN
		CREATE TYPE "gym-conversion-tracker"."presenter" AS ENUM ('RECEPTIONIST', 'PROFESSOR');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'gym-conversion-tracker' AND t.typname = 'attendance_event_type') THEN
		CREATE TYPE "gym-conversion-tracker"."attendance_event_type" AS ENUM ('LEAD_CREATED', 'TOUR_RECEPTIONIST', 'TOUR_PROFESSOR', 'EXPERIMENTAL_CLASS_SCHEDULED', 'EXPERIMENTAL_CLASS_NOW', 'FOLLOW_UP_SCHEDULED', 'SALE', 'LOSS', 'OTHER', 'REOPEN', 'NOTE');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'gym-conversion-tracker' AND t.typname = 'outcome_kind') THEN
		CREATE TYPE "gym-conversion-tracker"."outcome_kind" AS ENUM ('SALE', 'OTHER');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'gym-conversion-tracker' AND t.typname = 'loss_category') THEN
		CREATE TYPE "gym-conversion-tracker"."loss_category" AS ENUM ('APPROACH', 'PRICE', 'STRUCTURE', 'LEAD_QUALITY', 'SCHEDULE_MODALITY');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'gym-conversion-tracker' AND t.typname = 'email_token_purpose') THEN
		CREATE TYPE "gym-conversion-tracker"."email_token_purpose" AS ENUM ('EMAIL_CONFIRMATION', 'PASSWORD_RESET');
	END IF;
END $$;

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."academies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"city" text,
	"active" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"email" text NOT NULL,
	"whatsapp_country_code" text NOT NULL DEFAULT '55',
	"whatsapp_area_code" text NOT NULL DEFAULT '16',
	"whatsapp_number" text NOT NULL,
	"whatsapp_e164" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamptz,
	"active" boolean NOT NULL DEFAULT true,
	"photo_mime" text,
	"photo_base64" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."user_academy_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."users"("id"),
	"academy_id" uuid REFERENCES "gym-conversion-tracker"."academies"("id"),
	"role" "gym-conversion-tracker"."role" NOT NULL,
	"active" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."professors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"academy_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."academies"("id"),
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"email" text,
	"whatsapp_country_code" text NOT NULL DEFAULT '55',
	"whatsapp_area_code" text NOT NULL DEFAULT '16',
	"whatsapp_number" text NOT NULL,
	"whatsapp_e164" text NOT NULL,
	"active" boolean NOT NULL DEFAULT true,
	"photo_mime" text,
	"photo_base64" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"email" text,
	"whatsapp_country_code" text NOT NULL DEFAULT '55',
	"whatsapp_area_code" text NOT NULL DEFAULT '16',
	"whatsapp_number" text NOT NULL,
	"whatsapp_e164" text NOT NULL,
	"notes" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."attendances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"academy_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."academies"("id"),
	"lead_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."leads"("id"),
	"receptionist_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."users"("id"),
	"professor_id" uuid REFERENCES "gym-conversion-tracker"."professors"("id"),
	"presenter" "gym-conversion-tracker"."presenter" NOT NULL,
	"status" "gym-conversion-tracker"."attendance_status" NOT NULL DEFAULT 'IN_PROGRESS',
	"started_at" timestamptz NOT NULL DEFAULT now(),
	"closed_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."attendance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"attendance_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."attendances"("id"),
	"actor_user_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."users"("id"),
	"type" "gym-conversion-tracker"."attendance_event_type" NOT NULL,
	"scheduled_for" timestamptz,
	"description" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."outcome_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"key" text NOT NULL,
	"label" text NOT NULL,
	"kind" "gym-conversion-tracker"."outcome_kind" NOT NULL DEFAULT 'SALE',
	"current_value_cents" integer,
	"requires_manual_value" boolean NOT NULL DEFAULT false,
	"active" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"attendance_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."attendances"("id"),
	"event_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."attendance_events"("id"),
	"outcome_type_id" uuid REFERENCES "gym-conversion-tracker"."outcome_types"("id"),
	"sold_by_user_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."users"("id"),
	"original_receptionist_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."users"("id"),
	"original_professor_id" uuid REFERENCES "gym-conversion-tracker"."professors"("id"),
	"label_snapshot" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."loss_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"label" text NOT NULL,
	"category" "gym-conversion-tracker"."loss_category" NOT NULL,
	"requires_description" boolean NOT NULL DEFAULT false,
	"active" boolean NOT NULL DEFAULT true,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."attendance_losses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"attendance_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."attendances"("id"),
	"event_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."attendance_events"("id"),
	"loss_reason_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."loss_reasons"("id"),
	"description" text,
	"created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."users"("id"),
	"token_hash" text NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"revoked_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."email_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL REFERENCES "gym-conversion-tracker"."users"("id"),
	"token_hash" text NOT NULL,
	"purpose" "gym-conversion-tracker"."email_token_purpose" NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"consumed_at" timestamptz,
	"created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "gym-conversion-tracker"."audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"actor_user_id" uuid REFERENCES "gym-conversion-tracker"."users"("id"),
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"ip" text,
	"payload" jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "academies_name_idx" ON "gym-conversion-tracker"."academies" ("name");
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "gym-conversion-tracker"."users" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "users_whatsapp_idx" ON "gym-conversion-tracker"."users" ("whatsapp_e164");
CREATE INDEX IF NOT EXISTS "users_name_trgm_idx" ON "gym-conversion-tracker"."users" USING gin ("normalized_name" gin_trgm_ops);
CREATE UNIQUE INDEX IF NOT EXISTS "user_academy_roles_unique_idx" ON "gym-conversion-tracker"."user_academy_roles" ("user_id", COALESCE("academy_id", '00000000-0000-0000-0000-000000000000'::uuid), "role");
CREATE INDEX IF NOT EXISTS "user_academy_roles_user_idx" ON "gym-conversion-tracker"."user_academy_roles" ("user_id");
CREATE INDEX IF NOT EXISTS "user_academy_roles_academy_idx" ON "gym-conversion-tracker"."user_academy_roles" ("academy_id");
CREATE UNIQUE INDEX IF NOT EXISTS "professors_academy_whatsapp_idx" ON "gym-conversion-tracker"."professors" ("academy_id", "whatsapp_e164");
CREATE INDEX IF NOT EXISTS "professors_name_trgm_idx" ON "gym-conversion-tracker"."professors" USING gin ("normalized_name" gin_trgm_ops);
CREATE UNIQUE INDEX IF NOT EXISTS "leads_whatsapp_idx" ON "gym-conversion-tracker"."leads" ("whatsapp_e164");
CREATE UNIQUE INDEX IF NOT EXISTS "leads_email_idx" ON "gym-conversion-tracker"."leads" ("email") WHERE "email" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "leads_name_trgm_idx" ON "gym-conversion-tracker"."leads" USING gin ("normalized_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "attendances_academy_started_idx" ON "gym-conversion-tracker"."attendances" ("academy_id", "started_at");
CREATE INDEX IF NOT EXISTS "attendances_receptionist_started_idx" ON "gym-conversion-tracker"."attendances" ("receptionist_id", "started_at");
CREATE INDEX IF NOT EXISTS "attendances_professor_started_idx" ON "gym-conversion-tracker"."attendances" ("professor_id", "started_at");
CREATE INDEX IF NOT EXISTS "attendances_status_idx" ON "gym-conversion-tracker"."attendances" ("status");
CREATE INDEX IF NOT EXISTS "attendance_events_attendance_created_idx" ON "gym-conversion-tracker"."attendance_events" ("attendance_id", "created_at");
CREATE INDEX IF NOT EXISTS "attendance_events_type_created_idx" ON "gym-conversion-tracker"."attendance_events" ("type", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "outcome_types_key_idx" ON "gym-conversion-tracker"."outcome_types" ("key");
CREATE INDEX IF NOT EXISTS "sales_attendance_idx" ON "gym-conversion-tracker"."sales" ("attendance_id");
CREATE INDEX IF NOT EXISTS "sales_original_receptionist_created_idx" ON "gym-conversion-tracker"."sales" ("original_receptionist_id", "created_at");
CREATE INDEX IF NOT EXISTS "sales_original_professor_created_idx" ON "gym-conversion-tracker"."sales" ("original_professor_id", "created_at");
CREATE INDEX IF NOT EXISTS "sales_sold_by_created_idx" ON "gym-conversion-tracker"."sales" ("sold_by_user_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "loss_reasons_label_idx" ON "gym-conversion-tracker"."loss_reasons" ("label");
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_token_hash_idx" ON "gym-conversion-tracker"."sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "gym-conversion-tracker"."sessions" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "email_tokens_hash_idx" ON "gym-conversion-tracker"."email_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "email_tokens_user_idx" ON "gym-conversion-tracker"."email_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "audit_logs_entity_idx" ON "gym-conversion-tracker"."audit_logs" ("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "audit_logs_created_idx" ON "gym-conversion-tracker"."audit_logs" ("created_at");
