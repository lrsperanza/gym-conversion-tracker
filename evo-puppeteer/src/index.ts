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
	SELECTORS,
	type Prospect
} from './config.ts';
export {
	abrirNovoCadastro,
	conferirCadastro,
	escolherUnidade,
	garantirSessao,
	login,
	preencherCadastro
} from './flow.ts';
export { sleep } from './dom.ts';
