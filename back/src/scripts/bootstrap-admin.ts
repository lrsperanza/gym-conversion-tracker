import { sql, closeDb } from '../db/client';
import { normalizeEmail, normalizeName, normalizePhone } from '../domain/normalize';
import { hashPassword } from '../security/crypto';

const [nameInput, emailInput, passwordInput, whatsappInput] = Bun.argv.slice(2);

if (!nameInput || !emailInput || !passwordInput) {
	console.error('Uso: bun src/scripts/bootstrap-admin.ts "Nome" email@dominio.com senha [whatsapp]');
	throw new Error('Parâmetros obrigatórios ausentes.');
}

const adminName = nameInput;
const adminEmail = emailInput;
const adminPassword = passwordInput;
const whatsapp = normalizePhone({ number: whatsappInput || '999999999' });
const email = normalizeEmail(adminEmail)!;

async function bootstrap() {
	const existingAdmin = await sql`
		SELECT u."id"
		FROM "gym-conversion-tracker"."users" u
		JOIN "gym-conversion-tracker"."user_academy_roles" r ON r."user_id" = u."id"
		WHERE r."role" = 'ADMIN' AND r."active" = true
		LIMIT 1
	`;

	if (existingAdmin.length > 0) {
		throw new Error('Já existe um ADMIN. Crie novos admins pelo sistema.');
	}

	const passwordHash = await hashPassword(adminPassword);
	const [user] = await sql<Array<{ id: string }>>`
		INSERT INTO "gym-conversion-tracker"."users"
			("name", "normalized_name", "email", "whatsapp_country_code", "whatsapp_area_code", "whatsapp_number", "whatsapp_e164", "password_hash", "email_verified_at")
		VALUES (${adminName}, ${normalizeName(adminName)}, ${email}, ${whatsapp.countryCode}, ${whatsapp.areaCode}, ${whatsapp.number}, ${whatsapp.e164}, ${passwordHash}, now())
		RETURNING "id"
	`;
	if (!user) throw new Error('Falha ao criar ADMIN.');

	await sql`
		INSERT INTO "gym-conversion-tracker"."user_academy_roles" ("user_id", "academy_id", "role")
		VALUES (${user.id}, NULL, 'ADMIN')
	`;

	console.info(`ADMIN criado: ${email}`);
}

bootstrap()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(closeDb);

