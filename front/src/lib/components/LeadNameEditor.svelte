<script lang="ts">
	import { api } from '$lib/api/client';
	import { errorMessage } from '$lib/helpers';

	let {
		leadId,
		name,
		onSaved
	}: {
		leadId: string;
		name: string;
		onSaved?: (name: string) => Promise<void> | void;
	} = $props();

	let editing = $state(false);
	let draft = $state('');
	let savedName = $state<string | null>(null);
	let currentName = $derived(savedName ?? name);
	let busy = $state(false);
	let message = $state('');

	function autofocus(node: HTMLElement) {
		node.focus();
	}

	function startEdit() {
		draft = currentName;
		message = '';
		editing = true;
	}

	function cancelEdit() {
		draft = currentName;
		message = '';
		editing = false;
	}

	async function saveName() {
		const trimmedName = draft.trim();
		if (!trimmedName) {
			message = 'Informe um nome.';
			return;
		}

		busy = true;
		message = '';
		try {
			await api<{ lead: { id: string } }>(`/api/leads/${leadId}`, {
				method: 'PATCH',
				body: JSON.stringify({ name: trimmedName })
			});
			savedName = trimmedName;
			draft = trimmedName;
			editing = false;
			await onSaved?.(trimmedName);
		} catch (error) {
			message = errorMessage(error);
		} finally {
			busy = false;
		}
	}
</script>

{#if editing}
	<form
		class="grid gap-1"
		onsubmit={(event) => {
			event.preventDefault();
			void saveName();
		}}
	>
		<div class="flex flex-wrap items-center gap-2">
			<input
				class="min-w-0 flex-1 rounded-xl border-slate-300 text-sm font-semibold text-slate-950"
				bind:value={draft}
				disabled={busy}
				onkeydown={(event) => {
					if (event.key === 'Escape') cancelEdit();
				}}
				{@attach autofocus}
			/>
			<button
				class="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
				disabled={busy}
			>
				Salvar
			</button>
			<button
				type="button"
				class="rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600"
				onclick={cancelEdit}
				disabled={busy}
			>
				Cancelar
			</button>
		</div>
		{#if message}
			<p class="text-xs font-semibold text-red-700" aria-live="polite">{message}</p>
		{/if}
	</form>
{:else}
	<div class="flex min-w-0 items-center gap-2">
		<span class="truncate text-sm font-bold text-slate-950">{currentName}</span>
		<button
			type="button"
			class="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
			onclick={startEdit}
			aria-label={`Editar nome de ${currentName}`}
		>
			<svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
				<path
					d="M13.92 2.87a2.2 2.2 0 0 1 3.11 3.11l-.74.74-3.11-3.11.74-.74Zm-1.8 1.8 3.11 3.11-8.44 8.44-3.44.33.33-3.44 8.44-8.44Z"
				/>
			</svg>
		</button>
	</div>
{/if}
