import {
	boolean,
	index,
	integer,
	jsonb,
	pgSchema,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { DB_SCHEMA } from '../config/env';

export const gym = pgSchema(DB_SCHEMA);

export const roleEnum = gym.enum('role', [
	'ADMIN',
	'SOCIO',
	'GERENTE_REGIONAL',
	'LIDER',
	'RECEPCIONISTA'
]);

export const attendanceStatusEnum = gym.enum('attendance_status', [
	'DRAFT',
	'IN_PROGRESS',
	'PENDING',
	'FINALIZED'
]);

export const presenterEnum = gym.enum('presenter', ['RECEPTIONIST', 'PROFESSOR']);

export const attendanceEventTypeEnum = gym.enum('attendance_event_type', [
	'LEAD_CREATED',
	'TOUR_RECEPTIONIST',
	'TOUR_PROFESSOR',
	'EXPERIMENTAL_CLASS_SCHEDULED',
	'EXPERIMENTAL_CLASS_NOW',
	'FOLLOW_UP_SCHEDULED',
	'SALE',
	'LOSS',
	'SCHEDULE_CANCELLED',
	'OTHER',
	'REOPEN',
	'NOTE'
]);

export const outcomeKindEnum = gym.enum('outcome_kind', ['SALE', 'OTHER']);

export const lossCategoryEnum = gym.enum('loss_category', [
	'APPROACH',
	'PRICE',
	'STRUCTURE',
	'LEAD_QUALITY',
	'SCHEDULE_MODALITY'
]);

export const emailTokenPurposeEnum = gym.enum('email_token_purpose', [
	'EMAIL_CONFIRMATION',
	'PASSWORD_RESET'
]);

const now = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const academies = gym.table(
	'academies',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		name: text('name').notNull(),
		city: text('city'),
		active: boolean('active').notNull().default(true),
		createdAt: now,
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [uniqueIndex('academies_name_idx').on(table.name)]
);

export const users = gym.table(
	'users',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		name: text('name').notNull(),
		normalizedName: text('normalized_name').notNull(),
		email: text('email').notNull(),
		whatsappCountryCode: text('whatsapp_country_code').notNull().default('55'),
		whatsappAreaCode: text('whatsapp_area_code').notNull().default('16'),
		whatsappNumber: text('whatsapp_number').notNull(),
		whatsappE164: text('whatsapp_e164').notNull(),
		passwordHash: text('password_hash').notNull(),
		emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
		active: boolean('active').notNull().default(true),
		photoMime: text('photo_mime'),
		photoBase64: text('photo_base64'),
		createdAt: now,
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('users_email_idx').on(table.email),
		uniqueIndex('users_whatsapp_idx').on(table.whatsappE164),
		index('users_name_trgm_idx').on(table.normalizedName)
	]
);

export const userAcademyRoles = gym.table(
	'user_academy_roles',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id),
		academyId: uuid('academy_id').references(() => academies.id),
		role: roleEnum('role').notNull(),
		active: boolean('active').notNull().default(true),
		createdAt: now
	},
	(table) => [
		uniqueIndex('user_academy_roles_unique_idx').on(table.userId, table.academyId, table.role),
		index('user_academy_roles_user_idx').on(table.userId),
		index('user_academy_roles_academy_idx').on(table.academyId)
	]
);

export const professors = gym.table(
	'professors',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		academyId: uuid('academy_id')
			.notNull()
			.references(() => academies.id),
		name: text('name').notNull(),
		normalizedName: text('normalized_name').notNull(),
		email: text('email'),
		whatsappCountryCode: text('whatsapp_country_code').notNull().default('55'),
		whatsappAreaCode: text('whatsapp_area_code').notNull().default('16'),
		whatsappNumber: text('whatsapp_number').notNull(),
		whatsappE164: text('whatsapp_e164').notNull(),
		active: boolean('active').notNull().default(true),
		photoMime: text('photo_mime'),
		photoBase64: text('photo_base64'),
		createdAt: now,
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('professors_academy_whatsapp_idx').on(table.academyId, table.whatsappE164),
		index('professors_name_trgm_idx').on(table.normalizedName)
	]
);

export const leads = gym.table(
	'leads',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		name: text('name').notNull(),
		normalizedName: text('normalized_name').notNull(),
		email: text('email'),
		whatsappCountryCode: text('whatsapp_country_code').notNull().default('55'),
		whatsappAreaCode: text('whatsapp_area_code').notNull().default('16'),
		whatsappNumber: text('whatsapp_number'),
		whatsappE164: text('whatsapp_e164'),
		notes: text('notes'),
		createdAt: now,
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('leads_whatsapp_idx').on(table.whatsappE164),
		uniqueIndex('leads_email_idx').on(table.email),
		index('leads_name_trgm_idx').on(table.normalizedName)
	]
);

