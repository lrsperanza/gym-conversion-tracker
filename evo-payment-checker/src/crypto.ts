import { createDecipheriv } from 'node:crypto';

// Espelho de back/src/security/crypto.ts (decryptAesGcm): iv(12) + tag(16) + dados, base64url.
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function decryptAesGcm(encryptedText: string, base64Key: string): string {
	const key = Buffer.from(base64Key, 'base64');
	if (key.length !== 32) throw new Error('EVO_CRED_KEY ausente ou inválida (precisa ser base64 de 32 bytes).');

	const payload = Buffer.from(encryptedText, 'base64url');
	const iv = payload.subarray(0, IV_BYTES);
	const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
	const encrypted = payload.subarray(IV_BYTES + TAG_BYTES);
	const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
