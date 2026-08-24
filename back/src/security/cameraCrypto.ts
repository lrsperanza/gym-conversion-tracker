import { env } from '../config/env';
import { decryptAesGcm, encryptAesGcm } from './crypto';

export function encryptCameraPassword(password: string): string {
	return encryptAesGcm(password, env.video.credentialKey, 'CAMERA_CRED_KEY/EVO_CRED_KEY');
}

export function decryptCameraPassword(encryptedPassword: string): string {
	return decryptAesGcm(encryptedPassword, env.video.credentialKey, 'CAMERA_CRED_KEY/EVO_CRED_KEY');
}
