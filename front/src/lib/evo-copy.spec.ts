import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyEvoData, evoCopyPayload } from './evo-copy';
import type { Attendance } from './types';

const attendance = {
	lead_name: 'João',
	lead_email: 'joao@example.com',
	whatsapp_e164: '+5516999998888'
} as Attendance;
const fields = {
	surname: ' Silva ',
	cpf: '123.456.789-00',
	birthDate: '2000-02-01',
	gender: 'Masculino',
	cep: '14000-000',
	visitType: 'Pessoal',
	howFoundUs: 'Indicação'
};
afterEach(() => vi.unstubAllGlobals());

describe('native EVO copy', () => {
	it('passes the unsaved form values and Brazilian date to the native macro', () => {
		expect(evoCopyPayload(attendance, fields)).toEqual({
			nome: 'João',
			sobrenome: 'Silva',
			cpf: '12345678900',
			nascimento: '01/02/2000',
			genero: 'Masculino',
			cep: '14000000',
			telefone: '+5516999998888',
			email: 'joao@example.com',
			tipoVisita: 'Pessoal',
			comoConheceu: 'Indicação'
		});
	});
	it('prepares the macro without writing an event or requiring the clipboard', async () => {
		const prepare = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('window', { skyfitEvoCopy: prepare });
		await copyEvoData(attendance, fields);
		expect(prepare).toHaveBeenCalledExactlyOnceWith(evoCopyPayload(attendance, fields));
	});
	it('explains when an updated desktop is required', async () => {
		vi.stubGlobal('window', {});
		await expect(copyEvoData(attendance, fields)).rejects.toThrow('Skyfit EVO atualizado');
	});
	it('preserves native hotkey errors for the UI', async () => {
		vi.stubGlobal('window', { skyfitEvoCopy: vi.fn().mockRejectedValue('Atalho em uso') });
		await expect(copyEvoData(attendance, fields)).rejects.toThrow('Atalho em uso');
	});
});
