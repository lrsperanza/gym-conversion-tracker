<script lang="ts">
	import { api } from '$lib/api/client';
	import { evoApi, evoAvailable } from '$lib/api/evo';
	import Notice from '$lib/components/Notice.svelte';
	import { errorMessage } from '$lib/helpers';
	import type { EvoCredentialsStatus } from '$lib/types';
	import { onMount } from 'svelte';

	let accountMessage = $state('');
	let resetRequestForm = $state({ email: '' });
	let resetForm = $state({ token: '', password: '' });
	let confirmEmailForm = $state({ token: '' });
	let evoBridgeAvailable = $state(false);
	let evoLoading = $state(true);
	let evoBusy = $state(false);
	let evoCredentials = $state<EvoCredentialsStatus | null>(null);
	let evoCredentialsForm = $state({ username: '', password: '' });

	onMount(() => {
		void loadEvoIntegration();
	});

	async function loadEvoIntegration() {
		evoLoading = true;
		try {
			const available = await evoAvailable();
			evoBridgeAvailable = available;
			if (!available) {
				evoCredentials = null;
				return;
			}
			const credentials = await evoApi<EvoCredentialsStatus>('/api/evo/credentials');
			evoCredentials = credentials;
			evoCredentialsForm.username = credentials.username ?? '';
		} catch (error) {
			accountMessage = errorMessage(error);
			evoBridgeAvailable = false;
			evoCredentials = null;
		} finally {
			evoLoading = false;
		}
	}

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

	async function saveEvoCredentials(event: SubmitEvent) {
		event.preventDefault();
		accountMessage = '';
		evoBusy = true;
		try {
			const credentials = await evoApi<EvoCredentialsStatus>('/api/evo/credentials', {
				method: 'PUT',
				body: JSON.stringify(evoCredentialsForm)
			});
			evoCredentials = credentials;
			evoCredentialsForm.password = '';
			accountMessage = 'Credenciais EVO salvas.';
		} catch (error) {
			accountMessage = errorMessage(error);
		} finally {
			evoBusy = false;
		}
	}

	async function forgetEvoSession() {
		accountMessage = '';
		evoBusy = true;
		try {
			await evoApi<{ ok: boolean }>('/evo/perfil', { method: 'DELETE' });
			accountMessage = 'Sessão salva do EVO esquecida. As credenciais continuam cadastradas.';
		} catch (error) {
			accountMessage = errorMessage(error);
		} finally {
			evoBusy = false;
		}
	}

	async function removeEvoCredentials() {
		accountMessage = '';
		evoBusy = true;
		try {
			await evoApi<{ ok: boolean }>('/api/evo/credentials', { method: 'DELETE' });
			evoCredentials = { configured: false, username: null };
			evoCredentialsForm.password = '';
			accountMessage = 'Credenciais EVO removidas.';
		} catch (error) {
			accountMessage = errorMessage(error);
		} finally {
			evoBusy = false;
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
	<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 lg:col-span-3">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h3 class="font-bold text-slate-950">Integração EVO</h3>
				<p class="text-sm text-slate-600">
					Configure o login usado pelo bridge para preencher cadastros no EVO.
				</p>
			</div>
			<button
				type="button"
				class="rounded-2xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
				onclick={loadEvoIntegration}
				disabled={evoLoading || evoBusy}
			>
				Atualizar status
			</button>
		</div>

		{#if evoLoading}
			<p class="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
				Verificando bridge EVO...
			</p>
		{:else if !evoBridgeAvailable}
			<p class="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
				Bridge EVO indisponível. Inicie o bridge para salvar credenciais e limpar a sessão do
				navegador.
			</p>
		{:else}
			<p class="mt-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-900">
				{#if evoCredentials?.configured}
					Credenciais configuradas para {evoCredentials.username}.
				{:else}
					Credenciais EVO ainda não configuradas.
				{/if}
			</p>

			<form class="mt-4 grid gap-3 sm:grid-cols-2" onsubmit={saveEvoCredentials}>
				<label class="text-sm font-medium text-slate-700"
					>Usuário EVO<input
						class="mt-1 w-full rounded-2xl border-slate-300"
						bind:value={evoCredentialsForm.username}
						disabled={evoBusy}
						required
					/></label
				>
				<label class="text-sm font-medium text-slate-700"
					>Senha EVO<input
						class="mt-1 w-full rounded-2xl border-slate-300"
						type="password"
						bind:value={evoCredentialsForm.password}
						disabled={evoBusy}
						required
					/></label
				>
				<button
					class="rounded-2xl bg-sky-600 px-4 py-3 font-bold text-white disabled:opacity-60 sm:col-span-2"
					disabled={evoBusy}
				>
					Salvar credenciais EVO
				</button>
			</form>

			<div class="mt-4 flex flex-wrap gap-2">
				<button
					type="button"
					class="rounded-2xl border border-slate-300 px-4 py-3 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
					onclick={forgetEvoSession}
					disabled={evoBusy}
				>
					Esquecer sessão salva
				</button>
				<button
					type="button"
					class="rounded-2xl border border-red-200 px-4 py-3 font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
					onclick={removeEvoCredentials}
					disabled={evoBusy || !evoCredentials?.configured}
				>
					Remover credenciais
				</button>
			</div>
			<p class="mt-2 text-xs text-slate-500">
				Esquecer sessão salva limpa apenas a sessão/cache do navegador do bridge, não as
				credenciais.
			</p>
		{/if}
	</section>
	<div class="lg:col-span-3">
		<Notice message={accountMessage} />
	</div>
</section>
