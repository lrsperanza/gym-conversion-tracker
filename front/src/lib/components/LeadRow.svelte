<script lang="ts">
	import { browser } from '$app/environment';
	import { api, dateTime } from '$lib/api/client';
	import LeadNameEditor from '$lib/components/LeadNameEditor.svelte';
	import {
		errorMessage,
		eventTypeLabel,
		isImminent,
		parsePhone,
		statusLabel
	} from '$lib/helpers';
	import type { AttendanceEventType, LeadSummary } from '$lib/types';

	type Mode = 'scheduled' | 'search';
	type EditingField = 'phone' | 'email' | 'notes';
	type ScheduledType = 'EXPERIMENTAL_CLASS_SCHEDULED' | 'FOLLOW_UP_SCHEDULED';

	let {
		lead,
		mode = 'search',
		onChanged
	}: {
		lead: LeadSummary;
		mode?: Mode;
		onChanged?: () => Promise<void> | void;
	} = $props();

	let editing = $state<EditingField | null>(null);
	let editingValue = $state('');
	let editingBusy = $state(false);
	let scheduleDraft = $state('');
	let rescheduleBusy = $state(false);
	let cancelBusy = $state(false);
	let reopenBusy = $state(false);
	let message = $state('');
	let scheduledControlsVisible = $derived(Boolean(lead.next_scheduled_for) || mode === 'scheduled');
	let attendanceId = $derived(lead.next_attendance_id || lead.last_attendance_id || '');
	let leadStatus = $derived(lead.last_status ? statusLabel(lead.last_status) : 'Sem atendimento');

	function autofocus(node: HTMLElement) {
		node.focus();
	}

	function toDateTimeLocal(value?: string | null) {
		if (!value) return '';
		const date = new Date(value);
		if (!Number.isFinite(date.getTime())) return '';
		const pad = (part: number) => String(part).padStart(2, '0');
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
			date.getHours()
		)}:${pad(date.getMinutes())}`;
	}

	function isScheduledType(type?: AttendanceEventType | null): type is ScheduledType {
		return type === 'EXPERIMENTAL_CLASS_SCHEDULED' || type === 'FOLLOW_UP_SCHEDULED';
	}

	function eventTypeForReschedule(): ScheduledType {
		return isScheduledType(lead.next_event_type) ? lead.next_event_type : 'FOLLOW_UP_SCHEDULED';
	}

	function startEdit(field: EditingField) {
		editing = field;
		message = '';
		if (field === 'phone') editingValue = lead.whatsapp_e164?.replace(/^\+55/, '') ?? '';
		else if (field === 'email') editingValue = lead.email ?? '';
		else editingValue = lead.notes ?? '';
	}

	function cancelEdit() {
		editing = null;
		editingValue = '';
	}

	async function patchLead(payload: Record<string, unknown>) {
		await api<{ lead: { id: string } }>(`/api/leads/${lead.id}`, {
			method: 'PATCH',
			body: JSON.stringify(payload)
		});
		await onChanged?.();
	}

	async function savePhone() {
		const phone = parsePhone(editingValue);
		if (!phone) {
			message = 'Informe DDD + número (ex.: 16999998888).';
			return;
		}
		await saveField({ phone }, 'Número salvo.');
	}

	async function saveEmail() {
		await saveField({ email: editingValue.trim() || null }, 'Email salvo.');
	}

	async function saveNotes() {
		await saveField({ notes: editingValue.trim() || null }, 'Notas salvas.');
	}

	async function saveField(payload: Record<string, unknown>, successMessage: string) {
		editingBusy = true;
		message = '';
		try {
			await patchLead(payload);
			cancelEdit();
			message = successMessage;
		} catch (error) {
			message = errorMessage(error);
		} finally {
			editingBusy = false;
		}
	}

	async function reschedule() {
		if (!attendanceId) {
			message = 'Lead sem atendimento para reagendar.';
			return;
		}
		const scheduledFor = scheduleDraft || toDateTimeLocal(lead.next_scheduled_for);
		if (!scheduledFor) {
			message = 'Informe o novo horário.';
			return;
		}
		rescheduleBusy = true;
		message = '';
		try {
			await api<{ event: { id: string } }>(`/api/attendances/${attendanceId}/events`, {
				method: 'POST',
				body: JSON.stringify({
					type: eventTypeForReschedule(),
					scheduledFor: new Date(scheduledFor).toISOString()
				})
			});
			message = 'Agendamento atualizado.';
			await onChanged?.();
			scheduleDraft = '';
		} catch (error) {
			message = errorMessage(error);
		} finally {
			rescheduleBusy = false;
		}
	}

	async function cancelSchedule() {
		if (!attendanceId) {
			message = 'Lead sem atendimento para cancelar.';
			return;
		}
		if (
			browser &&
			!window.confirm(`Cancelar agendamento de ${lead.name}? Esta ação ficará registrada.`)
		) {
			return;
		}
		cancelBusy = true;
		message = '';
		try {
			await api<{ event: { id: string } }>(`/api/attendances/${attendanceId}/events`, {
				method: 'POST',
				body: JSON.stringify({ type: 'SCHEDULE_CANCELLED' })
			});
			message = 'Agendamento cancelado.';
			await onChanged?.();
		} catch (error) {
			message = errorMessage(error);
		} finally {
			cancelBusy = false;
		}
	}

	async function reopenAttendance() {
		if (!lead.last_attendance_id) return;
		reopenBusy = true;
		message = '';
		try {
			await api<{ event: { id: string } }>(`/api/attendances/${lead.last_attendance_id}/events`, {
				method: 'POST',
				body: JSON.stringify({ type: 'REOPEN' })
			});
			message = 'Atendimento reaberto.';
			await onChanged?.();
		} catch (error) {
			message = errorMessage(error);
		} finally {
			reopenBusy = false;
		}
	}
</script>

<article class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
	<div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
		<div class="min-w-0 space-y-1">
			<LeadNameEditor leadId={lead.id} name={lead.name} onSaved={onChanged} />
			<p class="text-xs text-slate-500">
				{lead.academy_name || 'Sem academia'} · {leadStatus}{#if lead.last_started_at}
					· {dateTime(lead.last_started_at)}
				{/if}
			</p>
		</div>
		{#if lead.next_scheduled_for}
			<span
				class={`w-fit rounded-full px-3 py-1 text-xs font-bold ring-1 ${
					isImminent(lead.next_scheduled_for)
						? 'bg-amber-100 text-amber-900 ring-amber-300'
						: 'bg-sky-50 text-sky-800 ring-sky-200'
				}`}
			>
				{eventTypeLabel(lead.next_event_type)} · {dateTime(lead.next_scheduled_for)}
			</span>
		{/if}
	</div>

	{#if editing}
		<form
			class="mt-3 flex flex-wrap items-start gap-2"
			onsubmit={(event) => {
				event.preventDefault();
				if (editing === 'phone') void savePhone();
				else if (editing === 'email') void saveEmail();
				else void saveNotes();
			}}
		>
			{#if editing === 'notes'}
				<textarea
					class="min-w-0 flex-1 rounded-xl border-slate-300 text-sm"
					rows="3"
					placeholder="Notas do lead"
					bind:value={editingValue}
					disabled={editingBusy}
					{@attach autofocus}
				></textarea>
			{:else}
				<input
					class="min-w-0 flex-1 rounded-xl border-slate-300 text-sm"
					type={editing === 'email' ? 'email' : 'text'}
					inputmode={editing === 'phone' ? 'numeric' : undefined}
					placeholder={editing === 'phone' ? 'DDD + número (ex.: 16999998888)' : 'email@exemplo.com'}
					bind:value={editingValue}
					disabled={editingBusy}
					{@attach autofocus}
				/>
			{/if}
			<button
				class="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
				disabled={editingBusy}
			>
				Salvar
			</button>
			<button
				type="button"
				class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600"
				onclick={cancelEdit}
				disabled={editingBusy}
			>
				Cancelar
			</button>
		</form>
	{:else}
		<div class="mt-3 flex flex-wrap gap-2">
			<button
				type="button"
				class={`rounded-full px-3 py-1.5 text-xs font-semibold ${
					lead.whatsapp_e164
						? 'bg-slate-100 text-slate-700 ring-1 ring-slate-200 hover:ring-slate-400'
						: 'border border-dashed border-amber-400 bg-amber-50 font-bold text-amber-800 hover:bg-amber-100'
				}`}
				onclick={() => startEdit('phone')}
			>
				{lead.whatsapp_e164 || '+ Número'}
			</button>
			<button
				type="button"
				class={`rounded-full px-3 py-1.5 text-xs font-semibold ${
					lead.email
						? 'bg-slate-100 text-slate-700 ring-1 ring-slate-200 hover:ring-slate-400'
						: 'border border-dashed border-amber-400 bg-amber-50 font-bold text-amber-800 hover:bg-amber-100'
				}`}
				onclick={() => startEdit('email')}
			>
				{lead.email || '+ Email'}
			</button>
			<button
				type="button"
				class={`rounded-full px-3 py-1.5 text-xs font-semibold ${
					lead.notes
						? 'bg-slate-100 text-slate-700 ring-1 ring-slate-200 hover:ring-slate-400'
						: 'border border-dashed border-slate-300 bg-white font-bold text-slate-600 hover:bg-slate-50'
				}`}
				onclick={() => startEdit('notes')}
			>
				{lead.notes ? 'Editar notas' : '+ Notas'}
			</button>
		</div>
		{#if lead.notes}
			<p class="mt-2 line-clamp-2 text-sm text-slate-600">{lead.notes}</p>
		{/if}
	{/if}

	{#if scheduledControlsVisible}
		<form
			class="mt-4 flex flex-wrap items-end gap-2 rounded-2xl bg-slate-50 p-3"
			onsubmit={(event) => {
				event.preventDefault();
				void reschedule();
			}}
		>
			<label class="min-w-48 flex-1 text-xs font-semibold text-slate-700">
				Novo horário
				<input
					class="mt-1 w-full rounded-xl border-slate-300 text-sm"
					type="datetime-local"
					value={scheduleDraft || toDateTimeLocal(lead.next_scheduled_for)}
					oninput={(event) => {
						scheduleDraft = event.currentTarget.value;
					}}
					disabled={rescheduleBusy || cancelBusy}
					required
				/>
			</label>
			<button
				class="rounded-xl bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-700 disabled:opacity-60"
				disabled={rescheduleBusy || cancelBusy || !attendanceId}
			>
				Reagendar
			</button>
			<button
				type="button"
				class="rounded-xl border border-red-200 px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-50 disabled:opacity-60"
				onclick={cancelSchedule}
				disabled={rescheduleBusy || cancelBusy || !attendanceId}
			>
				Cancelar agendamento
			</button>
		</form>
	{/if}

	{#if mode === 'search' && lead.last_status === 'FINALIZED' && lead.last_attendance_id}
		<div class="mt-4">
			<button
				type="button"
				class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
				onclick={reopenAttendance}
				disabled={reopenBusy}
			>
				Reabrir atendimento
			</button>
		</div>
	{/if}

	{#if message}
		<p class="mt-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-900">
			{message}
		</p>
	{/if}
</article>
