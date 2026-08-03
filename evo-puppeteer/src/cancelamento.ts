import type { Page } from 'puppeteer-core';

/**
 * Interrompe um fluxo em andamento a pedido de quem o iniciou. Não é falha de
 * automação: quem cancelou já sabe o que vai acontecer com a aba.
 */
export class CancelamentoError extends Error {
	constructor(motivo: string) {
		super(motivo);
		this.name = 'CancelamentoError';
	}
}

export const isCancelamento = (error: unknown): boolean =>
	error instanceof Error && error.name === 'CancelamentoError';

const cancelamentos = new WeakMap<Page, () => string | null>();

/**
 * Diz como descobrir se o fluxo dono desta aba foi cancelado. Todo laço de
 * espera consulta isso a cada volta, então o fluxo larga a aba em milissegundos
 * em vez de correr até o próprio timeout — é o que permite a um atendimento
 * novo assumir o navegador sem esperar o anterior desistir.
 */
export function registrarCancelamento(page: Page, motivo: () => string | null): void {
	cancelamentos.set(page, motivo);
}

export function limparCancelamento(page: Page): void {
	cancelamentos.delete(page);
}

export function checarCancelamento(page: Page): void {
	const motivo = cancelamentos.get(page)?.();
	if (motivo) throw new CancelamentoError(motivo);
}
