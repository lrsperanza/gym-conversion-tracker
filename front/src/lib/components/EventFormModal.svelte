<script lang="ts">
	import { browser } from '$app/environment';
	import { api, dateTime, money } from '$lib/api/client';
	import { asCents, errorMessage, eventTypeLabel } from '$lib/helpers';
	import type { Attendance, AttendanceEventType, LossReason, OutcomeType } from '$lib/types';

	type EventTypeOption = {
		value: AttendanceEventType;
		label: string;
	};

	let {
		attendance,
		outcomeTypes,
		lossReasons,
		onClose,
		onSaved
	}: {
		attendance: Attendance | null;
		outcomeTypes: OutcomeType[];
		lossReasons: LossReason[];
		onClose: () => void;
		onSaved: () => Promise<void> | void;
	} = $props();

	const baseEventTypes: EventTypeOption[] = [
		{ value: 'NOTE', label: 'Nota' },
		{ value: 'SALE', label: 'Venda' },
		{ value: 'LOSS', label: 'Perda' },
		{ value: 'EXPERIMENTAL_CLASS_SCHEDULED', label: 'Aula experimental agendada' },
		{ value: 'EXPERIMENTAL_CLASS_NOW', label: 'Aula experimental agora' },
		{ value: 'FOLLOW_UP_SCHEDULED', label: 'Follow-up agendado' },
		{ value: 'OTHER', label: 'Outro evento' },
		{ value: 'REOPEN', label: 'Reabrir atendimento' }
	];

	let busy = $state(false);
	let message = $state('');
	let eventForm = $state(createForm());
	let activeOutcomeTypes = $derived(outcomeTypes.filter((outcome) => outcome.active));
	let activeLossReasons = $derived(lossReasons.filter((reason) => reason.active));
	let selectedOutcome = $derived(
		outcomeTypes.find((outcome) => outcome.id === eventForm.outcomeTypeId)
	);
	let saleNeedsManual = $derived(
		!eventForm.outcomeTypeId || Boolean(selectedOutcome?.requires_manual_value)
	);
	let eventTypes = $derived.by(() => {
		if (!attendance?.next_scheduled_for) return baseEventTypes;
		return [...baseEventTypes, { value: 'SCHEDULE_CANCELLED', label: 'Cancelar agendamento' }];
	});

	function createForm() {
		return {
			type: 'NOTE' as AttendanceEventType,
			outcomeTypeId: '',
			manualLabel: '',
			manualValue: '',
			lossReasonId: '',
			scheduledFor: '',
			description: ''
		};
	}

	function isScheduledEvent(type: AttendanceEventType) {
		return type === 'EXPERIMENTAL_CLASS_SCHEDULED' || type === 'FOLLOW_UP_SCHEDULED';
	}

	function handleClose() {
		if (busy) return;
		eventForm = createForm();
		message = '';
		onClose();
	}

	async function submitAttendanceEvent(event: SubmitEvent) {
		event.preventDefault();
		if (!attendance) return;
		if (
			eventForm.type === 'SALE' &&
			browser &&
			!window.confirm('Confirmar venda para este atendimento?')
		) {
			return;
		}

		busy = true;
		message = '';
		try {
			let payload: Record<string, unknown> = { type: eventForm.type };
			if (eventForm.type === 'SALE') {
				payload = {
					type: 'SALE',
					outcomeTypeId: eventForm.outcomeTypeId || null,
					manualLabel: saleNeedsManual ? eventForm.manualLabel : undefined,
					manualValueCents: saleNeedsManual ? asCents(eventForm.manualValue) : undefined
				};
			} else if (eventForm.type === 'LOSS') {
				payload = {
					type: 'LOSS',
					lossReasonId: eventForm.lossReasonId,
					description: eventForm.description || undefined
				};
			} else if (isScheduledEvent(eventForm.type)) {
				payload = {
					type: eventForm.type,
					scheduledFor: new Date(eventForm.scheduledFor).toISOString(),
					description: eventForm.description || undefined
				};
			} else if (eventForm.type === 'OTHER' || eventForm.type === 'NOTE') {
				payload = { type: eventForm.type, description: eventForm.description };
			} else {
				payload = { type: eventForm.type, description: eventForm.description || undefined };
			}

			await api<{ event: { id: string } }>(`/api/attendances/${attendance.id}/events`, {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			eventForm = createForm();
			await onSaved();
			message = '';
			onClose();
		} catch (error) {
			message = errorMessage(error);
		} finally {
			busy = false;
		}
	}
</script>

<dialog
	class="fixed inset-0 z-50 m-auto w-[min(42rem,calc(100vw-2rem))] rounded-3xl border border-slate-200 bg-white p-0 shadow-2xl backdrop:bg-slate-950/40"
	open={attendance !== null}
	onclose={handleClose}
	oncancel={(event) => {
		if (busy) event.preventDefault();
	}}
	onclick={(event) => {
		if (event.target === event.currentTarget) handleClose();
	}}
>
	{#if attendance}
		<div class="max-h-[calc(100vh-2rem)] overflow-y-auto p-5">
			<div class="flex items-start justify-between gap-4">
				<div>
					<h3 class="text-xl font-bold text-slate-950">Registrar evento</h3>
					<p class="text-sm text-slate-600">
						{attendance.lead_name} · {dateTime(attendance.started_at)}
					</p>
					{#if attendance.next_scheduled_for}
						<p class="mt-2 text-xs font-semibold text-sky-700">
							{eventTypeLabel(attendance.next_event_type)} em {dateTime(attendance.next_scheduled_for)}
						</p>
					{/if}
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

			<form class="mt-5 grid gap-4" onsubmit={submitAttendanceEvent}>
				<label class="text-sm font-medium text-slate-700">
					Tipo de evento
					<select
						class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
						bind:value={eventForm.type}
						disabled={busy}
					>
						{#each eventTypes as type (type.value)}
							<option value={type.value}>{type.label}</option>
						{/each}
					</select>
				</label>

				{#if eventForm.type === 'SALE'}
					<label class="text-sm font-medium text-slate-700">
						Plano vendido
						<select
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={eventForm.outcomeTypeId}
							disabled={busy}
						>
							<option value="">Venda manual</option>
							{#each activeOutcomeTypes as outcome (outcome.id)}
								<option value={outcome.id}
									>{outcome.label}{outcome.current_value_cents
										? ` · ${money(outcome.current_value_cents)}`
										: ''}</option
								>
							{/each}
						</select>
					</label>
					{#if saleNeedsManual}
						<div class="grid gap-4 sm:grid-cols-2">
							<label class="text-sm font-medium text-slate-700"
								>Descrição manual<input
									class="mt-1 w-full rounded-2xl border-slate-300"
									bind:value={eventForm.manualLabel}
									disabled={busy}
									required
								/></label
							>
							<label class="text-sm font-medium text-slate-700"
								>Valor em R$<input
									class="mt-1 w-full rounded-2xl border-slate-300"
									inputmode="decimal"
									bind:value={eventForm.manualValue}
									disabled={busy}
									required
								/></label
							>
						</div>
					{/if}
				{:else if eventForm.type === 'LOSS'}
					<label class="text-sm font-medium text-slate-700">
						Motivo da perda
						<select
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={eventForm.lossReasonId}
							disabled={busy}
							required
						>
							<option value="" disabled>Selecione</option>
							{#each activeLossReasons as reason (reason.id)}
								<option value={reason.id}>{reason.label}</option>
							{/each}
						</select>
					</label>
				{:else if isScheduledEvent(eventForm.type)}
					<label class="text-sm font-medium text-slate-700"
						>Data e horário<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							type="datetime-local"
							bind:value={eventForm.scheduledFor}
							disabled={busy}
							required
						/></label
					>
				{/if}

				<label class="text-sm font-medium text-slate-700">
					Descrição / nota
					<textarea
						class="mt-1 w-full rounded-2xl border-slate-300"
						rows="3"
						bind:value={eventForm.description}
						disabled={busy}
						required={eventForm.type === 'OTHER' || eventForm.type === 'NOTE'}
					></textarea>
				</label>

				{#if message}
					<p class="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
						{message}
					</p>
				{/if}

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
						Registrar evento
					</button>
				</div>
			</form>
		</div>
	{/if}
</dialog>
