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
	EVO_TICKET_KEY: z.string().default(''),
	CAMERA_CRED_KEY: z.string().default(''),
	CAMERA_CLIP_DIR: z.string().default('./clips'),
	CAMERA_CLIP_TTL_MINUTES: z.coerce.number().int().positive().default(60),
	CAMERA_CLIP_MAX_MINUTES: z.coerce.number().int().positive().default(15),
	CAMERA_MAX_CONCURRENT: z.coerce.number().int().positive().default(2),
	GYM_TIMEZONE: z.string().default('America/Sao_Paulo'),
	AZURE_STORAGE_ACCOUNT_NAME: z.string().default(''),
	AZURE_STORAGE_ACCOUNT_KEY: z.string().default(''),
	DESKTOP_BLOB_CONTAINER: z.string().default('personal'),
	DESKTOP_BUILD_PREFIX: z.string().default('Skyfit-EVO-')
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
	},
	video: {
		credentialKey: parsed.CAMERA_CRED_KEY || parsed.EVO_CRED_KEY,
		clipDir: parsed.CAMERA_CLIP_DIR,
		clipTtlMinutes: parsed.CAMERA_CLIP_TTL_MINUTES,
		clipMaxMinutes: parsed.CAMERA_CLIP_MAX_MINUTES,
		maxConcurrent: parsed.CAMERA_MAX_CONCURRENT,
		timeZone: parsed.GYM_TIMEZONE
	},
	azure: {
		accountName: parsed.AZURE_STORAGE_ACCOUNT_NAME,
		accountKey: parsed.AZURE_STORAGE_ACCOUNT_KEY
	},
	desktop: {
		container: parsed.DESKTOP_BLOB_CONTAINER,
		buildPrefix: parsed.DESKTOP_BUILD_PREFIX
	}
} as const;

