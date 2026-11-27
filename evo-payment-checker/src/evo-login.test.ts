import { describe, expect, test } from 'bun:test';
import { nextLoginStep } from './evo-login.ts';

const user = { idFilial: 320, idFilialCripto: 'x', idW12Cripto: 'y', idW12: 1 };

describe('nextLoginStep', () => {
	test('token direto (EVO dispensou o 2FA)', () => {
		expect(nextLoginStep({ tokenAcesso: 't', usuario: user })).toEqual({ kind: 'done', token: 't', user });
	});

	test('2FA por app com chaveOTP', () => {
		expect(nextLoginStep({ flPossuiMfa: true, flLoginValidado: false, chaveOTP: 'abc' })).toEqual({
			kind: 'totp',
			chaveOTP: 'abc'
		});
	});

	test('2FA por app sem chaveOTP segue para a etapa 3 mesmo assim', () => {
		expect(nextLoginStep({ flPossuiMfa: true, flLoginValidado: false, chaveOTP: null })).toEqual({
			kind: 'totp',
			chaveOTP: null
		});
		expect(nextLoginStep({ flPossuiMfa: true, flLoginValidado: false })).toEqual({ kind: 'totp', chaveOTP: null });
	});

	test('código por e-mail e senha expirada viram erro legível', () => {
		expect(nextLoginStep({ flPossuiDuploFator: true, flLoginValidado: false }).kind).toBe('error');
		expect(nextLoginStep({ flSenhaExpirada: true }).kind).toBe('error');
	});

	test('resposta desconhecida lista os campos (sem valores)', () => {
		const next = nextLoginStep({ tokenAcesso: undefined } as never);
		expect(next).toEqual({ kind: 'error', message: expect.stringContaining('campos: tokenAcesso') });
	});
});
