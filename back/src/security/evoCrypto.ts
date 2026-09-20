import { env } from '../config/env';
import { decryptAesGcm, encryptAesGcm } from './crypto';

export function encryptEvoPassword(password: string): string {
	return encryptAesGcm(password, env.evo.credentialKey, 'EVO_CRED_KEY');
}

export function decryptEvoPassword(encryptedPassword: string): string {
	return decryptAesGcm(encryptedPassword, env.evo.credentialKey, 'EVO_CRED_KEY');
}

export function encryptEvoTotpSecret(secret: string): string {
	return encryptAesGcm(secret, env.evo.credentialKey, 'EVO_CRED_KEY');
}

export function decryptEvoTotpSecret(encryptedSecret: string): string {
	return decryptAesGcm(encryptedSecret, env.evo.credentialKey, 'EVO_CRED_KEY');
}
