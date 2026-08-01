<script lang="ts">
	import { api } from '$lib/api/client';
	import Notice from '$lib/components/Notice.svelte';
	import { errorMessage, parsePhone } from '$lib/helpers';
	import type { Professor } from '$lib/types';

	let {
		academyId,
		academyName = null,
		onClose,
		onCreated
	}: {
		academyId: string | null;
		academyName?: string | null;
		onClose: () => void;
		onCreated: (professor: Professor) => Promise<void> | void;
	} = $props();

	let busy = $state(false);
	let message = $state('');
	let name = $state('');
	let whatsapp = $state('');
	let email = $state('');
	let title = $derived(
		academyName ? `Cadastrar professor - ${academyName}` : 'Cadastrar professor'
	);

	function resetForm() {
		name = '';
		whatsapp = '';
		email = '';
		message = '';
	}

	function handleClose() {
		if (busy) return;
		resetForm();
		onClose();
	}

	async function submitProfessor(event: SubmitEvent) {
		event.preventDefault();
		const trimmedName = name.trim();
		const trimmedWhatsapp = whatsapp.trim();
		const phone = trimmedWhatsapp ? parsePhone(trimmedWhatsapp) : null;

		if (!trimmedName) {
			message = 'Informe o nome do professor.';
			return;
		}
		if (!academyId) {
			message = 'Academia do atendimento não encontrada.';
			return;
		}
		if (trimmedWhatsapp && !phone) {
			message = 'Informe DDD + número (ex.: 16999998888).';
			return;
		}

		busy = true;
		message = '';
		try {
			const { professor } = await api<{ professor: Professor }>('/api/admin/professors', {
				method: 'POST',
				body: JSON.stringify({
					academyId,
					name: trimmedName,
					email: email.trim() || null,
					phone
				})
			});
			resetForm();
			await onCreated(professor);
		} catch (error) {
			message = errorMessage(error);
		} finally {
			busy = false;
		}
	}
</script>

<dialog
	class="fixed inset-0 z-50 m-auto w-[min(36rem,calc(100vw-2rem))] rounded-3xl border border-slate-200 bg-white p-0 shadow-2xl backdrop:bg-slate-950/40"
	open={academyId !== null}
	onclose={handleClose}
	oncancel={(event) => {
		if (busy) event.preventDefault();
	}}
	onclick={(event) => {
		if (event.target === event.currentTarget) handleClose();
	}}
>
	{#if academyId !== null}
		<div class="max-h-[calc(100vh-2rem)] overflow-y-auto p-5">
			<div class="flex items-start justify-between gap-4">
				<div>
					<h3 class="text-xl font-bold text-slate-950">{title}</h3>
					<p class="text-sm text-slate-600">
						Informe os dados básicos para vincular ao atendimento.
					</p>
				</div>
				<button
					type="button"
					class="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
					onclick={handleClose}
					aria-label="Fechar modal"
					disabled={busy}
				>
					<svg class="size-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
						<path
							fill-rule="evenodd"
							d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z"
							clip-rule="evenodd"
						/>
					</svg>
				</button>
			</div>

			<form class="mt-5 grid gap-4" onsubmit={submitProfessor}>
				<label class="text-sm font-medium text-slate-700">
					Nome
					<input
						class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
						bind:value={name}
						disabled={busy}
						autocomplete="off"
						minlength="2"
						required
					/>
				</label>

				<label class="text-sm font-medium text-slate-700">
					WhatsApp
					<input
						class="mt-1 w-full rounded-2xl border-slate-300"
						bind:value={whatsapp}
						disabled={busy}
						inputmode="numeric"
						placeholder="DDD + número (ex.: 16999998888)"
					/>
				</label>

				<label class="text-sm font-medium text-slate-700">
					Email
					<input
						class="mt-1 w-full rounded-2xl border-slate-300"
						bind:value={email}
						disabled={busy}
						type="email"
					/>
				</label>

				<Notice {message} />

				<div class="flex flex-wrap justify-end gap-2">
					<button
						type="button"
						class="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 hover:bg-slate-50"
						onclick={handleClose}
						disabled={busy}
					>
						Cancelar
					</button>
					<button
						class="rounded-2xl bg-sky-600 px-5 py-3 font-bold text-white hover:bg-sky-700 disabled:opacity-60"
						disabled={busy}
					>
						Cadastrar professor
					</button>
				</div>
			</form>
		</div>
	{/if}
</dialog>
