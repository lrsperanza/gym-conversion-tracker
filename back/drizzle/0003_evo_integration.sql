ALTER TABLE "gym-conversion-tracker"."leads"
	ADD COLUMN IF NOT EXISTS "surname" text,
	ADD COLUMN IF NOT EXISTS "cpf" text,
	ADD COLUMN IF NOT EXISTS "birth_date" date,
	ADD COLUMN IF NOT EXISTS "gender" text,
	ADD COLUMN IF NOT EXISTS "cep" text,
	ADD COLUMN IF NOT EXISTS "visit_type" text,
	ADD COLUMN IF NOT EXISTS "how_found_us" text;

ALTER TABLE "gym-conversion-tracker"."users"
	ADD COLUMN IF NOT EXISTS "evo_username" text,
	ADD COLUMN IF NOT EXISTS "evo_password_encrypted" text;

ALTER TABLE "gym-conversion-tracker"."academies"
	ADD COLUMN IF NOT EXISTS "evo_unit_name" text;
