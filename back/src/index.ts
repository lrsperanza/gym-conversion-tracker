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

const app = new Hono<AppBindings>();

app.use('*', logger());
app.use(
	'*',
	cors({
		origin: env.corsOrigin.split(',').map((origin) => origin.trim()),
		credentials: true,
		allowHeaders: ['Content-Type'],
		allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']
	})
);

app.onError(handleError);

app.get('/health', (c) => c.json({ ok: true, service: 'gym-conversion-tracker-back' }));

app.get('/openapi.json', (c) =>
	c.json({
		openapi: '3.1.0',
		info: { title: 'Gym Conversion Tracker API', version: '0.0.1' },
		paths: {
			'/api/auth/login': { post: { summary: 'Login com cookie HttpOnly' } },
			'/api/auth/me': { get: { summary: 'Sessão atual' } },
			'/api/admin/academies': { get: { summary: 'Lista academias' }, post: { summary: 'Cria academia' } },
			'/api/admin/users': { get: { summary: 'Lista usuários' }, post: { summary: 'Cria usuário e envia confirmação' } },
			'/api/admin/professors': { get: { summary: 'Lista professores' }, post: { summary: 'Cria professor sem login' } },
			'/api/admin/outcome-types': { get: { summary: 'Lista tipos de resultado' }, post: { summary: 'Cria tipo de resultado de venda' } },
			'/api/leads/duplicates': { get: { summary: 'Busca duplicidades exatas e prováveis' } },
			'/api/attendances': { get: { summary: 'Lista atendimentos' }, post: { summary: 'Abre atendimento no horário atual do servidor' } },
			'/api/attendances/{id}/events': { post: { summary: 'Registra evento append-only no atendimento' } },
			'/api/dashboard/summary': { get: { summary: 'KPIs e séries de conversão' } },
			'/api/dashboard/audit': { get: { summary: 'Lista auditável de atendimentos' } }
		}
	})
);

app.route('/api/auth', authRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api', attendanceRoutes);
app.route('/api', dashboardRoutes);

Bun.serve({
	port: env.port,
	fetch: app.fetch
});

console.info(`API listening on http://localhost:${env.port}`);

