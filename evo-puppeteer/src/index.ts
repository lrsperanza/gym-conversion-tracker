export {
	CancelamentoError,
	isCancelamento,
	limparCancelamento,
	registrarCancelamento
} from './cancelamento.ts';
export {
	DEFAULT_PROSPECT,
	DEFAULT_UNIDADE,
	DRAWER,
	LOGIN_URL,
	novaVendaUrl,
	SELECTORS,
	type Prospect
} from './config.ts';
export {
	abrirNovoCadastro,
	conferirCadastro,
	escolherUnidade,
	garantirSessao,
	gotoComRetry,
	login,
	preencherCadastro
} from './flow.ts';
export { listarContratosVenda, type ContratoVenda } from './vendas.ts';
export { sleep } from './dom.ts';
