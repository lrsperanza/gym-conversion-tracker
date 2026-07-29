import { ApiError } from '$lib/api/client';
import type { Role } from '$lib/types';

export function errorMessage(error: unknown, fallback = 'Não foi possível concluir a ação.') {
	if (error instanceof ApiError) {
		return error.status === 403 ? 'Ação não permitida para seu perfil.' : error.message;
	}
	return error instanceof Error ? error.message : fallback;
}

export function statusLabel(status: string) {
	const labels: Record<string, string> = {
		DRAFT: 'Rascunho',
		IN_PROGRESS: 'Em atendimento',
		PENDING: 'Pendente',
		FINALIZED: 'Finalizado'
	};
	return labels[status] ?? status;
}

export function roleLabel(role: Role) {
	const labels: Record<Role, string> = {
		ADMIN: 'Admin',
		SOCIO: 'Sócio',
		GERENTE_REGIONAL: 'Gerente regional',
		LIDER: 'Líder',
		RECEPCIONISTA: 'Recepcionista'
	};
	return labels[role];
}

export function formatDay(value?: string | null) {
	if (!value) return '-';
	return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(
		new Date(value)
	);
}

export function asCents(value: string) {
	if (!value.trim()) return undefined;
	const parsed = Number(value.replace(/\./g, '').replace(',', '.'));
	return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined;
}

export function dateToIso(value: string, endOfDay = false) {
	if (!value) return '';
	const [year, month, day] = value.split('-').map(Number);
	return new Date(
		year,
		month - 1,
		day,
		endOfDay ? 23 : 0,
		endOfDay ? 59 : 0,
		endOfDay ? 59 : 0
	).toISOString();
}

export function queryString(params: Record<string, string | null | undefined>) {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value) search.set(key, value);
	}
	const query = search.toString();
	return query ? `?${query}` : '';
}
