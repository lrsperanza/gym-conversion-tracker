import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { env } from '../config/env';
import { blobDownloadUrl, gcsStorageConfigured, uploadBlob } from '../services/gcsStorage';

const fileArg = Bun.argv[2];
if (!fileArg) {
	console.error('Uso: bun src/scripts/publish-desktop.ts <caminho-do-exe>');
	process.exit(1);
}

if (!gcsStorageConfigured()) {
	console.error('Configure DESKTOP_GCS_BUCKET no .env');
	process.exit(1);
}

const filePath = resolve(fileArg);
const file = Bun.file(filePath);
if (!(await file.exists())) {
	console.error(`Arquivo não encontrado: ${filePath}`);
	process.exit(1);
}

const fileName = basename(filePath);
const pattern = new RegExp(`^${escapeRegExp(env.desktop.buildPrefix)}(\\d+(?:\\.\\d+)*)\\.exe$`, 'i');
if (!pattern.test(fileName)) {
	console.error(
		`Nome inválido "${fileName}". Esperado: ${env.desktop.buildPrefix}<versão>.exe (ex: ${env.desktop.buildPrefix}1.0.2.exe)`
	);
	process.exit(1);
}

const accessToken = readAccessToken();
const bytes = new Uint8Array(await file.arrayBuffer());
const sha256 = createHash('sha256').update(bytes).digest('hex');

console.info(`Enviando ${fileName} (${bytes.byteLength} bytes) para gs://${env.desktop.bucket}/${fileName}...`);
await uploadBlob(env.desktop.bucket, fileName, bytes, {
	accessToken,
	contentType: 'application/octet-stream',
	metadata: { sha256 }
});

console.info('Upload concluído.');
console.info(`URL pública: ${blobDownloadUrl(env.desktop.bucket, fileName)}`);
console.info(`sha256=${sha256}`);

/** Uses whoever is logged in to the gcloud CLI, so publishing needs no key in the .env. */
function readAccessToken() {
	if (Bun.env.GCS_ACCESS_TOKEN) return Bun.env.GCS_ACCESS_TOKEN;

	const gcloud = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
	const result = Bun.spawnSync([gcloud, 'auth', 'print-access-token'], { stderr: 'pipe' });
	const token = result.stdout.toString().trim();
	if (result.exitCode !== 0 || !token) {
		console.error(result.stderr.toString().trim());
		console.error('\nNão consegui um token do gcloud. Rode `gcloud auth login` com uma conta que escreva no bucket.');
		process.exit(1);
	}
	return token;
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
