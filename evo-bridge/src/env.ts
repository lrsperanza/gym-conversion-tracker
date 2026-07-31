import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const cloudBackUrl = 'https://gym-conversion-tracker-437354431924.southamerica-east1.run.app';

export const env = {
	port: Number(Bun.env.BRIDGE_PORT || 4000),
	backUrl: (Bun.env.BACK_URL || cloudBackUrl).replace(/\/$/, ''),
	frontDist: resolve(root, Bun.env.FRONT_DIST || '../front/build'),
	perfisDir: resolve(root, Bun.env.EVO_PERFIS_DIR || '.cache/perfis'),
	screenshotsDir: resolve(root, Bun.env.EVO_SCREENSHOTS_DIR || 'screenshots'),
	evoTimeoutMs: Number(Bun.env.EVO_TIMEOUT_MS || 90_000)
} as const;
