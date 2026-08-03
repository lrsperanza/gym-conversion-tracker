import { Hono } from 'hono';
import { deleteEvoProfile } from './browser.ts';
import { env } from './env.ts';
import { createEvoJob, getEvoJob, type EvoPayload } from './job.ts';

const app = new Hono();

app.options('/evo/*', (c) => new Response(null, { status: 204, headers: corsHeaders(c.req.raw) }));

app.get('/evo/health', (c) => withCors(c.json({ ok: true, service: 'evo-bridge' }), c.req.raw));

app.post('/evo/venda', async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!body || typeof body.attendanceId !== 'string') {
		return withCors(c.json({ error: { code: 'BAD_REQUEST', message: 'Informe attendanceId.' } }, 400), c.req.raw);
	}

	const payloadHeaders = new Headers();
	if (typeof body.ticket === 'string' && body.ticket) {
		payloadHeaders.set('Authorization', `Bearer ${body.ticket}`);
	} else {
		payloadHeaders.set('Cookie', c.req.header('cookie') ?? '');
	}

	const payloadResponse = await fetch(`${env.backUrl}/api/evo/attendances/${body.attendanceId}/payload`, {
		headers: payloadHeaders
	});
	if (!payloadResponse.ok) return withCors(await passthrough(payloadResponse), c.req.raw);

	const payload = (await payloadResponse.json()) as EvoPayload;
	const jobId = createEvoJob(payload);
	return withCors(c.json({ jobId }, 202), c.req.raw);
});

app.get('/evo/status/:jobId', (c) => {
	const job = getEvoJob(c.req.param('jobId'));
	if (!job) return withCors(c.json({ error: { code: 'NOT_FOUND', message: 'Job não encontrado.' } }, 404), c.req.raw);
	return withCors(c.json({ job }), c.req.raw);
});

app.delete('/evo/perfil', async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!body || typeof body.username !== 'string') {
		return withCors(c.json({ error: { code: 'BAD_REQUEST', message: 'Informe o usuário do EVO.' } }, 400), c.req.raw);
	}

	if (body.username.trim()) await deleteEvoProfile(body.username.trim());
	return withCors(c.json({ ok: true }), c.req.raw);
});

app.all('/api/*', async (c) => proxyToBack(c.req.raw));

app.all('*', async (c) => proxyToFront(c.req.raw));

Bun.serve({
	port: env.port,
	hostname: env.hostname,
	fetch: app.fetch
});

console.info(`EVO bridge listening on http://localhost:${env.port}`);
console.info(`Proxying API to ${env.backUrl}`);
console.info(`Proxying frontend from ${env.frontUrl}`);

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
	return cookie.replace(/;\s*secure(?=;|$)/gi, '').replace(/;\s*samesite=none(?=;|$)/gi, '; SameSite=Lax');
}

async function proxyToFront(request: Request): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed.', { status: 405 });
	}

	const requestUrl = new URL(request.url);
	const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, `${env.frontUrl}/`);

	try {
		const headers = new Headers(request.headers);
		headers.delete('host');
		headers.delete('cookie');
		headers.delete('authorization');
		const response = await fetch(targetUrl, { method: request.method, headers, redirect: 'manual' });
		return rewriteBackendResponse(response, requestUrl);
	} catch (error) {
		console.error('[front-proxy] failed to fetch remote frontend:', error);
		return offlineFrontResponse();
	}
}

function corsHeaders(request: Request): Headers {
	const headers = new Headers();
	const origin = request.headers.get('origin');
	if (origin && env.allowedOrigins.includes(origin)) {
		headers.set('Access-Control-Allow-Origin', origin);
		headers.set('Vary', 'Origin');
	}
	headers.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
	headers.set('Access-Control-Allow-Private-Network', 'true');
	headers.set('Access-Control-Max-Age', '600');
	return headers;
}

function withCors(response: Response, request: Request): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of corsHeaders(request)) {
		headers.set(key, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

function offlineFrontResponse(): Response {
	return new Response(
		`<!doctype html>
<html lang="pt-BR">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Skyfit EVO offline</title>
		<style>
			body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #0f172a; }
			main { max-width: 32rem; margin: 2rem; padding: 2rem; border-radius: 1.5rem; background: white; box-shadow: 0 20px 45px rgb(15 23 42 / 0.12); }
			p { color: #475569; line-height: 1.6; }
		</style>
	</head>
	<body>
		<main>
			<h1>Sem conexão com o aplicativo web</h1>
			<p>O bridge local está aberto, mas não conseguiu carregar o front remoto. Verifique a internet e tente abrir o app novamente.</p>
		</main>
	</body>
</html>`,
		{
			status: 503,
			headers: { 'content-type': 'text/html; charset=utf-8' }
		}
	);
}
