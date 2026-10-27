import { describe, expect, test } from 'bun:test';
import { decide, nameMatches, parseEvoDate, pickCandidates, type EvoClient, type EvoVenda, type Lead } from './matching.ts';

const lead: Lead = {
	name: 'Janderson',
	surname: 'Trindade',
	cpf: null,
	email: null,
	whatsapp: '+5516997289013'
};

const client = (id: number, nome: string, telefone: string | null = null): EvoClient => ({
	idCliente: id,
	idProspect: 0,
	nomeCompleto: nome,
	telefoneAtual: telefone
});

// Venda real observada no EVO (cliente 3950126), resumida.
const vendaPaga: EvoVenda = {
	idVenda: 18653404,
	itensVenda: 'Contrato - PLANO PRIME MENSAL TODAS UNIDADES 169,90 2026',
	dtVenda: '2026-10-23T06:43:00',
	valorVenda: 169.9,
	valorPago: 169.9,
	valorPagar: 0,
	recebimentos: [{ dsTipoRecebimento: 'Cartão de Débito', dsStatusRecebimento: 'Pago', valorPago: 169.9 }]
};

const base = {
	sale: { createdAt: new Date('2026-10-23T09:50:00Z'), amountCents: 16990 },
	usedEvoSaleIds: new Set<number>(),
	windowStart: new Date('2026-10-21T09:50:00Z'),
	now: new Date('2026-10-24T04:00:00Z'),
	pendingMaxDays: 30
};

describe('nameMatches', () => {
	test('ignora acento, caixa e preposições', () => {
		expect(nameMatches({ ...lead, name: 'Letícia', surname: 'de Garbelini' }, client(1, 'Leticia Garbelini'))).toBe(true);
	});
	test('nome do EVO pode ter mais sobrenomes', () => {
		expect(nameMatches(lead, client(1, 'Janderson Silva TRINDADE'))).toBe(true);
	});
	test('token faltando não casa', () => {
		expect(nameMatches(lead, client(1, 'Janderson Souza'))).toBe(false);
	});
	test('nome de um token só exige telefone', () => {
		const single = { ...lead, surname: null };
		expect(nameMatches(single, client(1, 'Janderson Souza'))).toBe(false);
		expect(nameMatches(single, client(1, 'Janderson Souza', '(16) 99728-9013'))).toBe(true);
	});
});

describe('pickCandidates', () => {
	test('CPF/e-mail têm prioridade sobre nome', () => {
		const result = pickCandidates(lead, [
			{ source: 'cpf', clients: [client(10, 'Outro Nome')] },
			{ source: 'nome', clients: [client(11, 'Janderson Trindade')] }
		]);
		expect(result.map((candidate) => candidate.client.idCliente)).toEqual([10]);
	});
	test('telefone desempata homônimos e prospects ficam de fora', () => {
		const result = pickCandidates(lead, [
			{
				source: 'nome',
				clients: [
					client(11, 'Janderson Trindade', '16 3333-0000'),
					client(12, 'Janderson Trindade', '16 99728-9013'),
					{ ...client(0, 'Janderson Trindade'), idProspect: 99 }
				]
			}
		]);
		expect(result.map((candidate) => candidate.client.idCliente)).toEqual([12]);
	});
});

describe('decide', () => {
	test('venda paga no EVO vira PAGO', () => {
		const decision = decide({
			...base,
			candidates: [{ client: client(3950126, 'Janderson TRINDADE'), source: 'nome' }],
			vendasByClient: new Map([[3950126, [vendaPaga]]])
		});
		expect(decision.status).toBe('PAGO');
		expect(decision.evoSaleId).toBe(18653404);
		expect(decision.evoPaidCents).toBe(16990);
	});

	test('venda EVO já usada por outro lançamento não confirma de novo', () => {
		const decision = decide({
			...base,
			usedEvoSaleIds: new Set([18653404]),
			candidates: [{ client: client(3950126, 'Janderson TRINDADE'), source: 'nome' }],
			vendasByClient: new Map([[3950126, [vendaPaga]]])
		});
		expect(decision.status).toBe('PAGAMENTO_PENDENTE');
	});

	test('venda em aberto fica pendente', () => {
		const decision = decide({
			...base,
			candidates: [{ client: client(1, 'Janderson Trindade'), source: 'nome' }],
			vendasByClient: new Map([[1, [{ ...vendaPaga, valorPago: 0, valorPagar: 169.9 }]]])
		});
		expect(decision.status).toBe('PAGAMENTO_PENDENTE');
		expect(decision.note).toContain('em aberto');
	});

	test('sem cliente e fora do prazo vira NAO_PAGO', () => {
		const decision = decide({
			...base,
			now: new Date('2026-12-01T04:00:00Z'),
			candidates: [],
			vendasByClient: new Map()
		});
		expect(decision.status).toBe('NAO_PAGO');
	});

	test('venda anterior à janela é ignorada', () => {
		const decision = decide({
			...base,
			candidates: [{ client: client(1, 'Janderson Trindade'), source: 'nome' }],
			vendasByClient: new Map([[1, [{ ...vendaPaga, dtVenda: '2026-09-01T10:00:00' }]]])
		});
		expect(decision.status).toBe('PAGAMENTO_PENDENTE');
	});

	test('contrato de agregador (valor zero) só confirma venda zero', () => {
		const zero = { ...vendaPaga, valorVenda: 0, valorPago: 0 };
		const args = {
			...base,
			candidates: [{ client: client(1, 'Janderson Trindade'), source: 'nome' as const }],
			vendasByClient: new Map([[1, [zero]]])
		};
		expect(decide(args).status).toBe('PAGAMENTO_PENDENTE');
		expect(decide({ ...args, sale: { ...base.sale, amountCents: 0 } }).status).toBe('PAGO');
	});
});

test('parseEvoDate assume horário de Brasília', () => {
	expect(parseEvoDate('2026-10-23T06:43:00').toISOString()).toBe('2026-10-23T09:43:00.000Z');
});
