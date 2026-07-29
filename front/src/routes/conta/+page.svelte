<script lang="ts">
	import { api } from '$lib/api/client';
	import Notice from '$lib/components/Notice.svelte';
	import { errorMessage } from '$lib/helpers';

	let accountMessage = $state('');
	let resetRequestForm = $state({ email: '' });
	let resetForm = $state({ token: '', password: '' });
	let confirmEmailForm = $state({ token: '' });

	async function requestPasswordReset(event: SubmitEvent) {
		event.preventDefault();
		accountMessage = '';
		try {
			await api<{ ok: boolean }>('/api/auth/request-password-reset', {
				method: 'POST',
				body: JSON.stringify({ email: resetRequestForm.email })
			});
			accountMessage = 'Se o email existir, enviaremos as instruções de redefinição.';
		} catch (error) {
			accountMessage = errorMessage(error);
		}
	}

	async function resetPassword(event: SubmitEvent) {
		event.preventDefault();
		accountMessage = '';
		try {
			await api<{ ok: boolean }>('/api/auth/reset-password', {
				method: 'POST',
				body: JSON.stringify(resetForm)
			});
			accountMessage = 'Senha redefinida com sucesso.';
			resetForm.password = '';
		} catch (error) {
			accountMessage = errorMessage(error);
		}
	}

	async function confirmEmail(event: SubmitEvent) {
		event.preventDefault();
		accountMessage = '';
		try {
			await api<{ ok: boolean }>('/api/auth/confirm-email', {
				method: 'POST',
				body: JSON.stringify(confirmEmailForm)
			});
			accountMessage = 'Email confirmado com sucesso.';
		} catch (error) {
			accountMessage = errorMessage(error);
		}
	}
</script>

<svelte:head>
	<title>Conta | Tracker de conversão</title>
</svelte:head>

<section class="grid gap-6 lg:grid-cols-3">
	<div class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 lg:col-span-3">
		<h2 class="text-2xl font-bold text-slate-950">Conta e email</h2>
		<p class="text-slate-600">
			Use os helpers para redefinição de senha e confirmação de email por token.
		</p>
	</div>
	<form
		class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200"
		onsubmit={requestPasswordReset}
	>
		<h3 class="font-bold text-slate-950">Solicitar reset</h3>
		<label class="mt-4 block text-sm font-medium text-slate-700">
			Email
			<input
				class="mt-1 w-full rounded-2xl border-slate-300"
				type="email"
				bind:value={resetRequestForm.email}
				required
			/>
		</label>
		<button class="mt-4 w-full rounded-2xl bg-sky-600 px-4 py-3 font-bold text-white">Enviar</button
		>
	</form>
	<form class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200" onsubmit={resetPassword}>
		<h3 class="font-bold text-slate-950">Redefinir senha</h3>
		<label class="mt-4 block text-sm font-medium text-slate-700">
			Token
			<input
				class="mt-1 w-full rounded-2xl border-slate-300"
				bind:value={resetForm.token}
				required
			/>
		</label>
		<label class="mt-3 block text-sm font-medium text-slate-700">
			Nova senha
			<input
				class="mt-1 w-full rounded-2xl border-slate-300"
				type="password"
				minlength="8"
				bind:value={resetForm.password}
				required
			/>
		</label>
		<button class="mt-4 w-full rounded-2xl bg-sky-600 px-4 py-3 font-bold text-white"
			>Salvar senha</button
		>
	</form>
	<form class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200" onsubmit={confirmEmail}>
		<h3 class="font-bold text-slate-950">Confirmar email</h3>
		<label class="mt-4 block text-sm font-medium text-slate-700">
			Token
			<input
				class="mt-1 w-full rounded-2xl border-slate-300"
				bind:value={confirmEmailForm.token}
				required
			/>
		</label>
		<button class="mt-4 w-full rounded-2xl bg-sky-600 px-4 py-3 font-bold text-white"
			>Confirmar</button
		>
	</form>
	<div class="lg:col-span-3">
		<Notice message={accountMessage} />
	</div>
</section>