export const attendances = gym.table(
	'attendances',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		academyId: uuid('academy_id')
			.notNull()
			.references(() => academies.id),
		leadId: uuid('lead_id')
			.notNull()
			.references(() => leads.id),
		receptionistId: uuid('receptionist_id')
			.notNull()
			.references(() => users.id),
		professorId: uuid('professor_id').references(() => professors.id),
		presenter: presenterEnum('presenter').notNull(),
		status: attendanceStatusEnum('status').notNull().default('IN_PROGRESS'),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		closedAt: timestamp('closed_at', { withTimezone: true }),
		createdAt: now,
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('attendances_academy_started_idx').on(table.academyId, table.startedAt),
		index('attendances_receptionist_started_idx').on(table.receptionistId, table.startedAt),
		index('attendances_professor_started_idx').on(table.professorId, table.startedAt),
		index('attendances_status_idx').on(table.status)
	]
);

export const attendanceEvents = gym.table(
	'attendance_events',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		attendanceId: uuid('attendance_id')
			.notNull()
			.references(() => attendances.id),
		actorUserId: uuid('actor_user_id')
			.notNull()
			.references(() => users.id),
		type: attendanceEventTypeEnum('type').notNull(),
		scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
		description: text('description'),
		createdAt: now
	},
	(table) => [
		index('attendance_events_attendance_created_idx').on(table.attendanceId, table.createdAt),
		index('attendance_events_type_created_idx').on(table.type, table.createdAt)
	]
);

export const outcomeTypes = gym.table(
	'outcome_types',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		key: text('key').notNull(),
		label: text('label').notNull(),
		kind: outcomeKindEnum('kind').notNull().default('SALE'),
		currentValueCents: integer('current_value_cents'),
		requiresManualValue: boolean('requires_manual_value').notNull().default(false),
		active: boolean('active').notNull().default(true),
		createdAt: now,
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [uniqueIndex('outcome_types_key_idx').on(table.key)]
);

export const sales = gym.table(
	'sales',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		attendanceId: uuid('attendance_id')
			.notNull()
			.references(() => attendances.id),
		eventId: uuid('event_id')
			.notNull()
			.references(() => attendanceEvents.id),
		outcomeTypeId: uuid('outcome_type_id').references(() => outcomeTypes.id),
		soldByUserId: uuid('sold_by_user_id')
			.notNull()
			.references(() => users.id),
		originalReceptionistId: uuid('original_receptionist_id')
			.notNull()
			.references(() => users.id),
		originalProfessorId: uuid('original_professor_id').references(() => professors.id),
		labelSnapshot: text('label_snapshot').notNull(),
		amountCents: integer('amount_cents').notNull(),
		createdAt: now
	},
	(table) => [
		index('sales_attendance_idx').on(table.attendanceId),
		index('sales_original_receptionist_created_idx').on(table.originalReceptionistId, table.createdAt),
		index('sales_original_professor_created_idx').on(table.originalProfessorId, table.createdAt),
		index('sales_sold_by_created_idx').on(table.soldByUserId, table.createdAt)
	]
);

export const lossReasons = gym.table(
	'loss_reasons',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		label: text('label').notNull(),
		category: lossCategoryEnum('category').notNull(),
		requiresDescription: boolean('requires_description').notNull().default(false),
		active: boolean('active').notNull().default(true),
		createdAt: now,
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [uniqueIndex('loss_reasons_label_idx').on(table.label)]
);

export const attendanceLosses = gym.table('attendance_losses', {
	id: uuid('id').primaryKey().defaultRandom(),
	attendanceId: uuid('attendance_id')
		.notNull()
		.references(() => attendances.id),
	eventId: uuid('event_id')
		.notNull()
		.references(() => attendanceEvents.id),
	lossReasonId: uuid('loss_reason_id')
		.notNull()
		.references(() => lossReasons.id),
	description: text('description'),
	createdAt: now
});

export const sessions = gym.table(
	'sessions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id),
		tokenHash: text('token_hash').notNull(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		createdAt: now
	},
	(table) => [uniqueIndex('sessions_token_hash_idx').on(table.tokenHash), index('sessions_user_idx').on(table.userId)]
);

export const emailTokens = gym.table(
	'email_tokens',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id),
		tokenHash: text('token_hash').notNull(),
		purpose: emailTokenPurposeEnum('purpose').notNull(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		consumedAt: timestamp('consumed_at', { withTimezone: true }),
		createdAt: now
	},
	(table) => [uniqueIndex('email_tokens_hash_idx').on(table.tokenHash), index('email_tokens_user_idx').on(table.userId)]
);

export const auditLogs = gym.table(
	'audit_logs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		actorUserId: uuid('actor_user_id').references(() => users.id),
		action: text('action').notNull(),
		entityType: text('entity_type').notNull(),
		entityId: uuid('entity_id'),
		ip: text('ip'),
		payload: jsonb('payload'),
		createdAt: now
	},
	(table) => [index('audit_logs_entity_idx').on(table.entityType, table.entityId), index('audit_logs_created_idx').on(table.createdAt)]
);

