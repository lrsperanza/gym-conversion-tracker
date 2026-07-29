import nodemailer from 'nodemailer';
import { env } from '../config/env';

const transporter = nodemailer.createTransport({
	host: env.smtp.host,
	port: env.smtp.port,
	secure: env.smtp.port === 465,
	auth:
		env.smtp.user && env.smtp.password
			? {
					user: env.smtp.user,
					pass: env.smtp.password
				}
			: undefined
});

export async function sendEmail(input: { to: string; subject: string; text: string; html: string }) {
	if (!env.smtp.fromEmail) {
		console.warn(`SMTP_FROM_EMAIL ausente. Email não enviado para ${input.to}: ${input.subject}`);
		return;
	}

	await transporter.sendMail({
		from: `"${env.smtp.fromName}" <${env.smtp.fromEmail}>`,
		to: input.to,
		subject: input.subject,
		text: input.text,
		html: input.html
	});
}

export function confirmationEmail(to: string, name: string, token: string) {
	const url = `${env.appUrl}/confirmar-email?token=${encodeURIComponent(token)}`;
	return sendEmail({
		to,
		subject: 'Confirme seu email',
		text: `Olá, ${name}. Confirme seu email acessando: ${url}`,
		html: `<p>Olá, ${escapeHtml(name)}.</p><p>Confirme seu email clicando em <a href="${url}">confirmar email</a>.</p>`
	});
}

export function passwordResetEmail(to: string, name: string, token: string) {
	const url = `${env.appUrl}/redefinir-senha?token=${encodeURIComponent(token)}`;
	return sendEmail({
		to,
		subject: 'Recuperação de senha',
		text: `Olá, ${name}. Redefina sua senha acessando: ${url}`,
		html: `<p>Olá, ${escapeHtml(name)}.</p><p>Redefina sua senha clicando em <a href="${url}">redefinir senha</a>.</p>`
	});
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

