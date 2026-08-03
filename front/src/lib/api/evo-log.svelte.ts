import { browser } from '$app/environment';
import type { BridgeDiagnostics } from './bridge';

export const EVO_LOG_PREFIX = '[EVO-BRIDGE]';

export type EvoLogLevel = 'info' | 'warn' | 'error';

export type EvoLogEntry = {
	id: number;
	at: string;
	level: EvoLogLevel;
	message: string;
	data?: Record<string, unknown>;
};

const STORAGE_KEY = 'skyfit:evo-log';
const MAX_ENTRIES = 300;

let entries = $state<EvoLogEntry[]>(restore());
let diagnostics = $state<BridgeDiagnostics | null>(null);
let diagnosticsOpen = $state(false);

export function evoLog(message: string, data?: Record<string, unknown>) {
	append('info', message, data);
}

export function evoWarn(message: string, data?: Record<string, unknown>) {
	append('warn', message, data);
}

export function evoError(message: string, data?: Record<string, unknown>) {
	append('error', message, data);
}

export function evoLogEntries(): EvoLogEntry[] {
	return entries;
}

export function clearEvoLog() {
	entries = [];
	persist();
}

/** Flat text of the whole buffer, meant to be copied out of the desktop app and shared. */
export function evoLogText(): string {
	return entries
		.map((entry) => {
			const head = `${entry.at} ${entry.level.toUpperCase()} ${EVO_LOG_PREFIX} ${entry.message}`;
			return entry.data ? `${head}\n    ${stringify(entry.data)}` : head;
		})
		.join('\n');
}

/** Result of the last bridge detection, kept here so the diagnostics panel reacts to it. */
export function evoDiagnostics(): BridgeDiagnostics | null {
	return diagnostics;
}

export function setEvoDiagnostics(value: BridgeDiagnostics) {
	diagnostics = value;
}

export function isEvoDiagnosticsOpen(): boolean {
	return diagnosticsOpen;
}

export function setEvoDiagnosticsOpen(value: boolean) {
	diagnosticsOpen = value;
}

export function openEvoDiagnostics() {
	diagnosticsOpen = true;
}

export function describeError(error: unknown): Record<string, unknown> {
	if (error instanceof DOMException) {
		return { tipo: 'DOMException', nome: error.name, mensagem: error.message };
	}
	if (error instanceof Error) {
		return { tipo: error.name, mensagem: error.message, stack: error.stack };
	}
	return { tipo: typeof error, mensagem: String(error) };
}

function append(level: EvoLogLevel, message: string, data?: Record<string, unknown>) {
	const entry: EvoLogEntry = {
		id: (entries.at(-1)?.id ?? 0) + 1,
		at: new Date().toISOString(),
		level,
		message,
		data: data ? serializable(data) : undefined
	};

	entries = [...entries, entry].slice(-MAX_ENTRIES);
	writeToConsole(entry);
	persist();
}

function writeToConsole(entry: EvoLogEntry) {
	const line = `${EVO_LOG_PREFIX} ${entry.message}`;
	const write =
		entry.level === 'error' ? console.error : entry.level === 'warn' ? console.warn : console.log;

	if (entry.data) write(line, entry.data);
	else write(line);
}

/** Errors and DOM objects do not survive JSON, so they are unwrapped before storing. */
function serializable(data: Record<string, unknown>): Record<string, unknown> {
	try {
		return JSON.parse(
			JSON.stringify(data, (_key, value) => (value instanceof Error ? describeError(value) : value))
		);
	} catch {
		return { detalhe: String(data) };
	}
}

function stringify(data: Record<string, unknown>) {
	try {
		return JSON.stringify(data);
	} catch {
		return String(data);
	}
}

function persist() {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
	} catch {
		/* A full or blocked storage must never break the flow being logged. */
	}
}

function restore(): EvoLogEntry[] {
	if (!browser) return [];
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		const parsed = stored ? JSON.parse(stored) : null;
		return Array.isArray(parsed) ? (parsed as EvoLogEntry[]).slice(-MAX_ENTRIES) : [];
	} catch {
		return [];
	}
}
