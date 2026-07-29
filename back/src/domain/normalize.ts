export type PhoneParts = {
	countryCode?: string;
	areaCode?: string;
	number: string;
};

export function normalizeName(name: string) {
	return name
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

export function normalizeEmail(email?: string | null) {
	const trimmed = email?.trim().toLowerCase();
	return trimmed || null;
}

export function normalizePhone(parts: PhoneParts) {
	const countryCode = onlyDigits(parts.countryCode || '55');
	const areaCode = onlyDigits(parts.areaCode || '16');
	const number = onlyDigits(parts.number);

	if (number.length < 8) {
		throw new Error('Telefone/WhatsApp precisa ter ao menos 8 dígitos.');
	}

	return {
		countryCode,
		areaCode,
		number,
		e164: `+${countryCode}${areaCode}${number}`
	};
}

export function onlyDigits(value: string) {
	return value.replace(/\D/g, '');
}

