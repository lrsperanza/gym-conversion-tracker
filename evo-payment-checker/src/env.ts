/**
 * Mesmas chaves de banco e de criptografia do `back` — o job roda com os
 * segredos copiados do serviço Cloud Run (veja deploy.ps1).
 */
function bool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === '') return fallback;
	return value === 'true' || value === '1';
}

function int(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
	postgres: {
		host: Bun.env.PostgreHost ?? 'localhost',
		port: int(Bun.env.PostgrePort, 5432),
		database: Bun.env.PostgreDatabase ?? 'postgres',
		user: Bun.env.PostgreUser ?? 'postgres',
		password: Bun.env.PostgrePassword ?? '',
		ssl: bool(Bun.env.PostgreSSL, false)
	},
	/** Chave AES-GCM com que o back cifra as credenciais EVO dos usuários. */
	evoCredKey: Bun.env.EVO_CRED_KEY ?? '',
	/** Usuário do tracker cujas credenciais EVO (usuário, senha e 2FA) o robô usa. */
	checkerUserEmail: Bun.env.EVO_CHECKER_USER_EMAIL || 'lrsperanza@gmail.com',
	/** Unidade usada quando a academia não tem `evo_unit_name` cadastrado. */
	defaultUnit: Bun.env.EVO_DEFAULT_UNIT ?? '',
	chromePath: Bun.env.EVO_CHROME_PATH ?? '',
	/** Padrão: com janela. O Cloudflare do EVO bloqueia Chrome headless. */
	headless: bool(Bun.env.EVO_HEADLESS, false),
	timeoutMs: int(Bun.env.EVO_TIMEOUT_MS, 90_000),
	/** Por quantos dias uma venda pendente é reconferida antes de virar NAO_PAGO. */
	pendingMaxDays: int(Bun.env.PAYMENT_PENDING_MAX_DAYS, 30),
	/** Quantos dias antes da venda no tracker uma venda no EVO ainda é aceita. */
	lookbackDays: int(Bun.env.PAYMENT_LOOKBACK_DAYS, 20),
	/** Quantos dias depois do lançamento uma venda paga no EVO ainda conta (pagamento atrasado). */
	forwardDays: int(Bun.env.PAYMENT_FORWARD_DAYS, 7),
	timeZone: Bun.env.GYM_TIMEZONE || 'America/Sao_Paulo',
	screenshotsDir: Bun.env.EVO_SCREENSHOTS_DIR || 'screenshots'
} as const;
