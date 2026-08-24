import { VideoExtractorError } from './errors';

const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?$/;

export type ZoneParts = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = formatterCache.get(timeZone);
	if (!formatter) {
		try {
			formatter = new Intl.DateTimeFormat('en-US', {
				timeZone,
				hourCycle: 'h23',
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit'
			});
		} catch {
			throw new VideoExtractorError('CONFIG_ERROR', `Fuso horario desconhecido "${timeZone}".`);
		}
		formatterCache.set(timeZone, formatter);
	}
	return formatter;
}

export function partsInZone(date: Date, timeZone: string): ZoneParts {
	const out: Partial<Record<string, number>> = {};
	for (const part of getFormatter(timeZone).formatToParts(date)) {
		if (part.type !== 'literal') out[part.type] = Number(part.value);
	}
	return {
		year: out.year!,
		month: out.month!,
		day: out.day!,
		hour: out.hour! % 24,
		minute: out.minute!,
		second: out.second!
	};
}

function zoneOffsetMs(date: Date, timeZone: string): number {
	const parts = partsInZone(date, timeZone);
	const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function zonedTimeToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	timeZone: string
): Date {
	const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
	const offset = zoneOffsetMs(new Date(utcGuess), timeZone);
	return new Date(utcGuess - offset);
}

function invalidTimestamp(input: string, timeZone: string): VideoExtractorError {
	return new VideoExtractorError(
		'INVALID_ARGUMENTS',
		`Horario invalido "${input}". Use ISO-8601 ou data/hora local interpretada em ${timeZone}.`
	);
}

export function parseTimestamp(input: string, timeZone: string): Date {
	const value = input.trim();
	if (!value) throw invalidTimestamp(input, timeZone);

	if (OFFSET_SUFFIX.test(value)) {
		const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
		const date = new Date(normalized);
		if (Number.isNaN(date.getTime())) throw invalidTimestamp(input, timeZone);
		return date;
	}

	const match = NAIVE_PATTERN.exec(value);
	if (!match) throw invalidTimestamp(input, timeZone);

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = match[4] !== undefined ? Number(match[4]) : 0;
	const minute = match[5] !== undefined ? Number(match[5]) : 0;
	const second = match[6] !== undefined ? Number(match[6]) : 0;
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
		throw invalidTimestamp(input, timeZone);
	}

	const date = zonedTimeToUtc(year, month, day, hour, minute, second, timeZone);
	const roundTrip = partsInZone(date, timeZone);
	if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day) throw invalidTimestamp(input, timeZone);
	return date;
}

export function validateRange(start: Date, end: Date): void {
	if (start.getTime() === end.getTime()) {
		throw new VideoExtractorError('INVALID_ARGUMENTS', 'Intervalo invalido: inicio e fim sao identicos.');
	}
	if (start.getTime() > end.getTime()) {
		throw new VideoExtractorError('INVALID_ARGUMENTS', 'Intervalo invalido: inicio depois do fim.');
	}
}

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

export function formatDvrTimestamp(date: Date, timeZone: string): string {
	const parts = partsInZone(date, timeZone);
	return `${parts.year}_${pad2(parts.month)}_${pad2(parts.day)}_${pad2(parts.hour)}_${pad2(parts.minute)}_${pad2(parts.second)}`;
}

export function formatFilenameTimestamp(date: Date, timeZone: string): string {
	const parts = partsInZone(date, timeZone);
	return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}_${pad2(parts.hour)}-${pad2(parts.minute)}-${pad2(parts.second)}`;
}
