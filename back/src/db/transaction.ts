import type { TransactionSql } from 'postgres';
import { sql } from './client';
import { isConcurrencyConflict } from './conflict';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * sql.begin com retentativa para conflito de concorrência do Aurora DSQL (veja conflict.ts).
 * A transação inteira é refeita, então o callback precisa ser só banco (nada de e-mail, upload etc.).
 */
export async function transaction<T>(callback: (tx: TransactionSql) => T | Promise<T>, attempts = 5) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await sql.begin(callback);
		} catch (error) {
			if (!isConcurrencyConflict(error) || attempt >= attempts) throw error;
			await sleep(Math.min(1000, 25 * 2 ** attempt) * (0.5 + Math.random()));
		}
	}
}
