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

