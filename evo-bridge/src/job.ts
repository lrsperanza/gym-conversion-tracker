import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import {
	abrirNovoCadastro,
	conferirCadastro,
	garantirSessao,
	isCancelamento,
	preencherCadastro,
	SELECTORS,
	type Prospect
} from 'evo-puppeteer';
import { forgetEvoConnection, withEvoProfile } from './browser.ts';
import { env } from './env.ts';

const TIMEOUT_MS = env.evoTimeoutMs;

export type EvoPayload = {
	credenciais: {
		usuario: string;
		senha: string;
	};
	unidade: string;
	prospect: Prospect;
};

export type EvoJobStatus = {
	id: string;
	status: 'queued' | 'running' | 'completed' | 'failed';
	message: string;
	result?: Record<string, string>;
	error?: string;
	screenshot?: string;
	createdAt: string;
	updatedAt: string;
};

const jobs = new Map<string, EvoJobStatus>();

export function createEvoJob(payload: EvoPayload): string {
	const id = crypto.randomUUID();
	setJob(id, {
		id,
		status: 'queued',
		message: 'Aguardando navegador EVO.',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	});

	void runJob(id, payload);
	return id;
}

export function getEvoJob(id: string): EvoJobStatus | undefined {
	return jobs.get(id);
}

async function runJob(id: string, payload: EvoPayload): Promise<void> {
	console.info(`[evo] job ${id}: preenchendo "${payload.prospect.nome}".`);
	try {
		await runJobAttempt(id, payload, false);
	} catch (error) {
		if (isCancelamento(error)) {
			updateJob(id, {
				status: 'failed',
				message: 'Preenchimento interrompido: outro atendimento assumiu o navegador do EVO.',
				error: error instanceof Error ? error.message : String(error)
			});
			return;
		}

		updateJob(id, {
			status: 'failed',
			message: 'Falha ao iniciar o navegador EVO.',
			error: error instanceof Error ? error.message : String(error)
		});
	} finally {
		const final = jobs.get(id);
		console.info(`[evo] job ${id}: ${final?.status ?? 'desconhecido'} — ${final?.message ?? ''}`);
	}
}

async function runJobAttempt(id: string, payload: EvoPayload, retriedAfterDisconnect: boolean): Promise<void> {
	try {
		await withEvoProfile(payload.credenciais.usuario, async ({ page }) => {
			await fillEvoRegistration(id, payload, page);
		});
	} catch (error) {
		if (!retriedAfterDisconnect && isBrowserGoneError(error)) {
			forgetEvoConnection(payload.credenciais.usuario);
			updateJob(id, {
				status: 'queued',
				message: 'Navegador EVO foi fechado; reconectando e tentando novamente.'
			});
			await runJobAttempt(id, payload, true);
			return;
		}

		throw error;
	}
}

async function fillEvoRegistration(id: string, payload: EvoPayload, page: Page): Promise<void> {
	try {
		updateJob(id, { status: 'running', message: 'Conectando à sessão do EVO no navegador.' });
		await garantirSessao(page, payload.credenciais, payload.unidade, TIMEOUT_MS);

		updateJob(id, { message: 'Abrindo novo cadastro no EVO.' });
		await abrirNovoCadastroComRetry(page, payload);

		updateJob(id, { message: 'Preenchendo dados do aluno no EVO.' });
		await preencherCadastro(page, payload.prospect, TIMEOUT_MS);
		const result = await conferirCadastro(page);
		await page.bringToFront().catch(() => undefined);

		updateJob(id, {
			status: 'completed',
			message: 'Formulário do EVO preenchido. Revise e salve manualmente no navegador aberto.',
			result
		});
	} catch (error) {
		if (isBrowserGoneError(error) || isCancelamento(error)) throw error;

		const screenshot = await captureError(page);
		updateJob(id, {
			status: 'failed',
			message: 'Falha ao preencher o EVO.',
			error: error instanceof Error ? error.message : String(error),
			screenshot
		});
	}
}

function isBrowserGoneError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /browser.*disconnected|connection.*closed|session.*closed|target.*closed|page.*closed|frame.*detached/i.test(
		message
	);
}

async function abrirNovoCadastroComRetry(page: Page, payload: EvoPayload): Promise<void> {
	try {
		await abrirNovoCadastro(page, TIMEOUT_MS);
		return;
	} catch (error) {
		if (isCancelamento(error) || !(await loginVisivel(page))) throw error;
		await garantirSessao(page, payload.credenciais, payload.unidade, TIMEOUT_MS);
		await abrirNovoCadastro(page, TIMEOUT_MS);
	}
}

async function loginVisivel(page: Page): Promise<boolean> {
	return page
		.$eval(SELECTORS.login.usuario, (el) => {
			const element = el as HTMLElement;
			return element.getClientRects().length > 0;
		})
		.catch(() => false);
}

async function captureError(page: Page): Promise<string | undefined> {
	try {
		const dir = env.screenshotsDir;
		await mkdir(dir, { recursive: true });
		const path = join(dir, `erro-${Date.now()}.png`);
		await page.screenshot({ path, fullPage: true });
		return path;
	} catch {
		return undefined;
	}
}

function setJob(id: string, status: EvoJobStatus): void {
	jobs.set(id, status);
}

function updateJob(id: string, patch: Partial<Omit<EvoJobStatus, 'id' | 'createdAt'>>): void {
	const current = jobs.get(id);
	if (!current) return;
	jobs.set(id, { ...current, ...patch, updatedAt: new Date().toISOString() });
}
