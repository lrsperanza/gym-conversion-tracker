/**
 * Regras puras de conferência: quem é o cliente no EVO e se existe venda paga
 * para ele. Sem I/O, para dar para testar com `bun test`.
 */

export type PaymentStatus = 'A_CONFERIR' | 'PAGO' | 'PAGAMENTO_PENDENTE' | 'NAO_PAGO';

/** Linha de `GET /api/v1/clientes/basicos` (só o que usamos). */
export type EvoClient = {
	idCliente: number;
	idProspect: number;
	nomeCompleto: string;
	cpf?: string | null;
	emailAtual?: string | null;
	telefoneAtual?: string | null;
};

export type EvoRecebimento = {
	dsTipoRecebimento?: string | null;
	dsStatusRecebimento?: string | null;
	valorPago?: number | null;
	dtCobranca?: string | null;
};

/** Item de `POST /api/v1/venda/historico-vendas-cliente`. Datas vêm no horário local da unidade, sem fuso. */
export type EvoVenda = {
	idVenda: number;
	itensVenda?: string | null;
	dtVenda: string;
	valorVenda: number;
	valorPago: number;
	valorPagar: number;
	vendaSemRecebimento?: boolean;
	recebimentos?: EvoRecebimento[] | null;
};

export type Lead = {
	name: string;
	surname: string | null;
	cpf: string | null;
	email: string | null;
	whatsapp: string | null;
};

export type MatchSource = 'cpf' | 'email' | 'nome';
export type Candidate = { client: EvoClient; source: MatchSource };

const STOPWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

export const onlyDigits = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '');

