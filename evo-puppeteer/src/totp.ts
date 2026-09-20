import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_STEP_SECONDS = 30;
const DEFAULT_DIGITS = 6;
const MIN_FRESH_SECONDS = 5;

export type OtpauthMigrationAccount = {
	name?: string;
	issuer?: string;
	secretBase32: string;
	algorithm?: string;
	digits?: number;
	type?: string;
	counter?: bigint;
};

export function base32Decode(secret: string): Buffer {
	const normalized = secret.replace(/\s+/g, '').replace(/=+$/g, '').toUpperCase();
	if (!normalized) throw new Error('Chave 2FA ausente.');

	let bits = '';
	for (const char of normalized) {
		const value = BASE32_ALPHABET.indexOf(char);
		if (value === -1) throw new Error('Chave 2FA inválida: use apenas base32.');
		bits += value.toString(2).padStart(5, '0');
	}

	const bytes: number[] = [];
	for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
		bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
	}
	return Buffer.from(bytes);
}

export function base32Encode(bytes: Buffer): string {
	let bits = '';
	for (const byte of bytes) {
		bits += byte.toString(2).padStart(8, '0');
	}

	let output = '';
	for (let offset = 0; offset < bits.length; offset += 5) {
		const chunk = bits.slice(offset, offset + 5).padEnd(5, '0');
		output += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
	}
	return output;
}

export function generateTotp(
	secret: string,
	now = Date.now(),
	options: { stepSeconds?: number; digits?: number } = {}
): string {
	const stepSeconds = options.stepSeconds ?? DEFAULT_STEP_SECONDS;
	const digits = options.digits ?? DEFAULT_DIGITS;
	const counter = Math.floor(now / 1000 / stepSeconds);
	const counterBuffer = Buffer.alloc(8);
	counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
	counterBuffer.writeUInt32BE(counter >>> 0, 4);

	const hmac = createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
	const offset = hmac[hmac.length - 1]! & 0x0f;
	const binary =
		((hmac[offset]! & 0x7f) << 24) |
		((hmac[offset + 1]! & 0xff) << 16) |
		((hmac[offset + 2]! & 0xff) << 8) |
		(hmac[offset + 3]! & 0xff);

	return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function totpSecondsRemaining(now = Date.now(), stepSeconds = DEFAULT_STEP_SECONDS): number {
	const elapsed = Math.floor(now / 1000) % stepSeconds;
	return stepSeconds - elapsed;
}

export async function codigoTotpFresco(secret: string): Promise<string> {
	if (totpSecondsRemaining() <= MIN_FRESH_SECONDS) {
		await sleep((totpSecondsRemaining() + 1) * 1000);
	}
	return generateTotp(secret);
}

export function decodeOtpauthMigrationUri(uri: string): OtpauthMigrationAccount[] {
	const data = migrationData(uri);
	const payload = Buffer.from(data, 'base64');
	const accounts: OtpauthMigrationAccount[] = [];
	let offset = 0;

	while (offset < payload.length) {
		const field = readField(payload, offset);
		offset = field.nextOffset;
		if (field.fieldNumber === 1 && field.wireType === 2) {
			accounts.push(parseOtpParameters(field.value as Buffer));
		}
	}

	if (!accounts.length) throw new Error('Nenhuma conta TOTP encontrada no QR de migração.');
	return accounts;
}

function migrationData(uri: string): string {
	const parsed = new URL(uri);
	if (parsed.protocol !== 'otpauth-migration:') {
		throw new Error('URI inválida: esperado otpauth-migration://offline?data=...');
	}
	const data = parsed.searchParams.get('data');
	if (!data) throw new Error('URI de migração sem parâmetro data.');
	return data;
}

function parseOtpParameters(buffer: Buffer): OtpauthMigrationAccount {
	const account: Partial<OtpauthMigrationAccount> = {};
	let offset = 0;

	while (offset < buffer.length) {
		const field = readField(buffer, offset);
		offset = field.nextOffset;

		if (field.fieldNumber === 1 && field.wireType === 2) {
			account.secretBase32 = base32Encode(field.value as Buffer);
		} else if (field.fieldNumber === 2 && field.wireType === 2) {
			account.name = (field.value as Buffer).toString('utf8');
		} else if (field.fieldNumber === 3 && field.wireType === 2) {
			account.issuer = (field.value as Buffer).toString('utf8');
		} else if (field.fieldNumber === 4 && field.wireType === 0) {
			account.algorithm = algorithmName(field.value as bigint);
		} else if (field.fieldNumber === 5 && field.wireType === 0) {
			account.digits = digitsCount(field.value as bigint);
		} else if (field.fieldNumber === 6 && field.wireType === 0) {
			account.type = otpType(field.value as bigint);
		} else if (field.fieldNumber === 7 && field.wireType === 0) {
			account.counter = field.value as bigint;
		}
	}

	if (!account.secretBase32) throw new Error('Conta de migração sem segredo TOTP.');
	return account as OtpauthMigrationAccount;
}

function readField(buffer: Buffer, offset: number): { fieldNumber: number; wireType: number; value: Buffer | bigint; nextOffset: number } {
	const key = readVarint(buffer, offset);
	const fieldNumber = Number(key.value >> 3n);
	const wireType = Number(key.value & 7n);

	if (wireType === 0) {
		const value = readVarint(buffer, key.nextOffset);
		return { fieldNumber, wireType, value: value.value, nextOffset: value.nextOffset };
	}
	if (wireType === 2) {
		const length = readVarint(buffer, key.nextOffset);
		const start = length.nextOffset;
		const end = start + Number(length.value);
		if (end > buffer.length) throw new Error('Payload de migração truncado.');
		return { fieldNumber, wireType, value: buffer.subarray(start, end), nextOffset: end };
	}

	throw new Error(`Tipo protobuf não suportado no QR de migração: ${wireType}.`);
}

function readVarint(buffer: Buffer, offset: number): { value: bigint; nextOffset: number } {
	let result = 0n;
	let shift = 0n;
	let cursor = offset;

	while (cursor < buffer.length) {
		const byte = buffer[cursor]!;
		result |= BigInt(byte & 0x7f) << shift;
		cursor += 1;
		if ((byte & 0x80) === 0) return { value: result, nextOffset: cursor };
		shift += 7n;
	}

	throw new Error('Varint protobuf truncado no QR de migração.');
}

function algorithmName(value: bigint): string {
	if (value === 1n) return 'SHA1';
	if (value === 2n) return 'SHA256';
	if (value === 3n) return 'SHA512';
	return `UNKNOWN_${value}`;
}

function digitsCount(value: bigint): number {
	if (value === 1n) return 6;
	if (value === 2n) return 8;
	return Number(value);
}

function otpType(value: bigint): string {
	if (value === 1n) return 'HOTP';
	if (value === 2n) return 'TOTP';
	return `UNKNOWN_${value}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
