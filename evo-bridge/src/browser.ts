import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { resolveChromePath } from './chrome.ts';
import { env } from './env.ts';

const connections = new Map<string, Browser>();
const tabs = new Map<string, Page>();
const queues = new Map<string, Promise<unknown>>();
const DEVTOOLS_PROBE_TIMEOUT_MS = 2_000;
const PROFILE_DELEGATION_MS = 2_000;
const POLL_MS = 250;

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
	const previous = queues.get(profileKey) ?? Promise.resolve();
	const run = previous
		.catch(() => undefined)
		.then(async () => {
			const browser = await getBrowser(profileKey);
			const page = await getPage(profileKey, browser);
			return task({ browser, page, profileKey, profileDir: profileDir(profileKey) });
		});

	queues.set(profileKey, run.catch(() => undefined));
	return run;
}

export function forgetEvoConnection(usuario: string): void {
	const profileKey = evoProfileKey(usuario);
	const browser = connections.get(profileKey);
	if (browser?.connected) browser.disconnect();
	connections.delete(profileKey);
}

export async function deleteEvoProfile(usuario: string): Promise<void> {
	const profileKey = evoProfileKey(usuario);
	const browser = connections.get(profileKey);
	if (browser) {
		await browser.close().catch(() => undefined);
		connections.delete(profileKey);
	}
	queues.delete(profileKey);

	await rm(profileDir(profileKey), { recursive: true, force: true });
}

async function getBrowser(profileKey: string): Promise<Browser> {
	const existing = connections.get(profileKey);
	if (existing?.connected) return existing;
	if (existing) connections.delete(profileKey);

	const dir = profileDir(profileKey);
	await mkdir(dir, { recursive: true });
	const connected = await connectToExistingBrowser(dir);
	const browser = connected ?? (await launchAndConnect(dir));
	browser.on('disconnected', () => connections.delete(profileKey));
	connections.set(profileKey, browser);
	return browser;
}

const emBranco = (page: Page): boolean => {
	const url = page.url();
	return url === '' || url === 'about:blank' || url.startsWith('chrome://new-tab-page');
};

const abaEvo = (page: Page): boolean => {
	try {
		return new URL(page.url()).hostname.endsWith('w12app.com.br');
	} catch {
		return false;
	}
};

// A sessão do EVO é por aba: abrir aba nova perde o login. Todo job do perfil
// reusa a mesma aba; só criamos outra quando não existe nenhuma na janela.
async function getPage(profileKey: string, browser: Browser): Promise<Page> {
	const cached = tabs.get(profileKey);
	if (cached && cached.browser() === browser && !cached.isClosed()) {
		cached.setDefaultTimeout(env.evoTimeoutMs);
		return cached;
	}

	const pages = await browser.pages();
	const page = pages.find(abaEvo) ?? pages.find(emBranco) ?? pages.at(0) ?? (await browser.newPage());
	page.setDefaultTimeout(env.evoTimeoutMs);
	tabs.set(profileKey, page);
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

async function launchAndConnect(dir: string): Promise<Browser> {
	const launchedAt = Date.now();
	const child = spawnChrome(dir);
	const exit = childExited(child);
	child.unref();

	const endpoint = await waitForDevToolsEndpoint(dir, launchedAt, exit);
	const browser = await puppeteer.connect({ browserURL: endpoint, defaultViewport: null });
	if (!browser.connected) throw new Error('Chrome EVO abriu, mas o bridge não conseguiu conectar ao navegador.');
	return browser;
}

function spawnChrome(dir: string): ChildProcess {
	const child = spawn(
		resolveChromePath(),
		[
			`--user-data-dir=${dir}`,
			'--remote-debugging-port=0',
			'--restore-last-session',
			'--hide-crash-restore-bubble',
			'--start-maximized',
			'--no-first-run',
			'--no-default-browser-check'
		],
		{
			detached: true,
			stdio: 'ignore'
		}
	);

	return child;
}

function childExited(child: ChildProcess): Promise<Error | null> {
	return new Promise((resolve) => {
		child.once('exit', () => resolve(null));
		child.once('error', (error) => resolve(error));
	});
}

async function waitForDevToolsEndpoint(
	dir: string,
	launchedAt: number,
	childExit: Promise<Error | null>,
): Promise<string> {
	const deadline = Date.now() + env.evoTimeoutMs;
	const delegationDeadline = launchedAt + PROFILE_DELEGATION_MS;
	let childEnded = false;
	let childError: Error | null = null;
	void childExit.then((error) => {
		childEnded = true;
		childError = error;
	});

	while (Date.now() < deadline) {
		const endpoint = await readDevToolsEndpoint(dir, { minMtimeMs: launchedAt - 1_000 });
		if (endpoint) return endpoint;

		if (childEnded && Date.now() >= delegationDeadline) {
			if (childError) throw childError;
			throw new Error('Já existe um Chrome usando o perfil do EVO; feche a janela e tente de novo.');
		}

		await sleep(POLL_MS);
	}

	throw new Error('Chrome EVO abriu, mas o bridge não encontrou a porta de controle do navegador.');
}

async function readDevToolsEndpoint(
	dir: string,
	options: { minMtimeMs?: number; attempts?: number } = {},
): Promise<string | null> {
	const attempts = options.attempts ?? 3;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const endpoint = await readDevToolsEndpointOnce(dir, options.minMtimeMs);
		if (endpoint) return endpoint;
		if (attempt < attempts - 1) await sleep(POLL_MS);
	}

	return null;
}

async function readDevToolsEndpointOnce(dir: string, minMtimeMs?: number): Promise<string | null> {
	try {
		const path = join(dir, 'DevToolsActivePort');
		if (minMtimeMs !== undefined) {
			const info = await stat(path);
			if (info.mtimeMs < minMtimeMs) return null;
		}

		const [port] = (await readFile(path, 'utf8')).split(/\r?\n/);
		const parsed = Number(port);
		if (!Number.isInteger(parsed) || parsed <= 0) return null;

		const browserUrl = `http://127.0.0.1:${parsed}`;
		const response = await fetch(`${browserUrl}/json/version`, {
			signal: AbortSignal.timeout(DEVTOOLS_PROBE_TIMEOUT_MS)
		});
		if (!response.ok) return null;
		return browserUrl;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
