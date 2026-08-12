const VALUE_SUFFIX = /\s*[-·]?\s*R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}\s*$/;

export type PlanLabel = {
	label: string;
	valueCents: number | null;
};

export function buildPlanLabel(label: string, valueCents?: number | null): PlanLabel {
	const baseLabel = stripValueSuffix(label);
	if (valueCents === null || valueCents === undefined) return { label: baseLabel, valueCents: null };

	const adjustedValueCents = isRecorrente(baseLabel) ? valueCents * 2 : valueCents;
	return {
		label: `${baseLabel} · ${formatBRL(adjustedValueCents)}`,
		valueCents: adjustedValueCents
	};
}

export function formatBRL(valueCents: number): string {
	return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
		.format(valueCents / 100)
		.replace(/\u00a0/g, ' ');
}

export function isRecorrente(label: string): boolean {
	return label
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.includes('recorrente');
}

function stripValueSuffix(label: string): string {
	return label.replace(VALUE_SUFFIX, '').replace(/\s+/g, ' ').trim();
}
