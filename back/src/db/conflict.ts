/**
 * O Aurora DSQL usa controle de concorrência otimista: em vez de esperar lock, a transação que
 * perde a corrida falha com SQLSTATE 40001 (mensagem com OC000 / OC001).
 */
export function isConcurrencyConflict(error: unknown): boolean {
	const err = error as { code?: unknown; message?: unknown } | null;
	return err?.code === '40001' || /\(OC00\d\)/.test(String(err?.message ?? ''));
}
