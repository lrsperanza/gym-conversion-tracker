import type { Context } from 'hono';
import { ZodError } from 'zod';

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;

export class AppError extends Error {
	constructor(
		public readonly status: ErrorStatus,
		message: string,
		public readonly code = 'APP_ERROR',
		public readonly details?: unknown
	) {
		super(message);
	}
}

export function badRequest(message: string, details?: unknown) {
	return new AppError(400, message, 'BAD_REQUEST', details);
}

export function forbidden(message = 'Você não tem permissão para executar esta ação.') {
	return new AppError(403, message, 'FORBIDDEN');
}

export function notFound(message = 'Registro não encontrado.') {
	return new AppError(404, message, 'NOT_FOUND');
}

export function unauthorized(message = 'Faça login para continuar.') {
	return new AppError(401, message, 'UNAUTHORIZED');
}

export function conflict(message: string, details?: unknown) {
	return new AppError(409, message, 'CONFLICT', details);
}

export function handleError(error: Error, c: Context) {
	if (error instanceof AppError) {
		return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
	}

	if (error instanceof ZodError) {
		return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Dados inválidos.', details: error.issues } }, 422);
	}

	console.error(error);
	return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } }, 500);
}

