import { z } from 'zod';

const rawEnvSchema = z.object({
	PostgreHost: z.string().default('localhost'),
	PostgrePort: z.coerce.number().int().positive().default(5432),
	PostgreDatabase: z.string().default('postgres'),
	PostgreUser: z.string().default('postgres'),
	PostgrePassword: z.string().default(''),
	PostgreSSL: z
		.enum(['true', 'false'])
		.default('false')
		.transform((value) => value === 'true'),
	PORT: z.coerce.number().int().positive().optional(),
	API_PORT: z.coerce.number().int().positive().default(3000),
	CORS_ORIGIN: z.string().default('http://localhost:5173'),
	APP_URL: z.string().default('http://localhost:5173'),
	AWS_SMTP_HOST: z.string().default('email-smtp.sa-east-1.amazonaws.com'),
	AWS_SMTP_PORT: z.coerce.number().int().positive().default(587),
	AWS_SMTP_USERNAME: z.string().default(''),
	AWS_SMTP_PASSWORD: z.string().default(''),
	AWS_SMTP_FROM_EMAIL: z.string().email().or(z.literal('')).default(''),
	AWS_SMTP_FROM_NAME: z.string().default('Skyfit'),
	EVO_CRED_KEY: z.string().default(''),
	EVO_TICKET_KEY: z.string().default('')
});

const parsed = rawEnvSchema.parse(Bun.env);

export const DB_SCHEMA = 'gym-conversion-tracker';

export const env = {
	port: parsed.PORT ?? parsed.API_PORT,
	corsOrigin: parsed.CORS_ORIGIN,
	appUrl: parsed.APP_URL.replace(/\/$/, ''),
	postgres: {
		host: parsed.PostgreHost,
		port: parsed.PostgrePort,
		database: parsed.PostgreDatabase,
		user: parsed.PostgreUser,
		password: parsed.PostgrePassword,
		ssl: parsed.PostgreSSL
	},
	smtp: {
		host: parsed.AWS_SMTP_HOST,
		port: parsed.AWS_SMTP_PORT,
		user: parsed.AWS_SMTP_USERNAME,
		password: parsed.AWS_SMTP_PASSWORD,
		fromEmail: parsed.AWS_SMTP_FROM_EMAIL,
		fromName: parsed.AWS_SMTP_FROM_NAME
	},
	evo: {
		credentialKey: parsed.EVO_CRED_KEY,
		ticketKey: parsed.EVO_TICKET_KEY || parsed.EVO_CRED_KEY
	}
} as const;

