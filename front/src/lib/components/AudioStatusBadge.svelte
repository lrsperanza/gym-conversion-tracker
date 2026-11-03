<script lang="ts">
	import { audioRecorderState, retry } from '$lib/audio/recorder.svelte';

	let toneClass = $derived.by(() => {
		if (audioRecorderState.status === 'recording') {
			return audioRecorderState.pending > 3 ? 'bg-amber-400' : 'bg-emerald-500';
		}
		if (audioRecorderState.status === 'starting') return 'bg-amber-400';
		if (audioRecorderState.status === 'error' || audioRecorderState.status === 'unsupported') {
			return 'bg-red-500';
		}
		return 'bg-slate-300';
	});

	let label = $derived.by(() => {
		if (audioRecorderState.status === 'recording') return 'Gravando';
		if (audioRecorderState.status === 'starting') return 'Áudio iniciando';
		if (audioRecorderState.status === 'disabled') return 'Áudio desligado';
		if (audioRecorderState.status === 'unsupported') return 'Áudio indisponível';
		if (audioRecorderState.status === 'error') return 'Falha no áudio';
		return 'Áudio parado';
	});

	let title = $derived(
		[
			audioRecorderState.error,
			audioRecorderState.deviceLabel ? `Microfone: ${audioRecorderState.deviceLabel}` : '',
			audioRecorderState.pending
				? `${audioRecorderState.pending} trecho(s) aguardando envio`
				: 'Todos os trechos enviados',
			audioRecorderState.uploadError
		]
			.filter(Boolean)
			.join('\n')
	);
</script>

{#if audioRecorderState.status === 'error'}
	<button
		type="button"
		class="inline-flex items-center gap-2 rounded-2xl border border-red-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm hover:bg-red-50"
		{title}
		onclick={() => void retry()}
	>
		<span class={`size-2.5 rounded-full ${toneClass}`} aria-hidden="true"></span>
		<span>{label}</span>
		<span class="font-semibold text-red-600">Tentar de novo</span>
	</button>
{:else if audioRecorderState.status !== 'idle'}
	<div
		class="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm"
		{title}
	>
		<span class={`size-2.5 rounded-full ${toneClass}`} aria-hidden="true"></span>
		<span>{label}</span>
		{#if audioRecorderState.pending > 1}
			<span class="font-semibold text-amber-600">{audioRecorderState.pending} na fila</span>
		{/if}
	</div>
{/if}
