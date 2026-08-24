<script lang="ts">
	import { api } from '$lib/api/client';
	import Notice from '$lib/components/Notice.svelte';
	import { errorMessage } from '$lib/helpers';
	import type { Attendance } from '$lib/types';

	type PhoneDraft = { countryCode: string; areaCode: string; number: string };
	type ExistingLead = {
		id: string;
		name: string;
		whatsapp_e164?: string | null;
		email?: string | null;
	};
	type DraftLead = {
		name?: string;
		phone?: PhoneDraft;
		email?: string | null;
	};
	type Choice = 'existing' | 'draft';
	type MergeLeadInput = {
		name?: string;
		phone?: PhoneDraft;
		email?: string | null;
	};

	let {
		attendance,
		existingLead,
		draftLead,
		onClose,
		onMerged
	}: {
		attendance: Attendance | null;
		existingLead: ExistingLead | null;
		draftLead: DraftLead | null;
		onClose: () => void;
		onMerged: () => Promise<void> | void;
	} = $props();

	let busy = $state(false);
	let message = $state('');
	let isOpen = $derived(Boolean(attendance && existingLead));
	let draftPhoneLabel = $derived(formatDraftPhone(draftLead?.phone));
	let nameConflict = $derived(hasConflict(existingLead?.name, draftLead?.name));
	let phoneConflict = $derived(hasConflict(existingLead?.whatsapp_e164, draftPhoneLabel));
	let emailConflict = $derived(hasConflict(existingLead?.email, draftLead?.email));
	let directFields = $derived.by(() => {
		const fields: string[] = [];
		if (!nameConflict && shouldSendDraft(existingLead?.name, draftLead?.name)) fields.push('nome');
		if (!phoneConflict && shouldSendDraft(existingLead?.whatsapp_e164, draftPhoneLabel)) {
			fields.push('telefone');
		}
		if (!emailConflict && shouldSendDraft(existingLead?.email, draftLead?.email)) fields.push('email');
		return fields;
	});

	function normalized(value?: string | null) {
		return value?.trim().toLowerCase() ?? '';
	}

	function hasConflict(existing?: string | null, draft?: string | null) {
		return Boolean(normalized(existing) && normalized(draft) && normalized(existing) !== normalized(draft));
	}

	function shouldSendDraft(existing?: string | null, draft?: string | null) {
		return Boolean(!normalized(existing) && normalized(draft));
	}

	function formatDraftPhone(phone?: PhoneDraft) {
		return phone ? `+${phone.countryCode}${phone.areaCode}${phone.number}` : null;
	}

	function valueOrEmpty(value?: string | null) {
		return value?.trim() || 'Não informado';
	}

	function choice(formData: FormData, field: string): Choice {
		return formData.get(`${field}Choice`) === 'draft' ? 'draft' : 'existing';
	}

	function buildLeadInput(formData: FormData): MergeLeadInput {
		const lead: MergeLeadInput = {};

		if (draftLead?.name) {
			if (nameConflict ? choice(formData, 'name') === 'draft' : shouldSendDraft(existingLead?.name, draftLead.name)) {
				lead.name = draftLead.name.trim();
			}
		}

		if (draftLead?.phone) {
			if (
				phoneConflict
					? choice(formData, 'phone') === 'draft'
					: shouldSendDraft(existingLead?.whatsapp_e164, draftPhoneLabel)
			) {
				lead.phone = draftLead.phone;
			}
		}

		if (draftLead && 'email' in draftLead) {
			const draftEmail = draftLead.email?.trim() || null;
			if (
				emailConflict
					? choice(formData, 'email') === 'draft'
					: shouldSendDraft(existingLead?.email, draftEmail)
			) {
				lead.email = draftEmail;
			}
		}

		return lead;
	}

	function handleClose() {
		if (busy) return;
		message = '';
		onClose();
	}

	async function confirmMerge(event: SubmitEvent) {
		event.preventDefault();
		if (!attendance || !existingLead) return;

		busy = true;
		message = '';
		try {
			const lead = buildLeadInput(new FormData(event.currentTarget as HTMLFormElement));
			await api<{ attendance: Attendance }>(`/api/attendances/${attendance.id}/merge-lead`, {
				method: 'POST',
				body: JSON.stringify({
					leadId: existingLead.id,
					lead
				})
			});
			message = '';
			onClose();
			await onMerged();
		} catch (error) {
			message = errorMessage(error);
		} finally {
			busy = false;
		}
	}
</script>

<dialog
	class="fixed inset-0 z-50 m-auto w-[min(42rem,calc(100vw-2rem))] rounded-3xl border border-slate-200 bg-white p-0 shadow-2xl backdrop:bg-slate-950/40"
	open={isOpen}
	aria-labelledby="lead-merge-title"
	onclose={handleClose}
	oncancel={(event) => {
		if (busy) event.preventDefault();
	}}
	onclick={(event) => {
		if (event.target === event.currentTarget) handleClose();
	}}
