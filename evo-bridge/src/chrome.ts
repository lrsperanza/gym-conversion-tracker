import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY_KEYS = [
	'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
	'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
	'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'
];

let cachedChromePath: string | undefined;

export function resolveChromePath(): string {
	if (cachedChromePath) return cachedChromePath;

	for (const candidate of chromeCandidates()) {
		if (candidate && existsSync(candidate)) {
			cachedChromePath = candidate;
			return candidate;
		}
	}

	throw new Error('Google Chrome nao encontrado. Instale o Chrome e tente novamente.');
}

function chromeCandidates(): string[] {
	return [
		Bun.env.EVO_CHROME_PATH,
		...REGISTRY_KEYS.map(readRegistryChromePath),
		join(Bun.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
		join(
			Bun.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
			'Google\\Chrome\\Application\\chrome.exe'
		),
		join(Bun.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
	].filter((candidate): candidate is string => Boolean(candidate));
}

function readRegistryChromePath(key: string): string | undefined {
	try {
		const output = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8' });
		for (const line of output.split(/\r?\n/)) {
			const match = line.match(/REG_\w+\s+(.+chrome\.exe)\s*$/i);
			if (match) return match[1].trim();
		}
	} catch {
		return undefined;
	}
}
