import { ApiError } from '$lib/api/client';
import type { Attendance, AttendanceChannel, AttendanceEventType, Role } from '$lib/types';

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

export function channelLabel(channel?: AttendanceChannel | string | null) {
	const labels: Record<AttendanceChannel, string> = {
		PRESENCIAL: 'Presencial',
		ONLINE: 'Online'
	};
	return channel === 'PRESENCIAL' || channel === 'ONLINE' ? labels[channel] : 'Presencial';
}

export function eventTypeLabel(type?: AttendanceEventType | string | null) {
	const labels: Record<string, string> = {
		LEAD_CREATED: 'Lead criado',
		TOUR_RECEPTIONIST: 'Atendimento aberto (recepção)',
		TOUR_PROFESSOR: 'Atendimento aberto (professor)',
		SALE: 'Venda',
		LOSS: 'Perda',
		EXPERIMENTAL_CLASS_SCHEDULED: 'Aula experimental agendada',
		EXPERIMENTAL_CLASS_NOW: 'Aula experimental agora',
		FOLLOW_UP_SCHEDULED: 'Follow-up agendado',
		SCHEDULE_CANCELLED: 'Agendamento cancelado',
		OTHER: 'Outro evento',
		REOPEN: 'Reabertura',
		NOTE: 'Nota',
		CLOSE: 'Atendimento fechado'
	};
	return type ? (labels[type] ?? type) : 'Evento';
}

export function eventToneClass(type?: AttendanceEventType | string | null) {
	const tones: Record<string, string> = {
		SALE: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
		LOSS: 'bg-red-50 text-red-800 ring-red-200',
		EXPERIMENTAL_CLASS_SCHEDULED: 'bg-sky-50 text-sky-800 ring-sky-200',
		FOLLOW_UP_SCHEDULED: 'bg-sky-50 text-sky-800 ring-sky-200',
		EXPERIMENTAL_CLASS_NOW: 'bg-indigo-50 text-indigo-800 ring-indigo-200',
		SCHEDULE_CANCELLED: 'bg-amber-50 text-amber-900 ring-amber-200',
		REOPEN: 'bg-violet-50 text-violet-800 ring-violet-200',
		CLOSE: 'bg-slate-200 text-slate-800 ring-slate-300'
	};
	return type
		? (tones[type] ?? 'bg-slate-100 text-slate-700 ring-slate-200')
		: 'bg-slate-100 text-slate-700 ring-slate-200';
}

export function isScheduledEventType(type?: AttendanceEventType | string | null) {
	return type === 'EXPERIMENTAL_CLASS_SCHEDULED' || type === 'FOLLOW_UP_SCHEDULED';
}

export function isImminent(scheduledFor?: string | null, now = new Date()) {
	if (!scheduledFor) return false;
	const scheduledAt = new Date(scheduledFor).getTime();
	if (!Number.isFinite(scheduledAt)) return false;
	return scheduledAt - now.getTime() <= 15 * 60 * 1000;
}

export function isQueueVisible(
	attendance: Pick<Attendance, 'status' | 'next_scheduled_for'>,
	now = new Date()
) {
	if (attendance.status === 'FINALIZED') return false;
	if (attendance.status !== 'PENDING' || !attendance.next_scheduled_for) return true;
	return isImminent(attendance.next_scheduled_for, now);
}

export function parsePhone(raw: string) {
	let digits = raw.replace(/\D/g, '');
	if (digits.startsWith('55') && digits.length >= 12) digits = digits.slice(2);
	if (digits.startsWith('0') && digits.length >= 11) digits = digits.slice(1);
	if (digits.length < 8) return null;
	if (digits.length <= 9) return { countryCode: '55', areaCode: '16', number: digits };
	return { countryCode: '55', areaCode: digits.slice(0, 2), number: digits.slice(2) };
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
