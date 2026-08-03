import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { env } from '../config/env';
import { azureStorageConfigured, uploadBlob } from '../services/azureBlob';

const fileArg = Bun.argv[2];
if (!fileArg) {
	console.error('Uso: bun src/scripts/publish-desktop.ts <caminho-do-exe>');
	process.exit(1);
}

if (!azureStorageConfigured()) {
	console.error('Configure AZURE_STORAGE_ACCOUNT_NAME e AZURE_STORAGE_ACCOUNT_KEY no .env');
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

const bytes = new Uint8Array(await file.arrayBuffer());
const sha256 = createHash('sha256').update(bytes).digest('hex');

console.info(
	`Enviando ${fileName} (${bytes.byteLength} bytes) para ${env.azure.accountName}/${env.desktop.container}/${fileName}...`
);
try {
	await uploadBlob(env.desktop.container, fileName, bytes, {
		contentType: 'application/octet-stream',
		metadata: { sha256 }
	});
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (!message.includes('ContainerNotFound')) throw error;

	console.error(message);
	console.error(
		`\nO container "${env.desktop.container}" não existe na conta "${env.azure.accountName}".\n` +
			'Variáveis já definidas no sistema têm prioridade sobre o .env, então confira se AZURE_STORAGE_ACCOUNT_NAME\n' +
			'aponta mesmo para a conta esperada (`[Environment]::GetEnvironmentVariable("AZURE_STORAGE_ACCOUNT_NAME", "User")`)\n' +
			'ou crie o container antes de publicar.'
	);
	process.exit(1);
}

console.info('Upload concluído.');
console.info(`URL pública (após listagem): https://${env.azure.accountName}.blob.core.windows.net/${env.desktop.container}/${fileName}`);
console.info(`sha256=${sha256}`);

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
