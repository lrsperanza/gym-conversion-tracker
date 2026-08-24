import { ExtractorError } from "./errors.ts";

const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?$/;

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
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new ExtractorError(
        "CONFIG_ERROR",
        `Unknown time zone "${timeZone}".`,
      );
    }
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function partsInZone(date: Date, timeZone: string): ZoneParts {
  const out: Partial<Record<string, number>> = {};
  for (const part of getFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out.year!,
    month: out.month!,
    day: out.day!,
    hour: out.hour! % 24,
    minute: out.minute!,
    second: out.second!,
  };
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = zoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

function invalidTimestamp(input: string, timeZone: string): ExtractorError {
  return new ExtractorError(
    "INVALID_ARGUMENTS",
    `Invalid timestamp "${input}".\n\n` +
      `Expected ISO-8601, e.g. "2026-08-24T09:30:00-03:00", or a local date/time ` +
      `such as "2026-08-24 09:30:00" (interpreted in ${timeZone}).`,
  );
}

export function parseTimestamp(input: string, timeZone: string): Date {
  const s = input.trim();
  if (!s) throw invalidTimestamp(input, timeZone);

  if (OFFSET_SUFFIX.test(s)) {
    // Normalize offsets like "-0300" to "-03:00" for strict parsers.
    const normalized = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) throw invalidTimestamp(input, timeZone);
    return date;
  }

  const m = NAIVE_PATTERN.exec(s);
  if (!m) throw invalidTimestamp(input, timeZone);

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] !== undefined ? Number(m[4]) : 0;
  const minute = m[5] !== undefined ? Number(m[5]) : 0;
  const second = m[6] !== undefined ? Number(m[6]) : 0;

  if (
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 59
  ) {
    throw invalidTimestamp(input, timeZone);
  }

  const date = zonedTimeToUtc(year, month, day, hour, minute, second, timeZone);

  // Round-trip check rejects impossible dates such as Feb 30, which Date.UTC
  // would otherwise silently roll into the next month.
  const rt = partsInZone(date, timeZone);
  if (rt.year !== year || rt.month !== month || rt.day !== day) {
    throw invalidTimestamp(input, timeZone);
  }
  return date;
}

export function validateRange(start: Date, end: Date): void {
  if (start.getTime() === end.getTime()) {
    throw new ExtractorError(
      "INVALID_ARGUMENTS",
      "Invalid interval: --start and --end are identical. The end must be after the start.",
    );
  }
  if (start.getTime() > end.getTime()) {
    throw new ExtractorError(
      "INVALID_ARGUMENTS",
      "Invalid interval: --start is after --end.",
    );
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** DVR playback format: YYYY_MM_DD_HH_MM_SS in the DVR's local time zone. */
export function formatDvrTimestamp(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  return `${p.year}_${pad2(p.month)}_${pad2(p.day)}_${pad2(p.hour)}_${pad2(p.minute)}_${pad2(p.second)}`;
}

/** Filesystem-safe format: 2026-08-24_09-30-00 */
export function formatFilenameTimestamp(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}_${pad2(p.hour)}-${pad2(p.minute)}-${pad2(p.second)}`;
}

export function formatHumanTimestamp(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)} ${timeZone}`;
}
