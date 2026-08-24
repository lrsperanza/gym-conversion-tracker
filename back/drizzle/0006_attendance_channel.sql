CREATE TYPE "gym-conversion-tracker"."attendance_channel" AS ENUM ('PRESENCIAL', 'ONLINE');

ALTER TABLE "gym-conversion-tracker"."attendances"
	ADD COLUMN "channel" "gym-conversion-tracker"."attendance_channel" NOT NULL DEFAULT 'PRESENCIAL';
