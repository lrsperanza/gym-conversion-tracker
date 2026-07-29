import { closeDb, sql } from './client';

const outcomeTypes = [
	{ key: 'monthly', label: 'Plano mensal', value: 0, manual: false },
	{ key: 'annual', label: 'Plano anual', value: 0, manual: false },
	{ key: 'recurring', label: 'Plano recorrente', value: 0, manual: false },
	{ key: 'four_months', label: 'Plano quadrimestral', value: 0, manual: false },
	{ key: 'other', label: 'Outro', value: null, manual: true }
] as const;

const lossReasons = [
	{ label: 'Preço.', category: 'PRICE', description: false },
	{ label: 'Localização.', category: 'STRUCTURE', description: false },
	{ label: 'Horário.', category: 'SCHEDULE_MODALITY', description: false },
	{ label: 'Estrutura.', category: 'STRUCTURE', description: false },
	{ label: 'Não gostou da academia.', category: 'STRUCTURE', description: false },
	{ label: 'Vai avaliar posteriormente.', category: 'LEAD_QUALITY', description: false },
	{ label: 'Precisa falar com familiar.', category: 'LEAD_QUALITY', description: false },
	{ label: 'Prefere concorrente.', category: 'APPROACH', description: false },
	{ label: 'Sem intenção real de contratação.', category: 'LEAD_QUALITY', description: false },
	{ label: 'Já era aluno.', category: 'LEAD_QUALITY', description: false },
	{ label: 'Duplicidade.', category: 'LEAD_QUALITY', description: false },
	{ label: 'Apenas visita.', category: 'LEAD_QUALITY', description: false },
	{ label: 'Outro.', category: 'APPROACH', description: true }
] as const;

async function seed() {
	for (const outcome of outcomeTypes) {
		await sql`
			INSERT INTO "gym-conversion-tracker"."outcome_types"
				("key", "label", "kind", "current_value_cents", "requires_manual_value")
			VALUES (${outcome.key}, ${outcome.label}, 'SALE', ${outcome.value}, ${outcome.manual})
			ON CONFLICT ("key") DO UPDATE SET
				"label" = EXCLUDED."label",
				"requires_manual_value" = EXCLUDED."requires_manual_value",
				"updated_at" = now()
		`;
	}

	for (const reason of lossReasons) {
		await sql`
			INSERT INTO "gym-conversion-tracker"."loss_reasons"
				("label", "category", "requires_description")
			VALUES (${reason.label}, ${reason.category}, ${reason.description})
			ON CONFLICT ("label") DO UPDATE SET
				"category" = EXCLUDED."category",
				"requires_description" = EXCLUDED."requires_description",
				"updated_at" = now()
		`;
	}

	console.info('Seed completed');
}

seed()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(closeDb);

