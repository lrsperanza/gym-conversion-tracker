import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { resolveChromePath } from './chrome.ts';
import { env } from './env.ts';

type BrowserState = {
	browser: Browser;
	queue: Promise<unknown>;
};

const browsers = new Map<string, BrowserState>();

export type BrowserContext = {
	browser: Browser;
	page: Page;
	profileKey: string;
	profileDir: string;
};

export function evoProfileKey(usuario: string): string {
	return createHash('sha256').update(usuario.toLowerCase().trim()).digest('hex').slice(0, 16);
}

export async function withEvoProfile<T>(
	usuario: string,
	task: (context: BrowserContext) => Promise<T>,
): Promise<T> {
	const profileKey = evoProfileKey(usuario);
	const state = await getBrowserState(profileKey);
	const run = state.queue
		.catch(() => undefined)
		.then(async () => {
			const page = await getPage(state.browser);
			return task({ browser: state.browser, page, profileKey, profileDir: profileDir(profileKey) });
		});

	state.queue = run.catch(() => undefined);
	return run;
}

export async function deleteEvoProfile(usuario: string): Promise<void> {
	const profileKey = evoProfileKey(usuario);
	const state = browsers.get(profileKey);
	if (state) {
		await state.browser.close().catch(() => undefined);
		browsers.delete(profileKey);
	}

	await rm(profileDir(profileKey), { recursive: true, force: true });
}

async function getBrowserState(profileKey: string): Promise<BrowserState> {
	const existing = browsers.get(profileKey);
	if (existing && existing.browser.connected) return existing;

	const dir = profileDir(profileKey);
	await mkdir(dir, { recursive: true });
	const connected = await connectToExistingBrowser(dir);
	if (connected) {
		const state: BrowserState = { browser: connected, queue: Promise.resolve() };
		connected.on('disconnected', () => browsers.delete(profileKey));
		browsers.set(profileKey, state);
		return state;
	}

	const browser = await puppeteer.launch({
		headless: false,
		executablePath: resolveChromePath(),
		userDataDir: dir,
		defaultViewport: null,
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false,
		args: ['--start-maximized', '--no-first-run', '--no-default-browser-check']
	});
	const state: BrowserState = { browser, queue: Promise.resolve() };
	browser.on('disconnected', () => browsers.delete(profileKey));
	browsers.set(profileKey, state);
	return state;
}

const emBranco = (page: Page): boolean => {
	const url = page.url();
	return url === '' || url === 'about:blank' || url.startsWith('chrome://new-tab-page');
};

/**
 * Ao reabrir o perfil o Chrome restaura a aba da sessão anterior e o Puppeteer
 * ainda cria a sua própria about:blank. Ficar com a aba restaurada e fechar as
 * vazias evita que cada execução acumule uma aba em branco.
 */
async function getPage(browser: Browser): Promise<Page> {
	const pages = await browser.pages();
	const page = pages.find((aba) => !emBranco(aba)) ?? pages[0] ?? (await browser.newPage());

	for (const aba of pages) {
		if (aba !== page && emBranco(aba)) await aba.close().catch(() => undefined);
	}

	page.setDefaultTimeout(env.evoTimeoutMs);
	return page;
}

function profileDir(profileKey: string): string {
	return join(env.perfisDir, profileKey);
}

async function connectToExistingBrowser(dir: string): Promise<Browser | null> {
	const endpoint = await readDevToolsEndpoint(dir);
	if (!endpoint) return null;

	try {
		const browser = await puppeteer.connect({ browserURL: endpoint, defaultViewport: null });
		if (browser.connected) return browser;
		await browser.disconnect().catch(() => undefined);
	} catch {
		return null;
	}

	return null;
}

async function readDevToolsEndpoint(dir: string): Promise<string | null> {
	try {
		const [port] = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/);
		const parsed = Number(port);
		if (!Number.isInteger(parsed) || parsed <= 0) return null;

		const browserUrl = `http://127.0.0.1:${parsed}`;
		const response = await fetch(`${browserUrl}/json/version`, { signal: AbortSignal.timeout(500) });
		if (!response.ok) return null;
		return browserUrl;
	} catch {
		return null;
	}
}
