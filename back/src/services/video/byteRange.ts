export type ByteRange = { start: number; end: number };

export function parseRangeHeader(value: string | undefined, size: number): ByteRange | null | 'invalid' {
	if (!value) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
	if (!match) return 'invalid';
	const [, rawStart, rawEnd] = match;
	if (!rawStart && !rawEnd) return 'invalid';
	if (size <= 0) return 'invalid';

	if (!rawStart) {
		const suffixLength = Number(rawEnd);
		if (!Number.isInteger(suffixLength) || suffixLength <= 0) return 'invalid';
		return { start: Math.max(0, size - suffixLength), end: size - 1 };
	}

	const start = Number(rawStart);
	const end = rawEnd ? Number(rawEnd) : size - 1;
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return 'invalid';
	return { start, end: Math.min(end, size - 1) };
}
