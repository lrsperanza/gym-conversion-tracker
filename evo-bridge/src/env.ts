import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const cloudBackUrl = 'https://gym-conversion-tracker-437354431924.southamerica-east1.run.app';
const cloudFrontUrl = 'https://nice-pebble-04842d70f.7.azurestaticapps.net';

const frontUrl = (Bun.env.FRONT_URL || cloudFrontUrl).replace(/\/$/, '');
const defaultAllowedOrigins = [
	new URL(frontUrl).origin,
	'http://localhost:4000',
	'http://127.0.0.1:4000',
	'http://localhost:5173',
	'http://127.0.0.1:5173'
];

export const env = {
	port: Number(Bun.env.BRIDGE_PORT || 4000),
	// Only the desktop app talks to the bridge. Binding to loopback keeps it off the LAN
	// and avoids the Windows Firewall prompt on first launch.
	hostname: Bun.env.BRIDGE_HOST || '127.0.0.1',
	backUrl: (Bun.env.BACK_URL || cloudBackUrl).replace(/\/$/, ''),
	frontUrl,
	allowedOrigins: (Bun.env.FRONT_ALLOWED_ORIGINS || defaultAllowedOrigins.join(','))
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean),
	perfisDir: resolve(root, Bun.env.EVO_PERFIS_DIR || '.cache/perfis'),
	screenshotsDir: resolve(root, Bun.env.EVO_SCREENSHOTS_DIR || 'screenshots'),
	evoTimeoutMs: Number(Bun.env.EVO_TIMEOUT_MS || 90_000),
	desktopVersion: Bun.env.DESKTOP_APP_VERSION?.trim() || null,
	desktopPid: Number.parseInt(Bun.env.DESKTOP_PID || '', 10) || null
} as const;
