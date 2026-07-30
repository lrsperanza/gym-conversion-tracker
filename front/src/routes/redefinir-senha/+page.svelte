<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api/client';
	import Notice from '$lib/components/Notice.svelte';
	import { errorMessage } from '$lib/helpers';
	import { getSessionContext } from '$lib/session';

	const sessionContext = getSessionContext();

	let token = $derived(page.url.searchParams.get('token') ?? '');
	let form = $state({ password: '', confirmation: '', loading: false });
	let message = $state('');
	let done = $state(false);

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		message = '';

		if (form.password.length < 8) {
			message = 'A senha precisa ter pelo menos 8 caracteres.';
			return;
		}
		if (form.password !== form.confirmation) {
			message = 'A confirmação não confere com a nova senha.';
			return;
		}

		form.loading = true;
		try {
			await api<{ ok: boolean }>('/api/auth/reset-password', {
				method: 'POST',
				body: JSON.stringify({ token, password: form.password })
			});
			done = true;
			form.password = '';
			form.confirmation = '';
			message = 'Senha redefinida com sucesso! Você já pode entrar com a nova senha.';
			await sessionContext.loadSession();
		} catch (error) {
			message = errorMessage(error, 'Não foi possível redefinir a senha.');
		} finally {
			form.loading = false;
		}
	}
</script>

<svelte:head>
	<title>Redefinir senha</title>
</svelte:head>

<section
	class="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl ring-1 shadow-sky-950/10 ring-slate-200"
>
	<p class="text-sm font-semibold tracking-[0.3em] text-sky-600 uppercase">Tracker de conversão</p>
	<h1 class="mt-2 text-2xl font-bold text-slate-900">Redefinir senha</h1>

	{#if !token}
		<p class="mt-4 text-slate-600">
			Este link de redefinição é inválido. Solicite um novo email na tela de login.
		</p>
		<a
			class="mt-6 block w-full rounded-2xl border border-slate-300 px-4 py-3 text-center font-semibold text-slate-700 hover:bg-slate-50"
			href={resolve('/')}>Voltar para o login</a
		>
	{:else if done}
		<a
			class="mt-6 block w-full rounded-2xl bg-sky-600 px-5 py-4 text-center text-base font-bold text-white hover:bg-sky-700"
			href={resolve('/')}>Ir para o login</a
		>
	{:else}
		<p class="mt-2 text-sm text-slate-600">Escolha uma nova senha para acessar o painel.</p>
		<form class="mt-6 space-y-4" onsubmit={handleSubmit}>
			<label class="block text-sm font-medium text-slate-700">
				Nova senha
				<input
					class="mt-1 w-full rounded-2xl border-slate-300"
					type="password"
					autocomplete="new-password"
					minlength="8"
					bind:value={form.password}
					required
				/>
			</label>
			<label class="block text-sm font-medium text-slate-700">
				Confirmar nova senha
				<input
					class="mt-1 w-full rounded-2xl border-slate-300"
					type="password"
					autocomplete="new-password"
					minlength="8"
					bind:value={form.confirmation}
					required
				/>
			</label>
			<button
				class="w-full rounded-2xl bg-sky-600 px-5 py-4 text-base font-bold text-white hover:bg-sky-700 disabled:opacity-60"
				disabled={form.loading}
			>
				{form.loading ? 'Salvando...' : 'Salvar nova senha'}
			</button>
		</form>
	{/if}

	<div class="mt-4">
		<Notice message={message} />
	</div>
</section>
