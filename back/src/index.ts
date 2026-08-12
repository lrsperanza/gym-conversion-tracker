import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { env } from './config/env';
import { handleError } from './http/errors';
import type { AppBindings } from './http/types';
import { adminRoutes } from './routes/admin';
import { attendanceRoutes } from './routes/attendances';
import { authRoutes } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';
import { desktopRoutes } from './routes/desktop';
import { evoRoutes } from './routes/evo';

const app = new Hono<AppBindings>();
const allowedOrigins = env.corsOrigin.split(',').map((origin) => origin.trim());
const allowAllOrigins = allowedOrigins.includes('*');

app.use('*', logger());

// The host switcher probes this endpoint from any front origin, so it stays outside the allow list.
app.use(
	'/api/check-connection',
	cors({ origin: (origin) => origin || '*', allowMethods: ['GET', 'OPTIONS'] })
);

app.use(
	'*',
	cors({
		origin: (origin) => (allowAllOrigins ? origin : allowedOrigins.includes(origin) ? origin : undefined),
		credentials: true,
		allowHeaders: ['Content-Type'],
		allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
	})
);

app.onError(handleError);

app.get('/health', (c) => c.json({ ok: true, service: 'gym-conversion-tracker-back' }));

app.get('/api/check-connection', (c) =>
	c.json({
		ok: true,
		service: 'gym-conversion-tracker-back',
		port: env.port,
		time: new Date().toISOString()
	})
);

app.get('/openapi.json', (c) =>
	c.json({
		openapi: '3.1.0',
		info: { title: 'Gym Conversion Tracker API', version: '0.0.1' },
		paths: {
			'/api/check-connection': { get: { summary: 'Verifica se o host da API responde (sem autenticação)' } },
			'/api/auth/login': { post: { summary: 'Login com cookie HttpOnly' } },
			'/api/auth/me': { get: { summary: 'Sessão atual' } },
			'/api/admin/academies': { get: { summary: 'Lista academias' }, post: { summary: 'Cria academia' } },
			'/api/admin/users': { get: { summary: 'Lista usuários' }, post: { summary: 'Cria usuário e envia confirmação' } },
			'/api/admin/professors': { get: { summary: 'Lista professores' }, post: { summary: 'Cria professor sem login' } },
			'/api/admin/outcome-types': { get: { summary: 'Lista tipos de resultado' }, post: { summary: 'Cria tipo de resultado de venda' } },
			'/api/leads/duplicates': { get: { summary: 'Busca duplicidades exatas e prováveis' } },
			'/api/leads': { get: { summary: 'Busca leads e lista agendamentos futuros' } },
			'/api/leads/{id}': { patch: { summary: 'Atualiza dados cadastrais do lead' } },
			'/api/attendances': { get: { summary: 'Lista atendimentos' }, post: { summary: 'Abre atendimento no horário atual do servidor' } },
			'/api/attendances/{id}/events': { post: { summary: 'Registra evento append-only no atendimento' } },
			'/api/dashboard/summary': { get: { summary: 'KPIs e séries de conversão' } },
			'/api/dashboard/audit': { get: { summary: 'Lista auditável de atendimentos' } },
			'/api/desktop/latest': { get: { summary: 'Build mais recente do app desktop com link de download temporário' } },
			'/api/desktop/releases': { get: { summary: 'Lista as builds publicadas do app desktop' } }
		}
	})
);

app.route('/api/auth', authRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/evo', evoRoutes);
app.route('/api/desktop', desktopRoutes);
app.route('/api', attendanceRoutes);
app.route('/api', dashboardRoutes);

Bun.serve({
	port: env.port,
	fetch: app.fetch
});

console.info(`API listening on http://localhost:${env.port}`);

