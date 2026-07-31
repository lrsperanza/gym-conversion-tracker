import { getBridgeBaseUrl } from './bridge';

const API_URL = (import.meta.env.PUBLIC_API_URL || 'http://localhost:3000').replace(/\/$/, '');

export class ApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly details?: unknown
	) {
		super(message);
	}
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
	const response = await fetch(`${await apiBaseUrl()}${path}`, {
		...options,
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			...options.headers
		}
	});

	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		throw new ApiError(
			payload?.error?.message || 'Erro na API.',
			response.status,
			payload?.error?.details
		);
	}

	return payload as T;
}

async function apiBaseUrl() {
	return (await getBridgeBaseUrl()) === '' ? '' : API_URL;
}

export function money(valueCents?: number | null) {
	return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
		(valueCents || 0) / 100
	);
}

export function percent(value?: number | null) {
	return new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 }).format(
		value || 0
	);
}

export function dateTime(value?: string | null) {
	if (!value) return '-';
	return new Intl.DateTimeFormat('pt-BR', {
		dateStyle: 'short',
		timeStyle: 'short',
		timeZone: 'America/Sao_Paulo'
	}).format(new Date(value));
}
