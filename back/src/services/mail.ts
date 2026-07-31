import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { AppError } from '../http/errors';

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
		throw new AppError(
			503,
			'Serviço de email indisponível. Configure o remetente SMTP e tente novamente.',
			'EMAIL_UNAVAILABLE'
		);
	}

	try {
		await transporter.sendMail({
			from: `"${env.smtp.fromName}" <${env.smtp.fromEmail}>`,
			to: input.to,
			subject: input.subject,
			text: input.text,
			html: input.html
		});
	} catch (error) {
		console.error('[mail] Falha ao enviar email:', error);
		throw new AppError(
			503,
			'Serviço de email indisponível. Verifique as credenciais SMTP e tente novamente.',
			'EMAIL_UNAVAILABLE'
		);
	}
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

