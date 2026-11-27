/**
 * Decisão do login pela API do EVO, espelhando o `finalizarLogin` do SPA do EVO 5
 * (`POST /api/v1/auth/login`):
 * - `flPossuiMfa` e `flLoginValidado` falso → etapa 3 com o código do app 2FA,
 *   devolvendo a `chaveOTP` recebida — que pode vir vazia: o SPA reenvia o que
 *   recebeu, sem exigir valor (exigir isso quebrou o login em nov/2026);
 * - `flSenhaExpirada` → senha expirada, precisa de troca manual;
 * - `flPossuiDuploFator` e `flLoginValidado` falso → código por e-mail (etapa 2),
 *   que o robô não tem como ler;
 * - senão, login concluído (`tokenAcesso` + `usuario`).
 */
export type EvoLoginUser = {
	idFilial?: number;
	idFilialCripto?: string;
	idW12Cripto?: string;
	idW12?: number;
	nomeFilial?: string;
	tokenEvo3?: string;
	filiais?: unknown[];
};

export type EvoLoginResponse = {
	flPossuiMfa?: boolean;
	flPossuiDuploFator?: boolean;
	flLoginValidado?: boolean;
	flSenhaExpirada?: boolean;
	chaveOTP?: string | null;
	tokenAcesso?: string;
	usuario?: EvoLoginUser;
};

export type LoginNext =
	| { kind: 'done'; token: string; user: EvoLoginUser }
	| { kind: 'totp'; chaveOTP: string | null }
	| { kind: 'error'; message: string };

export function nextLoginStep(response: EvoLoginResponse): LoginNext {
	const pending = response.flLoginValidado === false;
	if (response.flPossuiMfa && pending) return { kind: 'totp', chaveOTP: response.chaveOTP ?? null };
	if (response.flSenhaExpirada) return { kind: 'error', message: 'a senha do EVO expirou e precisa ser trocada' };
	if (response.flPossuiDuploFator && pending) {
		return { kind: 'error', message: 'o EVO pediu código de verificação por e-mail (etapa 2), que o robô não lê' };
	}
	if (response.tokenAcesso && response.usuario?.idFilial) {
		return { kind: 'done', token: response.tokenAcesso, user: response.usuario };
	}
	const keys = Object.keys(response ?? {}).join(', ') || '(vazia)';
	return { kind: 'error', message: `resposta do login sem token nem pedido de 2FA (campos: ${keys})` };
}
