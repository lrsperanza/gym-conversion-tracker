/**
 * Conferência diária de pagamentos: para cada venda lançada no tracker que
 * ainda não foi confirmada, procura o cliente no EVO e verifica se existe
 * venda com valor efetivamente pago. Roda como Cloud Run Job (01:00, Brasília).
 *
 * Flags:
 *   --dry-run       não grava nada no banco, só imprime as decisões
 *   --include-today confere também as vendas lançadas hoje
 *   --sale <uuid>   confere uma venda específica (A_CONFERIR ou pendente)
 *   --headed        abre o navegador visível (depuração local)
 */
import type { Browser } from 'puppeteer-core';
import {
	closeDb,
	loadCredentials,
	loadSalesToCheck,
	loadUsedEvoSaleIds,
	saveSaleCheck,
	type SaleToCheck
} from './db.ts';
import { env } from './env.ts';
import { EvoSession, launchBrowser } from './evo-session.ts';
import {
	decide,
	leadFullName,
	onlyDigits,
	pickCandidates,
	type EvoClient,
	type EvoVenda,
	type MatchSource
} from './matching.ts';

type Args = { dryRun: boolean; includeToday: boolean; saleId?: string; headed: boolean };

function parseArgs(argv: string[]): Args {
	const saleIndex = argv.indexOf('--sale');
	return {
		dryRun: argv.includes('--dry-run'),
		includeToday: argv.includes('--include-today'),
		headed: argv.includes('--headed'),
		saleId: saleIndex >= 0 ? argv[saleIndex + 1] : undefined
	};
}

const DAY_MS = 86_400_000;

async function checkSale(
	session: EvoSession,
	sale: SaleToCheck,
	usedEvoSaleIds: Set<number>,
	now: Date
) {
	const lead = {
		name: sale.lead_name,
		surname: sale.lead_surname,
		cpf: sale.lead_cpf,
		email: sale.lead_email,
		whatsapp: sale.lead_whatsapp
	};

	const searches: Array<{ source: MatchSource; query: string }> = [];
	const cpf = onlyDigits(lead.cpf);
	if (cpf.length === 11) searches.push({ source: 'cpf', query: cpf });
	if (lead.email?.includes('@')) searches.push({ source: 'email', query: lead.email.trim() });
	const fullName = leadFullName(lead);
	if (fullName) searches.push({ source: 'nome', query: fullName });

	const results: Array<{ source: MatchSource; clients: EvoClient[] }> = [];
	for (const search of searches) {
		results.push({ source: search.source, clients: await session.searchClients(search.query) });
		// CPF/e-mail acharam alguém: a busca por nome só traria ruído (homônimos).
		if (search.source !== 'nome' && results.at(-1)!.clients.some((client) => client.idCliente > 0)) break;
	}
	const candidates = pickCandidates(lead, results);

	const createdAt = new Date(sale.created_at);
	const windowStart = new Date(createdAt.getTime() - env.lookbackDays * DAY_MS);
	const vendasByClient = new Map<number, EvoVenda[]>();
	for (const candidate of candidates.slice(0, 5)) {
		vendasByClient.set(
			candidate.client.idCliente,
			await session.salesHistory(candidate.client.idCliente, windowStart, new Date(now.getTime() + DAY_MS))
		);
	}

	return decide({
		sale: { createdAt, amountCents: sale.amount_cents },
		candidates,
		vendasByClient,
		usedEvoSaleIds,
		windowStart,
		now,
		pendingMaxDays: env.pendingMaxDays
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.headed) (env as { headless: boolean }).headless = false;

	const sales = await loadSalesToCheck({ includeToday: args.includeToday, saleId: args.saleId });
	console.info(`[check] ${sales.length} venda(s) para conferir${args.dryRun ? ' (dry-run)' : ''}.`);
	if (sales.length === 0) return 0;

	const credentials = await loadCredentials(env.checkerUserEmail);
	const usedEvoSaleIds = await loadUsedEvoSaleIds();
	const summary = { PAGO: 0, PAGAMENTO_PENDENTE: 0, NAO_PAGO: 0, erros: 0 };
	let failedUnits = 0;

	const byUnit = new Map<string, SaleToCheck[]>();
	for (const sale of sales) {
		const unit = sale.evo_unit_name?.trim() || env.defaultUnit;
		byUnit.set(unit, [...(byUnit.get(unit) ?? []), sale]);
	}

	let browser: Browser | null = null;
	try {
		browser = await launchBrowser();
		for (const [unit, unitSales] of byUnit) {
			let session: EvoSession;
			try {
				session = await EvoSession.open(browser, credentials, unit);
			} catch (error) {
				failedUnits += 1;
				console.error(`[check] não foi possível logar na unidade "${unit}":`, error);
				continue; // vendas dessa unidade ficam como estão e voltam amanhã
			}

			try {
				for (const sale of unitSales) {
					const now = new Date();
					try {
						const decision = await checkSale(session, sale, usedEvoSaleIds, now);
						if (decision.evoSaleId) usedEvoSaleIds.add(decision.evoSaleId);
						summary[decision.status as keyof typeof summary] += 1;
						console.info(
							`[check] ${sale.id} ${leadFullName({ name: sale.lead_name, surname: sale.lead_surname })} ` +
								`(${sale.label_snapshot}, ${(sale.amount_cents / 100).toFixed(2)}): ` +
								`${sale.payment_status} → ${decision.status} — ${decision.note}`
						);
						if (!args.dryRun) await saveSaleCheck(sale.id, decision);
					} catch (error) {
						summary.erros += 1;
						console.error(`[check] erro conferindo a venda ${sale.id}; status mantido:`, error);
					}
				}
			} finally {
				await session.close();
			}
		}
	} finally {
		await browser?.close().catch(() => undefined);
	}

	console.info(`[check] resumo: ${JSON.stringify({ ...summary, unidadesComFalha: failedUnits })}`);
	return failedUnits > 0 || summary.erros > 0 ? 1 : 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		console.error('[check] falha geral:', error);
		process.exitCode = 1;
	})
	.finally(closeDb);
