import { createHash } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { env } from './env.ts';

const SHORTCUT_NAME = 'Skyfit EVO.lnk';

export type DesktopAppInfo = {
	desktop: boolean;
	version: string | null;
	pid: number | null;
};

export type LatestDesktopBuild = {
	version: string;
	fileName: string;
	size: number;
	publishedAt: string;
	sha256: string | null;
	downloadUrl: string;
};

type LatestResponse = {
	configured: boolean;
	latest: LatestDesktopBuild | null;
};

export function desktopAppInfo(): DesktopAppInfo {
	return {
		desktop: Boolean(env.desktopVersion),
		version: env.desktopVersion,
		pid: env.desktopPid
	};
}

export function compareVersions(a: string, b: string) {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

export async function fetchLatestBuild(): Promise<LatestDesktopBuild | null> {
	const response = await fetch(`${env.backUrl}/api/desktop/latest`);
	if (!response.ok) {
		throw new Error(`API respondeu HTTP ${response.status} ao buscar a build desktop.`);
	}
	const payload = (await response.json()) as LatestResponse;
	if (!payload.configured) return null;
	return payload.latest;
}

/** Downloads the newer build, replaces the desktop shortcut, then restarts the launcher. */
export async function applyDesktopUpdate(): Promise<{ version: string }> {
	const currentVersion = env.desktopVersion;
	if (!currentVersion) {
		throw new Error('Este bridge não foi iniciado pelo aplicativo desktop.');
	}

	const latest = await fetchLatestBuild();
	if (!latest) throw new Error('Nenhuma build desktop publicada.');
	if (compareVersions(latest.version, currentVersion) <= 0) {
		throw new Error(`A versão instalada (${currentVersion}) já é a mais recente.`);
	}

	const destination = join(appDir(), `Skyfit-EVO-${latest.version}.exe`);
	await downloadBuild(latest, destination);
	await createDesktopShortcut(destination);
	scheduleRelaunch(destination, env.desktopPid ?? undefined);
	return { version: latest.version };
}

async function downloadBuild(build: LatestDesktopBuild, destination: string) {
	await mkdir(dirname(destination), { recursive: true });
	const partial = `${destination}.partial`;

	const response = await fetch(build.downloadUrl);
	if (!response.ok || !response.body) {
		throw new Error(`Falha ao baixar a build ${build.version} (HTTP ${response.status}).`);
	}

	const hasher = createHash('sha256');
	const file = Bun.file(partial);
	const writer = file.writer();

	for await (const chunk of response.body) {
		const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
		hasher.update(bytes);
		writer.write(bytes);
	}
	await writer.end();

	const digest = hasher.digest('hex');
	if (build.sha256 && build.sha256.toLowerCase() !== digest) {
		await rm(partial, { force: true });
		throw new Error(
			`Hash da build ${build.version} não confere (esperado ${build.sha256}, obtido ${digest}).`
		);
	}

	await rename(partial, destination);
}

async function createDesktopShortcut(targetPath: string) {
	const script = `
$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop '${escapePs(SHORTCUT_NAME)}'
if (Test-Path -LiteralPath $linkPath) { Remove-Item -LiteralPath $linkPath -Force }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = '${escapePs(targetPath)}'
$shortcut.WorkingDirectory = '${escapePs(dirname(targetPath))}'
$shortcut.Description = 'Skyfit EVO'
$shortcut.Save()
`;

	const result = Bun.spawnSync({
		cmd: [
			'powershell',
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-Command',
			script
		],
		stdout: 'ignore',
		stderr: 'pipe'
	});

	if (result.exitCode !== 0) {
		const detail = new TextDecoder().decode(result.stderr).trim();
		throw new Error(detail || 'Falha ao criar o atalho na Área de Trabalho.');
	}
}

function scheduleRelaunch(nextExe: string, currentPid?: number) {
	const kill = currentPid ? `taskkill /PID ${currentPid} /F >nul 2>&1 & ` : '';
	const command = `${kill}ping 127.0.0.1 -n 3 >nul & start "" "${nextExe}"`;
	Bun.spawn(['cmd', '/C', command], {
		stdout: 'ignore',
		stderr: 'ignore',
		stdin: 'ignore',
		windowsHide: true
	});
}

function appDir() {
	const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
	return join(localAppData, 'SkyfitEVO', 'app');
}

function escapePs(value: string) {
	return value.replace(/'/g, "''");
}
