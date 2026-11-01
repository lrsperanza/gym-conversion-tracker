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

export type MatchSource = 'cpf' | 'email' | 'relatorio' | 'nome';

/**
 * Linha de `POST evo3…/Gerencial/Vendas/listarVendas` (Gerencial › Vendas,
 * tipo "Contrato"). `NOME_COMPRADOR` traz o(s) primeiro(s) nome(s) e
 * `APELIDO` o sobrenome; `DT_VENDA` vem no horário da unidade, sem fuso.
 */
export type EvoReportRow = {
	ID_VENDA: number;
	ID_COMPRADOR: number;
	NOME_COMPRADOR: string | null;
	APELIDO: string | null;
	ID_FUNCIONARIO_VENDA: number | null;
	NOME_FUNCIONARIO_VENDA: string | null;
	VALOR_VENDA: number | null;
	FORMA_PAGAMENTO: string | null;
	DT_VENDA: string;
	TIPO_COMPRADOR?: string | null;
};
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

/** "HELOISE FRANCELINO ID: 14500" → tokens do nome, sem o sufixo de ID. */
export function sellerTokens(value: string | null | undefined): string[] {
	return nameTokens((value ?? '').replace(/\bID:\s*\d+\s*$/i, ''));
}

/** O colaborador do tracker costuma ter só o primeiro nome cadastrado; o primeiro token decide. */
export function sellerMatches(trackerSeller: string | null | undefined, evoSeller: string | null | undefined): boolean {
	const a = sellerTokens(trackerSeller);
	const b = sellerTokens(evoSeller);
	return a.length > 0 && b.length > 0 && a[0] === b[0];
}

export function reportBuyerName(row: EvoReportRow): string {
	return [row.NOME_COMPRADOR, row.APELIDO].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

const sameDay = (a: Date, b: Date) =>
	a.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) ===
	b.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/**
 * Vendas do relatório Gerencial › Vendas que podem ser deste lead:
 * - nome completo do lead contido no nome do comprador; ou
 * - mesmo primeiro nome, mesmo colaborador da venda e mesmo dia (lead
 *   cadastrado só com o primeiro nome, ou com sobrenome diferente).
 * Linhas fora de [windowStart, ∞) são ignoradas.
 */
export function reportCandidates(
	lead: Lead,
	sale: { createdAt: Date; sellerName: string | null },
	rows: EvoReportRow[],
	windowStart: Date
): EvoClient[] {
	const leadTokens = nameTokens(leadFullName(lead));
	if (leadTokens.length === 0) return [];
	const clients = new Map<number, EvoClient>();
	for (const row of rows) {
		if (!row.ID_COMPRADOR) continue;
		const date = parseEvoDate(row.DT_VENDA);
		if (date < windowStart) continue;
		const client: EvoClient = { idCliente: row.ID_COMPRADOR, idProspect: 0, nomeCompleto: reportBuyerName(row) };
		const buyerTokens = new Set(nameTokens(client.nomeCompleto));
		const fullName = leadTokens.length >= 2 && leadTokens.every((token) => buyerTokens.has(token));
		const firstNameSameSellerSameDay =
			buyerTokens.has(leadTokens[0]!) &&
			sellerMatches(sale.sellerName, row.NOME_FUNCIONARIO_VENDA) &&
			sameDay(date, sale.createdAt);
		if (fullName || firstNameSameSellerSameDay) clients.set(client.idCliente, client);
	}
	return [...clients.values()];
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
	const strong = candidates.filter((candidate) => candidate.source === 'cpf' || candidate.source === 'email');
	if (strong.length > 0) return strong;
	const fromReport = candidates.filter((candidate) => candidate.source === 'relatorio');
	if (fromReport.length > 0) return fromReport;

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
	/** `dtVenda` da venda do EVO que confirmou o pagamento. */
	evoSoldAt: Date | null;
};

export type DecisionInput = {
	sale: { createdAt: Date; amountCents: number };
	candidates: Candidate[];
	/** Vendas do EVO por idCliente, já filtradas pela janela de datas da consulta. */
	vendasByClient: Map<number, EvoVenda[]>;
	usedEvoSaleIds: Set<number>;
	windowStart: Date;
	/** Venda no EVO depois disso já é outra compra (ex.: renovação do mês seguinte). */
	windowEnd?: Date;
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
			note: `Cliente não encontrado no EVO (relatório de vendas, CPF, e-mail e nome).${prazo}`,
			evoClientId: null,
			evoSaleId: null,
			evoPaidCents: null,
			evoSoldAt: null
		};
	}

	type Option = { clientId: number; venda: EvoVenda; date: Date };
	const options: Option[] = [];
	for (const { client } of candidates) {
		for (const venda of vendasByClient.get(client.idCliente) ?? []) {
			const date = parseEvoDate(venda.dtVenda);
			if (date < windowStart) continue;
			if (input.windowEnd && date > input.windowEnd) continue;
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
			evoPaidCents: Math.round(best.venda.valorPago * 100),
			evoSoldAt: best.date
		};
	}

	const ids = candidates.map((candidate) => `#${candidate.client.idCliente}`).join(', ');
	const open = options.filter((option) => option.venda.valorPagar > 0);
	const detail =
		open.length > 0
			? `venda EVO #${open[0]!.venda.idVenda} em aberto (${money(open[0]!.venda.valorPagar)} a pagar)`
			: options.length > 0
				? 'vendas no EVO já usadas por outros lançamentos ou sem valor'
				: `nenhuma venda no EVO entre ${day(windowStart)} e ${day(input.windowEnd ?? input.now)}`;
	return {
		status: unpaidStatus,
		note: `Cliente EVO ${ids}: ${detail}.${prazo}`,
		evoClientId: candidates.length === 1 ? candidates[0]!.client.idCliente : null,
		evoSaleId: null,
		evoPaidCents: null,
		evoSoldAt: null
	};
}
