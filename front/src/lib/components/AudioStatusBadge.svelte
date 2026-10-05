<script lang="ts">
	import { audioRecorderState, retry } from '$lib/audio/recorder.svelte';

	let toneClass = $derived.by(() => {
		if (audioRecorderState.status === 'recording') return 'bg-emerald-500';
		if (audioRecorderState.status === 'starting' || audioRecorderState.status === 'stopping') {
			return 'bg-amber-400';
		}
		if (audioRecorderState.status === 'error' || audioRecorderState.status === 'unsupported') {
			return 'bg-red-500';
		}
		return 'bg-slate-300';
	});

	let label = $derived.by(() => {
		if (audioRecorderState.status === 'recording') return 'Áudio ativo';
		if (audioRecorderState.status === 'starting') return 'Áudio iniciando';
		if (audioRecorderState.status === 'disabled') return 'Áudio desligado';
		if (audioRecorderState.status === 'unsupported') return 'Áudio indisponível';
		if (audioRecorderState.status === 'error') return 'Falha no áudio';
		return 'Áudio parado';
	});

	let title = $derived(
		audioRecorderState.error ||
			audioRecorderState.message ||
			(audioRecorderState.deviceLabel ? `Microfone: ${audioRecorderState.deviceLabel}` : label)
	);
</script>

{#if audioRecorderState.status === 'error'}
	<button
		type="button"
		class="inline-flex items-center gap-2 rounded-2xl border border-red-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm hover:bg-red-50"
		{title}
		aria-label={title}
		onclick={() => void retry()}
	>
		<span class={`size-2.5 rounded-full ${toneClass}`} aria-hidden="true"></span>
		<span>{label}</span>
		<span class="font-semibold text-red-600">Tentar de novo</span>
	</button>
{:else}
	<div
		class="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm"
		{title}
		aria-label={title}
	>
		<span class={`size-2.5 rounded-full ${toneClass}`} aria-hidden="true"></span>
		<span>{label}</span>
		{#if audioRecorderState.deviceLabel && audioRecorderState.status === 'recording'}
			<span class="hidden max-w-36 truncate font-semibold text-slate-500 sm:inline">
				{audioRecorderState.deviceLabel}
			</span>
		{/if}
	</div>
{/if}
