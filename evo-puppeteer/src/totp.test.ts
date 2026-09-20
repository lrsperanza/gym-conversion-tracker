import { describe, expect, test } from 'bun:test';
import { base32Decode, base32Encode, decodeOtpauthMigrationUri, generateTotp, totpSecondsRemaining } from './totp.ts';

describe('TOTP', () => {
	test('decodes base32 secrets with spaces and padding', () => {
		expect(base32Decode('JBSW Y3DP EHPK 3PXP====').toString('hex')).toBe('48656c6c6f21deadbeef');
	});

	test('encodes raw bytes as base32 without padding', () => {
		expect(base32Encode(Buffer.from('48656c6c6f21deadbeef', 'hex'))).toBe('JBSWY3DPEHPK3PXP');
	});

	test('matches RFC 6238 SHA-1 vectors', () => {
		const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
		const cases: Array<[number, string]> = [
			[59, '94287082'],
			[1_111_111_109, '07081804'],
			[1_111_111_111, '14050471'],
			[1_234_567_890, '89005924'],
			[2_000_000_000, '69279037'],
			[20_000_000_000, '65353130']
		];

		for (const [timestamp, expected] of cases) {
			expect(generateTotp(secret, timestamp * 1000, { digits: 8 })).toBe(expected);
		}
	});

	test('generates 6 digit Google Authenticator style codes by default', () => {
		expect(generateTotp('JBSWY3DPEHPK3PXP', 59_000)).toMatch(/^\d{6}$/);
	});

	test('reports remaining seconds in the current step', () => {
		expect(totpSecondsRemaining(1_000)).toBe(29);
		expect(totpSecondsRemaining(30_000)).toBe(30);
	});

	test('decodes Google Authenticator migration URIs', () => {
		const [account] = decodeOtpauthMigrationUri(
			'otpauth-migration://offline?data=CloKFLFxESxNInmwVrNug%2BND%2FsFUS6PvEhxlcmljbGVzLWNhcnZhbGhvQGhvdG1haWwuY29tGglBQkMgLSBFVk8gASgBMAJCEzE3ODk1OTI5OTQwNzNGQkFBRjUQAhgBIAA%3D'
		);

		expect(account).toMatchObject({
			issuer: 'ABC - EVO',
			name: 'ericles-carvalho@hotmail.com',
			secretBase32: 'WFYRCLCNEJ43AVVTN2B6GQ76YFKEXI7P',
			algorithm: 'SHA1',
			digits: 6,
			type: 'TOTP'
		});
	});
});