export function nameTokens(value: string | null | undefined): string[] {
	return (value ?? '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export function leadFullName(lead: Pick<Lead, 'name' | 'surname'>): string {
	return [lead.name, lead.surname].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/** Compara os últimos 8 dígitos: cobre DDI/DDD presentes ou não de um lado só. */
export function phoneMatches(leadPhone: string | null, evoPhone: string | null | undefined): boolean {
	const a = onlyDigits(leadPhone);
	const b = onlyDigits(evoPhone);
	return a.length >= 8 && b.length >= 8 && a.slice(-8) === b.slice(-8);
}

/**
 * Todo token do nome do lead precisa estar no nome do EVO. Nome de um token só
 * ("Ana") é fraco demais e só vale se o telefone também bater.
 */
export function nameMatches(lead: Lead, client: EvoClient): boolean {
	const leadTokens = nameTokens(leadFullName(lead));
	if (leadTokens.length === 0) return false;
	const evoTokens = new Set(nameTokens(client.nomeCompleto));
	const allPresent = leadTokens.every((token) => evoTokens.has(token));
	if (!allPresent) return false;
	if (leadTokens.length >= 2) return true;
	return phoneMatches(lead.whatsapp, client.telefoneAtual);
}

/**
 * Junta os resultados das buscas (CPF, e-mail, nome) em candidatos únicos.
 * CPF e e-mail são confiáveis por si; nome precisa casar todos os tokens.
 * Prospects (idCliente = 0) não compraram nada no EVO e ficam de fora.
 * Quando há homônimos e o telefone desempata, ficam só os que batem.
 */
export function pickCandidates(lead: Lead, results: Array<{ source: MatchSource; clients: EvoClient[] }>): Candidate[] {
	const byId = new Map<number, Candidate>();
	for (const { source, clients } of results) {
		for (const client of clients) {
			if (!client.idCliente) continue;
			if (source === 'nome' && !nameMatches(lead, client)) continue;
			if (!byId.has(client.idCliente)) byId.set(client.idCliente, { client, source });
		}
	}

	const candidates = [...byId.values()];
	const strong = candidates.filter((candidate) => candidate.source !== 'nome');
	if (strong.length > 0) return strong;

	const byPhone = candidates.filter((candidate) => phoneMatches(lead.whatsapp, candidate.client.telefoneAtual));
	return byPhone.length > 0 ? byPhone : candidates;
}

/** `dtVenda` vem como "2026-10-23T06:43:00" no horário da unidade (Brasília, sem horário de verão). */
export function parseEvoDate(value: string, utcOffset = '-03:00'): Date {
	if (/[zZ]|[+-]\d\d:\d\d$/.test(value)) return new Date(value);
	return new Date(`${value}${utcOffset}`);
}

export function isPaid(venda: EvoVenda, saleAmountCents: number): boolean {
	if (venda.valorPago > 0) return true;
	// Contratos de agregador (Wellhub/TotalPass) têm valor zero no EVO; só valem
	// para vendas que também foram lançadas com valor zero no tracker.
	return venda.valorVenda === 0 && saleAmountCents === 0;
}

export type Decision = {
	status: PaymentStatus;
	note: string;
	evoClientId: number | null;
	evoSaleId: number | null;
	evoPaidCents: number | null;
};

export type DecisionInput = {
	sale: { createdAt: Date; amountCents: number };
	candidates: Candidate[];
	/** Vendas do EVO por idCliente, já filtradas pela janela de datas da consulta. */
	vendasByClient: Map<number, EvoVenda[]>;
	usedEvoSaleIds: Set<number>;
	windowStart: Date;
	now: Date;
	pendingMaxDays: number;
};

const money = (value: number) => `R$ ${value.toFixed(2).replace('.', ',')}`;
const day = (date: Date) => date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

export function decide(input: DecisionInput): Decision {
	const { sale, candidates, vendasByClient, usedEvoSaleIds, windowStart } = input;
	const ageDays = (input.now.getTime() - sale.createdAt.getTime()) / 86_400_000;
	const unpaidStatus: PaymentStatus = ageDays > input.pendingMaxDays ? 'NAO_PAGO' : 'PAGAMENTO_PENDENTE';
	const prazo = unpaidStatus === 'NAO_PAGO' ? ` Prazo de ${input.pendingMaxDays} dias esgotado.` : '';

	if (candidates.length === 0) {
		return {
			status: unpaidStatus,
			note: `Cliente não encontrado no EVO (busca por CPF, e-mail e nome).${prazo}`,
			evoClientId: null,
			evoSaleId: null,
			evoPaidCents: null
		};
	}

	type Option = { clientId: number; venda: EvoVenda; date: Date };
	const options: Option[] = [];
	for (const { client } of candidates) {
		for (const venda of vendasByClient.get(client.idCliente) ?? []) {
			const date = parseEvoDate(venda.dtVenda);
			if (date < windowStart) continue;
			options.push({ clientId: client.idCliente, venda, date });
		}
	}

	const distance = (option: Option) => Math.abs(option.date.getTime() - sale.createdAt.getTime());
	const paid = options
		.filter((option) => !usedEvoSaleIds.has(option.venda.idVenda) && isPaid(option.venda, sale.amountCents))
		.sort((a, b) => distance(a) - distance(b));

	const best = paid[0];
	if (best) {
		const forma = (best.venda.recebimentos ?? [])
			.map((recebimento) => recebimento.dsTipoRecebimento)
			.filter(Boolean)
			.join(', ');
		return {
			status: 'PAGO',
			note:
				`Venda EVO #${best.venda.idVenda} em ${day(best.date)}: pago ${money(best.venda.valorPago)}` +
				(best.venda.valorPagar > 0 ? `, a pagar ${money(best.venda.valorPagar)}` : '') +
				(forma ? ` (${forma})` : '') +
				'.',
			evoClientId: best.clientId,
			evoSaleId: best.venda.idVenda,
			evoPaidCents: Math.round(best.venda.valorPago * 100)
		};
	}

	const ids = candidates.map((candidate) => `#${candidate.client.idCliente}`).join(', ');
	const open = options.filter((option) => option.venda.valorPagar > 0);
	const detail =
		open.length > 0
			? `venda EVO #${open[0]!.venda.idVenda} em aberto (${money(open[0]!.venda.valorPagar)} a pagar)`
			: options.length > 0
				? 'vendas no EVO já usadas por outros lançamentos ou sem valor'
				: `nenhuma venda no EVO desde ${day(windowStart)}`;
	return {
		status: unpaidStatus,
		note: `Cliente EVO ${ids}: ${detail}.${prazo}`,
		evoClientId: candidates.length === 1 ? candidates[0]!.client.idCliente : null,
		evoSaleId: null,
		evoPaidCents: null
	};
}