>
	{#if attendance && existingLead}
		<div class="max-h-[calc(100vh-2rem)] overflow-y-auto p-5">
			<div class="flex items-start justify-between gap-4">
				<div>
					<h3 id="lead-merge-title" class="text-xl font-bold text-slate-950">
						Vincular lead existente
					</h3>
					<p class="text-sm text-slate-600">
						Encontramos um lead cadastrado com este contato. Escolha quais dados serão
						mantidos antes de vincular o atendimento de {attendance.lead_name}.
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

			<div class="mt-5 grid gap-3 md:grid-cols-2">
				<div class="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
					<p class="text-xs font-bold tracking-[0.18em] text-slate-500 uppercase">Lead cadastrado</p>
					<dl class="mt-3 space-y-2 text-sm">
						<div>
							<dt class="font-semibold text-slate-700">Nome</dt>
							<dd class="text-slate-600">{existingLead.name}</dd>
						</div>
						<div>
							<dt class="font-semibold text-slate-700">Telefone</dt>
							<dd class="text-slate-600">{valueOrEmpty(existingLead.whatsapp_e164)}</dd>
						</div>
						<div>
							<dt class="font-semibold text-slate-700">Email</dt>
							<dd class="text-slate-600">{valueOrEmpty(existingLead.email)}</dd>
						</div>
					</dl>
				</div>

				<div class="rounded-2xl bg-sky-50 p-4 ring-1 ring-sky-100">
					<p class="text-xs font-bold tracking-[0.18em] text-sky-700 uppercase">Dado digitado</p>
					<dl class="mt-3 space-y-2 text-sm">
						<div>
							<dt class="font-semibold text-slate-700">Nome</dt>
							<dd class="text-slate-600">{valueOrEmpty(draftLead?.name)}</dd>
						</div>
						<div>
							<dt class="font-semibold text-slate-700">Telefone</dt>
							<dd class="text-slate-600">{valueOrEmpty(draftPhoneLabel)}</dd>
						</div>
						<div>
							<dt class="font-semibold text-slate-700">Email</dt>
							<dd class="text-slate-600">{valueOrEmpty(draftLead?.email)}</dd>
						</div>
					</dl>
				</div>
			</div>

			<form class="mt-5 grid gap-4" onsubmit={confirmMerge}>
				{#if nameConflict}
					<fieldset class="rounded-2xl border border-slate-200 p-4">
						<legend class="px-1 text-sm font-bold text-slate-800">Qual nome usar?</legend>
						<div class="mt-3 grid gap-2">
							<label class="flex gap-3 rounded-xl bg-slate-50 p-3 text-sm">
								<input type="radio" name="nameChoice" value="existing" checked disabled={busy} />
								<span><strong>Manter cadastrado:</strong> {existingLead.name}</span>
							</label>
							<label class="flex gap-3 rounded-xl bg-sky-50 p-3 text-sm">
								<input type="radio" name="nameChoice" value="draft" disabled={busy} />
								<span><strong>Usar digitado:</strong> {draftLead?.name}</span>
							</label>
						</div>
					</fieldset>
				{/if}

				{#if phoneConflict}
					<fieldset class="rounded-2xl border border-slate-200 p-4">
						<legend class="px-1 text-sm font-bold text-slate-800">Qual telefone usar?</legend>
						<div class="mt-3 grid gap-2">
							<label class="flex gap-3 rounded-xl bg-slate-50 p-3 text-sm">
								<input type="radio" name="phoneChoice" value="existing" checked disabled={busy} />
								<span><strong>Manter cadastrado:</strong> {existingLead.whatsapp_e164}</span>
							</label>
							<label class="flex gap-3 rounded-xl bg-sky-50 p-3 text-sm">
								<input type="radio" name="phoneChoice" value="draft" disabled={busy} />
								<span><strong>Usar digitado:</strong> {draftPhoneLabel}</span>
							</label>
						</div>
					</fieldset>
				{/if}

				{#if emailConflict}
					<fieldset class="rounded-2xl border border-slate-200 p-4">
						<legend class="px-1 text-sm font-bold text-slate-800">Qual email usar?</legend>
						<div class="mt-3 grid gap-2">
							<label class="flex gap-3 rounded-xl bg-slate-50 p-3 text-sm">
								<input type="radio" name="emailChoice" value="existing" checked disabled={busy} />
								<span><strong>Manter cadastrado:</strong> {existingLead.email}</span>
							</label>
							<label class="flex gap-3 rounded-xl bg-sky-50 p-3 text-sm">
								<input type="radio" name="emailChoice" value="draft" disabled={busy} />
								<span><strong>Usar digitado:</strong> {draftLead?.email}</span>
							</label>
						</div>
					</fieldset>
				{/if}

				{#if directFields.length}
					<p class="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 ring-1 ring-emerald-100">
						Também vamos completar no lead cadastrado: {directFields.join(', ')}.
					</p>
				{/if}

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
						Vincular lead
					</button>
				</div>
			</form>
		</div>
	{/if}
</dialog>
