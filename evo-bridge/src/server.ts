import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import { deleteEvoProfile } from './browser.ts';
import { env } from './env.ts';
import { createEvoJob, getEvoJob, type EvoPayload } from './job.ts';

const app = new Hono();

app.get('/evo/health', (c) => c.json({ ok: true, service: 'evo-bridge' }));

app.post('/evo/venda', async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!body || typeof body.attendanceId !== 'string') {
		return c.json({ error: { code: 'BAD_REQUEST', message: 'Informe attendanceId.' } }, 400);
	}

	const payloadResponse = await fetch(`${env.backUrl}/api/evo/attendances/${body.attendanceId}/payload`, {
		headers: { Cookie: c.req.header('cookie') ?? '' }
	});
	if (!payloadResponse.ok) return passthrough(payloadResponse);

	const payload = (await payloadResponse.json()) as EvoPayload;
	const jobId = createEvoJob(payload);
	return c.json({ jobId }, 202);
});

app.get('/evo/status/:jobId', (c) => {
	const job = getEvoJob(c.req.param('jobId'));
	if (!job) return c.json({ error: { code: 'NOT_FOUND', message: 'Job não encontrado.' } }, 404);
	return c.json({ job });
});

app.delete('/evo/perfil', async (c) => {
	const credentialsResponse = await fetch(`${env.backUrl}/api/evo/credentials`, {
		headers: { Cookie: c.req.header('cookie') ?? '' }
	});
	if (!credentialsResponse.ok) return passthrough(credentialsResponse);

	const credentials = (await credentialsResponse.json()) as { username: string | null };
	if (credentials.username) await deleteEvoProfile(credentials.username);
	return c.json({ ok: true });
});

app.all('/api/*', async (c) => proxyToBack(c.req.raw));

app.get('*', async (c) => serveFront(c.req.path));

Bun.serve({
	port: env.port,
	fetch: app.fetch
});

console.info(`EVO bridge listening on http://localhost:${env.port}`);
console.info(`Proxying API to ${env.backUrl}`);
console.info(`Serving frontend from ${env.frontDist}`);

async function proxyToBack(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const target = `${env.backUrl}${url.pathname}${url.search}`;
	const headers = new Headers(request.headers);
	headers.delete('host');

	const response = await fetch(target, {
		method: request.method,
		headers,
		body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
		redirect: 'manual'
	});

	return rewriteBackendResponse(response, url);
}

async function passthrough(response: Response): Promise<Response> {
	return new Response(await response.text(), {
		status: response.status,
		headers: {
			'content-type': response.headers.get('content-type') ?? 'application/json'
		}
	});
}

function rewriteBackendResponse(response: Response, requestUrl: URL): Response {
	const headers = sanitizeResponseHeaders(response.headers, requestUrl);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

function sanitizeResponseHeaders(source: Headers, requestUrl: URL): Headers {
	const headers = new Headers(source);

	// Bun fetch gives callers the decoded body; stale compression headers break Chromium.
	headers.delete('content-encoding');
	headers.delete('content-length');
	headers.delete('transfer-encoding');

	const cookies = getSetCookies(source);
	headers.delete('set-cookie');
	for (const cookie of cookies) {
		headers.append('set-cookie', sanitizeCookie(cookie, requestUrl));
	}

	return headers;
}

function getSetCookies(headers: Headers): string[] {
	const withHelper = headers as Headers & { getSetCookie?: () => string[] };
	const cookies = withHelper.getSetCookie?.();
	if (cookies?.length) return cookies;

	const cookie = headers.get('set-cookie');
	return cookie ? [cookie] : [];
}

function sanitizeCookie(cookie: string, requestUrl: URL): string {
	if (requestUrl.protocol !== 'http:') return cookie;
	if (!['localhost', '127.0.0.1', '[::1]'].includes(requestUrl.hostname)) return cookie;
	return cookie.replace(/;\s*secure(?=;|$)/gi, '');
}

async function serveFront(pathname: string): Promise<Response> {
	const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
	const candidate = resolve(env.frontDist, `.${normalized}`);
	const distRoot = resolve(env.frontDist);
	const isFile = candidate.startsWith(distRoot) && existsSync(candidate) && statSync(candidate).isFile();
	const filePath = isFile ? candidate : join(env.frontDist, 'index.html');
	const file = Bun.file(filePath);

	if (!(await file.exists())) return new Response('Frontend build not found.', { status: 404 });
	return new Response(file);
}
