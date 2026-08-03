<script lang="ts">
	import { getBridgeBaseUrl, resetBridgeDetection } from '$lib/api/bridge';
	import {
		clearEvoLog,
		evoDiagnostics,
		evoLogEntries,
		evoLogText,
		isEvoDiagnosticsOpen,
		setEvoDiagnosticsOpen,
		type EvoLogEntry
	} from '$lib/api/evo-log.svelte';

	let testing = $state(false);
	let feedback = $state('');
	let rawText = $state('');

	let visible = $derived(isEvoDiagnosticsOpen());
	let entries = $derived(evoLogEntries());
	let diagnostics = $derived(evoDiagnostics());
	let connected = $derived(diagnostics !== null && diagnostics.baseUrl !== null);
	let statusText = $derived.by(() => {
		if (testing) return 'Testando o bridge...';
		if (!diagnostics) return 'Abra "Testar novamente" para rodar um diagnóstico agora.';
		if (diagnostics.baseUrl === null) return 'Bridge NÃO conectado.';
		return `Bridge conectado em ${diagnostics.baseUrl || 'mesma origem'}.`;
	});

	function scrollToEnd(node: HTMLElement) {
		entries.length;
		node.scrollTop = node.scrollHeight;
	}

	function show() {
		feedback = '';
		rawText = '';
		setEvoDiagnosticsOpen(true);
	}

	function hide() {
		setEvoDiagnosticsOpen(false);
	}

	async function retest() {
		testing = true;
		feedback = '';
		resetBridgeDetection();
		await getBridgeBaseUrl();
		testing = false;
	}

	async function copyLogs() {
		const text = evoLogText();
		try {
			await navigator.clipboard.writeText(text);
			feedback = 'Logs copiados.';
		} catch {
			// Clipboard access is often denied inside the desktop webview.
			rawText = text;
			feedback = 'Não consegui copiar. Selecione o texto abaixo e copie manualmente.';
		}
	}

	function wipe() {
		clearEvoLog();
		feedback = 'Logs limpos.';
		rawText = '';
	}

	function levelClass(level: EvoLogEntry['level']) {
		if (level === 'error') return 'text-rose-300';
		return level === 'warn' ? 'text-amber-300' : 'text-slate-300';
	}

	function time(at: string) {
		return at.slice(11, 23);
	}

	function formatData(data: Record<string, unknown>) {
		return Object.entries(data)
			.map(([key, value]) => {
				if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
					return `${key}:\n  ${value.join('\n  ')}`;
				}
				return `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
			})
			.join('\n');
	}

	function handleKeydown(event: KeyboardEvent) {
		if (visible && event.key === 'Escape') {
			hide();
			return;
		}
		if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
		if (event.key.toLowerCase() !== 'e') return;
		event.preventDefault();
		if (visible) hide();
		else show();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
	<div
		class="fixed right-4 bottom-4 z-50 flex max-h-[min(80vh,44rem)] w-[min(38rem,calc(100vw-2rem))] flex-col rounded-2xl bg-slate-900/95 text-white shadow-2xl ring-1 ring-slate-700 backdrop-blur"
		role="dialog"
		aria-label="Diagnóstico do bridge EVO"
	>
		<div class="flex items-start gap-2 border-b border-slate-700 px-4 py-3">
			<span
				class={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${testing ? 'bg-amber-400' : connected ? 'bg-emerald-400' : 'bg-rose-500'}`}
				aria-hidden="true"
			></span>
			<div class="min-w-0">
				<p class="text-sm font-bold">Diagnóstico EVO</p>
				<p class="text-xs text-slate-300">{statusText}</p>
			</div>
			<button
				class="ml-auto rounded-lg px-2 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-800"
				onclick={hide}
			>
				Fechar
			</button>
		</div>

		<div class="flex flex-wrap gap-2 border-b border-slate-700 px-4 py-3">
			<button
				class="rounded-xl bg-sky-600 px-3 py-1.5 text-xs font-bold hover:bg-sky-500 disabled:opacity-60"
				onclick={retest}
				disabled={testing}
			>
				{testing ? 'Testando...' : 'Testar novamente'}
			</button>
			<button
				class="rounded-xl border border-slate-600 px-3 py-1.5 text-xs font-semibold hover:bg-slate-800"
				onclick={copyLogs}
			>
				Copiar logs
			</button>
			<button
				class="rounded-xl border border-slate-600 px-3 py-1.5 text-xs font-semibold hover:bg-slate-800"
				onclick={wipe}
			>
				Limpar
			</button>
			{#if feedback}
				<span class="self-center text-xs text-slate-300">{feedback}</span>
			{/if}
		</div>

		{#if diagnostics}
			<div class="border-b border-slate-700 px-4 py-3 text-xs text-slate-300">
				<p class="font-semibold text-slate-100">Ambiente</p>
				<pre class="mt-1 break-words whitespace-pre-wrap">{formatData(
						diagnostics.environment
					)}</pre>
				<p class="mt-3 font-semibold text-slate-100">Testes de conexão</p>
				<ul class="mt-1 space-y-1">
					{#each diagnostics.probes as probe (probe.label + probe.url)}
						<li>
							<span class={probe.ok ? 'text-emerald-300' : 'text-rose-300'}>
								{probe.ok ? 'OK' : 'FALHOU'}
							</span>
							· {probe.label} ({probe.url}) · {probe.latencyMs} ms
							{#if probe.reason}
								<span class="block text-slate-400">{probe.reason}</span>
							{/if}
							{#if probe.hint}
								<span class="block text-amber-300">{probe.hint}</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div
			class="min-h-24 flex-1 overflow-y-auto px-4 py-3 font-mono text-[0.7rem]"
			{@attach scrollToEnd}
		>
			{#if entries.length === 0}
				<p class="text-slate-400">Nenhum log registrado ainda.</p>
			{:else}
				{#each entries as entry (entry.id)}
					<div class="border-b border-slate-800 py-1">
						<p class={levelClass(entry.level)}>
							<span class="text-slate-500">{time(entry.at)}</span>
							[EVO-BRIDGE] {entry.message}
						</p>
						{#if entry.data}
							<pre class="mt-0.5 break-words whitespace-pre-wrap text-slate-400">{formatData(
									entry.data
								)}</pre>
						{/if}
					</div>
				{/each}
			{/if}
		</div>

		{#if rawText}
			<textarea
				class="m-4 h-32 rounded-xl border border-slate-600 bg-slate-950 p-2 font-mono text-[0.7rem] text-slate-200"
				readonly
				value={rawText}></textarea>
		{/if}

		<p class="border-t border-slate-700 px-4 py-2 text-[0.65rem] text-slate-400">
			Ctrl+Shift+E abre e fecha este painel · Esc fecha
		</p>
	</div>
{/if}
