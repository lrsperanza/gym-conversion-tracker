<script lang="ts">
	import {
		checkConnection,
		clearApiHostOverride,
		findApiHost,
		getApiHostOverride,
		hostDescription,
		nextApiHost,
		resolveApiHostUrl,
		setApiHostOverride,
		type ConnectionCheck
	} from '$lib/api/hosts';

	let visible = $state(false);
	let hostUrl = $state('');
	let manual = $state(false);
	let checking = $state(false);
	let result = $state<ConnectionCheck | null>(null);
	let checkToken = 0;

	let host = $derived(findApiHost(hostUrl));
	let dotClass = $derived(checking ? 'bg-amber-400' : result?.ok ? 'bg-emerald-400' : 'bg-rose-500');
	let statusText = $derived.by(() => {
		if (checking) return 'Testando conexão...';
		if (!result) return 'Sem verificação.';
		return result.ok ? `Online · ${result.latencyMs} ms` : `Indisponível · ${result.error}`;
	});

	async function refresh() {
		const token = ++checkToken;
		hostUrl = await resolveApiHostUrl();
		manual = getApiHostOverride() !== null;
		checking = true;
		result = null;

		const check = await checkConnection(hostUrl);
		if (token !== checkToken) return;
		result = check;
		checking = false;
	}

	async function switchHost() {
		setApiHostOverride(nextApiHost(hostUrl).url);
		await refresh();
	}

	async function useAutoHost() {
		clearApiHostOverride();
		await refresh();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (visible && event.key === 'Escape') {
			visible = false;
			return;
		}

		if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
		if (event.key.toLowerCase() !== 'd') return;
		event.preventDefault();

		// First press only reveals where the app is connected; the next ones cycle hosts.
		if (!visible) {
			visible = true;
			void refresh();
			return;
		}

		void switchHost();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
	<div
		class="fixed bottom-4 left-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl bg-slate-900/95 px-4 py-3 text-white shadow-xl ring-1 ring-slate-700 backdrop-blur"
		role="status"
		aria-live="polite"
	>
		<div class="flex items-center gap-2">
			<span class={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`} aria-hidden="true"></span>
			<p class="text-sm font-bold">{host.label}</p>
			<span
				class="ml-auto rounded-full bg-slate-700 px-2 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase"
			>
				{manual ? 'Manual' : 'Automático'}
			</span>
		</div>

		<p class="mt-1 truncate text-xs text-slate-300" title={hostDescription(hostUrl)}>
			{hostDescription(hostUrl)}
		</p>
		<p class="mt-1 text-xs font-medium text-slate-100">{statusText}</p>

		<div class="mt-3 flex flex-wrap gap-2">
			<button
				class="rounded-xl bg-sky-600 px-3 py-1.5 text-xs font-bold hover:bg-sky-500"
				onclick={switchHost}
			>
				Trocar host
			</button>
			<button
				class="rounded-xl border border-slate-600 px-3 py-1.5 text-xs font-semibold hover:bg-slate-800"
				onclick={() => window.location.reload()}
			>
				Recarregar
			</button>
			{#if manual}
				<button
					class="rounded-xl border border-slate-600 px-3 py-1.5 text-xs font-semibold hover:bg-slate-800"
					onclick={useAutoHost}
				>
					Automático
				</button>
			{/if}
		</div>

		<p class="mt-2 text-[0.65rem] text-slate-400">
			Ctrl+D alterna o host · Esc fecha · recarregue para aplicar nas telas já abertas
		</p>
	</div>
{/if}
