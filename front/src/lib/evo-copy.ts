import type { Attendance } from '$lib/types';

type EvoFields = {
	surname: string;
	cpf: string;
	birthDate: string;
	gender: string;
	cep: string;
	visitType: string;
	howFoundUs: string;
};

declare global {
	interface Window {
		skyfitEvoCopy?: (data: Record<string, string>) => Promise<void>;
		skyfitEvoCopyStatus?: () => Promise<string>;
	}
}

export function evoCopyPayload(attendance: Attendance, fields: EvoFields) {
	return {
		nome: attendance.lead_name,
		sobrenome: fields.surname.trim(),
		cpf: fields.cpf.replace(/\D/g, ''),
		nascimento: fields.birthDate.split('-').reverse().join('/'),
		genero: fields.gender,
		cep: fields.cep.replace(/\D/g, ''),
		telefone: attendance.whatsapp_e164 ?? '',
		email: attendance.lead_email ?? '',
		tipoVisita: fields.visitType,
		comoConheceu: fields.howFoundUs
	};
}

export async function copyEvoData(attendance: Attendance, fields: EvoFields) {
	if (!window.skyfitEvoCopy)
		throw new Error('Abra o Skyfit EVO atualizado para usar a cópia dinâmica.');
	try {
		await window.skyfitEvoCopy(evoCopyPayload(attendance, fields));
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error));
	}
}
