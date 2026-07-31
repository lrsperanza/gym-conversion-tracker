import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function key(): Buffer {
	if (!env.evo.credentialKey) {
		throw new Error('EVO_CRED_KEY ausente. Gere uma chave base64 de 32 bytes para criptografar credenciais do EVO.');
	}

	const parsed = Buffer.from(env.evo.credentialKey, 'base64');
	if (parsed.length !== KEY_BYTES) {
		throw new Error('EVO_CRED_KEY inválida. Use uma chave base64 com exatamente 32 bytes.');
	}

	return parsed;
}

export function encryptEvoPassword(password: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key(), iv, { authTagLength: TAG_BYTES });
	const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function decryptEvoPassword(encryptedPassword: string): string {
	const payload = Buffer.from(encryptedPassword, 'base64url');
	const iv = payload.subarray(0, IV_BYTES);
	const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
	const encrypted = payload.subarray(IV_BYTES + TAG_BYTES);
	const decipher = createDecipheriv(ALGORITHM, key(), iv, { authTagLength: TAG_BYTES });
	decipher.setAuthTag(tag);

	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
