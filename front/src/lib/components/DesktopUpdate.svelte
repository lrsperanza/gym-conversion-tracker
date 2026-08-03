<script lang="ts">
	import {
		applyDesktopUpdate,
		compareVersions,
		fetchDesktopAppInfo,
		fetchDesktopLatest
	} from '$lib/api/desktop';
	import { errorMessage } from '$lib/helpers';
	import { onMount } from 'svelte';

	type Status = 'idle' | 'updating' | 'restarting' | 'error';

	let status = $state<Status>('idle');
	let message = $state('');

	onMount(() => {
		void checkAndApplyUpdate();
	});

	async function checkAndApplyUpdate() {
		try {
			const info = await fetchDesktopAppInfo();
			if (!info || !info.desktop || !info.version) return;

			const { configured, latest } = await fetchDesktopLatest();
			if (!configured || !latest) return;

			if (compareVersions(latest.version, info.version) <= 0) return;

			status = 'updating';
			const result = await applyDesktopUpdate();
			status = 'restarting';
			message = `Reiniciando na versão ${result.version}...`;
		} catch (error) {
			status = 'error';
			message = errorMessage(error, 'Falha ao aplicar a atualização.');
		}
	}

	function dismiss() {
		status = 'idle';
		message = '';
	}
</script>

{#if status !== 'idle'}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"
		role="alertdialog"
		aria-modal="true"
		aria-live="assertive"
	>
		<div
			class="w-full max-w-md space-y-4 rounded-3xl bg-white p-6 shadow-xl ring-1 shadow-sky-950/10 ring-slate-200"
		>
			{#if status === 'updating'}
				<p class="text-sm font-semibold tracking-[0.2em] text-sky-600 uppercase">Atualização</p>
				<h2 class="text-xl font-bold text-slate-950">Atualizando o aplicativo...</h2>
				<p class="text-sm text-slate-600">
					Baixando e aplicando a nova versão. Aguarde — o app vai reiniciar em seguida.
				</p>
			{:else if status === 'restarting'}
				<p class="text-sm font-semibold tracking-[0.2em] text-sky-600 uppercase">Atualização</p>
				<h2 class="text-xl font-bold text-slate-950">{message}</h2>
				<p class="text-sm text-slate-600">O aplicativo será reiniciado automaticamente.</p>
			{:else}
				<p class="text-sm font-semibold tracking-[0.2em] text-rose-600 uppercase">Erro</p>
				<h2 class="text-xl font-bold text-slate-950">Não foi possível atualizar</h2>
				<p class="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-900">
					{message}
				</p>
				<button
					type="button"
					class="rounded-2xl border border-slate-300 px-4 py-3 font-semibold text-slate-700 hover:bg-slate-50"
					onclick={dismiss}
				>
					Fechar
				</button>
			{/if}
		</div>
	</div>
{/if}
