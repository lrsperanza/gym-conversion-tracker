import { z } from 'zod';

export const roleSchema = z.enum(['ADMIN', 'SOCIO', 'GERENTE_REGIONAL', 'LIDER', 'RECEPCIONISTA']);

export const phoneSchema = z.object({
	countryCode: z.string().default('55'),
	areaCode: z.string().default('16'),
	number: z.string().min(8)
});

export const photoSchema = z
	.object({
		mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
		base64: z.string().max(1_500_000)
	})
	.optional();

export const academyInputSchema = z.object({
	name: z.string().min(2),
	city: z.string().optional().nullable(),
	evoUnitName: z.string().optional().nullable(),
	active: z.boolean().optional()
});

export const roleAssignmentSchema = z.object({
	role: roleSchema,
	academyId: z.string().uuid().nullable()
});

export const userInputSchema = z.object({
	name: z.string().min(2),
	email: z.string().email(),
	phone: phoneSchema,
	password: z.string().min(8).optional(),
	photo: photoSchema,
	roles: z.array(roleAssignmentSchema).min(1)
});

export const professorInputSchema = z.object({
	academyId: z.string().uuid(),
	name: z.string().min(2),
	email: z.string().email().optional().nullable(),
	phone: phoneSchema.optional().nullable(),
	photo: photoSchema
});

export const outcomeTypeInputSchema = z.object({
	label: z.string().min(2),
	currentValueCents: z.number().int().min(0).nullable().optional(),
	requiresManualValue: z.boolean().optional(),
	active: z.boolean().optional()
});

export const outcomeTypeSyncSchema = z.object({
	plans: z.array(
		z.object({
			label: z.string().min(2),
			valueCents: z.number().int().min(0)
		})
	)
});

export const lossReasonInputSchema = z.object({
	label: z.string().min(2),
	category: z.enum(['APPROACH', 'PRICE', 'STRUCTURE', 'LEAD_QUALITY', 'SCHEDULE_MODALITY']),
	requiresDescription: z.boolean().optional(),
	active: z.boolean().optional()
});

export const loginSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1)
});

export const resetPasswordRequestSchema = z.object({
	email: z.string().email()
});

export const resetPasswordSchema = z.object({
	token: z.string().min(20),
	password: z.string().min(8)
});

export const confirmEmailSchema = z.object({
	token: z.string().min(20)
});

const evoLeadFields = {
	surname: z.string().optional().nullable(),
	cpf: z.string().optional().nullable(),
	birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
	gender: z.string().optional().nullable(),
	cep: z.string().optional().nullable(),
	visitType: z.string().optional().nullable(),
	howFoundUs: z.string().optional().nullable()
};

export const leadInputSchema = z.object({
	name: z.string().min(2),
	email: z.string().email().optional().nullable(),
	phone: phoneSchema.optional().nullable(),
	notes: z.string().optional().nullable(),
	...evoLeadFields
});

export const leadPatchSchema = z.object({
	name: z.string().min(2).optional(),
	email: z.string().email().optional().nullable(),
	phone: phoneSchema.optional().nullable(),
	notes: z.string().optional().nullable(),
	...evoLeadFields
});

export const evoCredentialsSchema = z.object({
	username: z.string().email(),
	password: z.string().min(1)
});

export const attendancePatchSchema = z.object({
	professorId: z.string().uuid().optional().nullable(),
	presenter: z.enum(['RECEPTIONIST', 'PROFESSOR']).optional(),
	channel: z.enum(['PRESENCIAL', 'ONLINE']).optional()
});

export const attendanceInputSchema = z.object({
	academyId: z.string().uuid(),
	leadId: z.string().uuid().optional(),
	lead: leadInputSchema,
	professorId: z.string().uuid().optional().nullable(),
	presenter: z.enum(['RECEPTIONIST', 'PROFESSOR']).default('RECEPTIONIST'),
	channel: z.enum(['PRESENCIAL', 'ONLINE']).default('PRESENCIAL'),
	status: z.enum(['DRAFT', 'IN_PROGRESS']).default('IN_PROGRESS')
});

export const attendanceMergeLeadSchema = z.object({
	leadId: z.string().uuid(),
	lead: leadPatchSchema.pick({ name: true, email: true, phone: true }).optional()
});

export const attendanceEventInputSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('EXPERIMENTAL_CLASS_SCHEDULED'),
		scheduledFor: z.string().datetime(),
		description: z.string().optional()
	}),
	z.object({
		type: z.literal('EXPERIMENTAL_CLASS_NOW'),
		description: z.string().optional()
	}),
	z.object({
		type: z.literal('FOLLOW_UP_SCHEDULED'),
		scheduledFor: z.string().datetime(),
		description: z.string().optional()
	}),
	z.object({
		type: z.literal('SALE'),
		outcomeTypeId: z.string().uuid().optional().nullable(),
		manualLabel: z.string().optional(),
		manualValueCents: z.number().int().min(0).optional()
	}),
	z.object({
		type: z.literal('LOSS'),
		lossReasonId: z.string().uuid(),
		description: z.string().optional()
	}),
	z.object({
		type: z.literal('SCHEDULE_CANCELLED'),
		description: z.string().optional()
	}),
	z.object({
		type: z.literal('OTHER'),
		description: z.string().min(1)
	}),
	z.object({
		type: z.literal('REOPEN'),
		description: z.string().optional()
	}),
	z.object({
		type: z.literal('NOTE'),
		description: z.string().min(1)
	}),
	z.object({
		type: z.literal('CLOSE'),
		description: z.string().optional()
	})
]);

export const dashboardQuerySchema = z.object({
	academyId: z.string().uuid().optional(),
	from: z.string().datetime().optional(),
	to: z.string().datetime().optional()
});

