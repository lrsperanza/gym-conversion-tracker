import { decodeOtpauthMigrationUri, generateTotp, totpSecondsRemaining } from './totp.ts';

const uri = process.argv.slice(2).join(' ').trim();
if (!uri) {
	console.error('Uso: bun src/decode-otpauth-migration.ts "otpauth-migration://offline?data=..."');
	process.exit(1);
}

const accounts = decodeOtpauthMigrationUri(uri);
for (const [index, account] of accounts.entries()) {
	const prefix = accounts.length > 1 ? `[${index + 1}] ` : '';
	console.log(`${prefix}${account.issuer ?? 'Sem emissor'}${account.name ? ` / ${account.name}` : ''}`);
	console.log(`secret: ${account.secretBase32}`);
	console.log(`command: bun run start -- --mostrar-totp ${account.secretBase32}`);
	console.log(`now: ${generateTotp(account.secretBase32)} (${totpSecondsRemaining()}s restantes)`);
	if (index < accounts.length - 1) console.log('');
}
