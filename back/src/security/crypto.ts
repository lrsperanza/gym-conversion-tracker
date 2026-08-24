import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const AES_GCM_ALGORITHM = 'aes-256-gcm';
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const AES_GCM_KEY_BYTES = 32;

export async function hashPassword(password: string): Promise<string> {
	return await Bun.password.hash(password, {
		algorithm: 'argon2id',
		memoryCost: 19456,
		timeCost: 2
	});
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	return await Bun.password.verify(password, hash);
}

export function createSecretToken(bytes = 32) {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

export async function hashToken(token: string) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Buffer.from(digest).toString('hex');
}

function parseAesGcmKey(base64Key: string, label: string): Buffer {
	if (!base64Key) {
		throw new Error(`${label} ausente. Gere uma chave base64 de 32 bytes para criptografar credenciais.`);
	}

	const parsed = Buffer.from(base64Key, 'base64');
	if (parsed.length !== AES_GCM_KEY_BYTES) {
		throw new Error(`${label} invalida. Use uma chave base64 com exatamente 32 bytes.`);
	}

	return parsed;
}

export function encryptAesGcm(plainText: string, base64Key: string, label: string): string {
	const iv = randomBytes(AES_GCM_IV_BYTES);
	const cipher = createCipheriv(AES_GCM_ALGORITHM, parseAesGcmKey(base64Key, label), iv, { authTagLength: AES_GCM_TAG_BYTES });
	const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function decryptAesGcm(encryptedText: string, base64Key: string, label: string): string {
	const payload = Buffer.from(encryptedText, 'base64url');
	const iv = payload.subarray(0, AES_GCM_IV_BYTES);
	const tag = payload.subarray(AES_GCM_IV_BYTES, AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES);
	const encrypted = payload.subarray(AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES);
	const decipher = createDecipheriv(AES_GCM_ALGORITHM, parseAesGcmKey(base64Key, label), iv, { authTagLength: AES_GCM_TAG_BYTES });
	decipher.setAuthTag(tag);

	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
