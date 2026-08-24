import { describe, expect, test } from "bun:test";
import {
  parseTimestamp,
  validateRange,
  formatDvrTimestamp,
  formatFilenameTimestamp,
  zonedTimeToUtc,
} from "../src/datetime.ts";
import { ExtractorError } from "../src/errors.ts";

const TZ = "America/Sao_Paulo";

describe("parseTimestamp", () => {
  test("ISO-8601 with explicit offset is honored", () => {
    const d = parseTimestamp("2026-08-24T09:30:00-03:00", TZ);
    expect(d.toISOString()).toBe("2026-08-24T12:30:00.000Z");
  });

  test("Z suffix is honored", () => {
    const d = parseTimestamp("2026-08-24T12:30:00Z", TZ);
    expect(d.toISOString()).toBe("2026-08-24T12:30:00.000Z");
  });

  test("offset without colon is normalized", () => {
    const d = parseTimestamp("2026-08-24T09:30:00-0300", TZ);
    expect(d.toISOString()).toBe("2026-08-24T12:30:00.000Z");
  });

  test("offset-less timestamp is interpreted in America/Sao_Paulo (not UTC)", () => {
    const d = parseTimestamp("2026-08-24 09:30:00", TZ);
    // August in Sao Paulo is UTC-3 (no DST since 2019)
    expect(d.toISOString()).toBe("2026-08-24T12:30:00.000Z");
  });

  test("offset-less timestamp with T separator also works", () => {
    const d = parseTimestamp("2026-08-24T09:30:00", TZ);
    expect(d.toISOString()).toBe("2026-08-24T12:30:00.000Z");
  });

  test("rejects garbage", () => {
    expect(() => parseTimestamp("not a date", TZ)).toThrow(ExtractorError);
  });

  test("rejects impossible dates (Feb 30)", () => {
    expect(() => parseTimestamp("2026-02-30 10:00:00", TZ)).toThrow(
      ExtractorError,
    );
  });

  test("rejects out-of-range month", () => {
    expect(() => parseTimestamp("2026-13-10 10:00:00", TZ)).toThrow(
      ExtractorError,
    );
  });

  test("rejects empty input", () => {
    expect(() => parseTimestamp("   ", TZ)).toThrow(ExtractorError);
  });
});

describe("zonedTimeToUtc", () => {
  test("converts a Sao Paulo local wall-clock time to UTC", () => {
    const d = zonedTimeToUtc(2026, 1, 15, 12, 0, 0, TZ);
    expect(d.toISOString()).toBe("2026-01-15T15:00:00.000Z");
  });
});

describe("formatDvrTimestamp", () => {
  test("formats an instant as YYYY_MM_DD_HH_MM_SS in DVR local time", () => {
    const d = parseTimestamp("2026-08-24T09:30:00-03:00", TZ);
    expect(formatDvrTimestamp(d, TZ)).toBe("2026_08_24_09_30_00");
  });

  test("converts from other offsets into DVR local time", () => {
    const d = parseTimestamp("2026-08-24T12:30:00Z", TZ);
    expect(formatDvrTimestamp(d, TZ)).toBe("2026_08_24_09_30_00");
  });

  test("zero-pads single-digit fields", () => {
    const d = parseTimestamp("2026-03-05T07:04:09-03:00", TZ);
    expect(formatDvrTimestamp(d, TZ)).toBe("2026_03_05_07_04_09");
  });
});

describe("formatFilenameTimestamp", () => {
  test("produces filesystem-safe timestamps", () => {
    const d = parseTimestamp("2026-08-24T09:30:00-03:00", TZ);
    expect(formatFilenameTimestamp(d, TZ)).toBe("2026-08-24_09-30-00");
  });
});

describe("validateRange", () => {
  const start = parseTimestamp("2026-08-24T09:30:00-03:00", TZ);

  test("accepts start < end", () => {
    const end = parseTimestamp("2026-08-24T09:35:00-03:00", TZ);
    expect(() => validateRange(start, end)).not.toThrow();
  });

  test("rejects start == end", () => {
    expect(() => validateRange(start, new Date(start))).toThrow(ExtractorError);
  });

  test("rejects start > end", () => {
    const earlier = parseTimestamp("2026-08-24T09:00:00-03:00", TZ);
    expect(() => validateRange(start, earlier)).toThrow(ExtractorError);
  });
});
