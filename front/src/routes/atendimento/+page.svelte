<script lang="ts">
	import { browser } from '$app/environment';
	import { api, dateTime, money } from '$lib/api/client';
	import Empty from '$lib/components/Empty.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { asCents, errorMessage, queryString, statusLabel } from '$lib/helpers';
	import { getSessionContext } from '$lib/session';
	import type { Academy, Attendance, LossReason, OutcomeType, Professor } from '$lib/types';
	import { onMount } from 'svelte';

	type Presenter = 'RECEPTIONIST' | 'PROFESSOR';
	type EventType =
		| 'SALE'
		| 'LOSS'
		| 'EXPERIMENTAL_CLASS_SCHEDULED'
		| 'EXPERIMENTAL_CLASS_NOW'
		| 'FOLLOW_UP_SCHEDULED'
		| 'OTHER'
		| 'REOPEN'
		| 'NOTE';
	type DuplicateLead = {
		id: string;
		name: string;
		email?: string | null;
		whatsapp_e164?: string | null;
		score?: number;
	};
	type LeadDraft = {
		leadId: string;
		name: string;
		countryCode: string;
		areaCode: string;
		number: string;
		email: string;
		notes: string;
		academyId: string;
		presenter: Presenter;
		professorId: string;
	};

	const DRAFT_KEY = 'attendance-draft';
	const eventTypes: Array<{ value: EventType; label: string }> = [
		{ value: 'NOTE', label: 'Nota' },
		{ value: 'SALE', label: 'Venda' },
		{ value: 'LOSS', label: 'Perda' },
		{ value: 'EXPERIMENTAL_CLASS_SCHEDULED', label: 'Aula experimental agendada' },
		{ value: 'EXPERIMENTAL_CLASS_NOW', label: 'Aula experimental agora' },
		{ value: 'FOLLOW_UP_SCHEDULED', label: 'Follow-up agendado' },
		{ value: 'OTHER', label: 'Outro evento' },
		{ value: 'REOPEN', label: 'Reabrir atendimento' }
	];
	const { session } = getSessionContext();

	let academies = $state.raw<Academy[]>([]);
	let professors = $state.raw<Professor[]>([]);
	let outcomeTypes = $state.raw<OutcomeType[]>([]);
	let lossReasons = $state.raw<LossReason[]>([]);
	let queue = $state.raw<Attendance[]>([]);
	let queueLoading = $state(false);
	let selectedAttendanceId = $state('');
	let duplicateExact = $state.raw<DuplicateLead[]>([]);
	let duplicateProbable = $state.raw<DuplicateLead[]>([]);
	let attendanceMessage = $state('');
	let attendanceBusy = $state(false);
	let draftSaveStatus = $state(browser ? 'Rascunho pronto para edição.' : '');
	let leadDraft = $state<LeadDraft>(createLeadDraft());
	let eventForm = $state({
		type: 'NOTE' as EventType,
		outcomeTypeId: '',
		manualLabel: '',
		manualValue: '',
		lossReasonId: '',
		scheduledFor: '',
		description: ''
	});
	let activeAcademies = $derived(academies.filter((academy) => academy.active));
	let filteredProfessors = $derived(
		professors.filter((professor) => {
			const sameAcademy = !leadDraft.academyId || professor.academy_id === leadDraft.academyId;
			return sameAcademy && professor.active;
		})
	);
	let activeOutcomeTypes = $derived(outcomeTypes.filter((outcome) => outcome.active));
	let activeLossReasons = $derived(lossReasons.filter((reason) => reason.active));
	let selectedAttendance = $derived(
		queue.find((attendance) => attendance.id === selectedAttendanceId)
	);
	let selectedOutcome = $derived(
		outcomeTypes.find((outcome) => outcome.id === eventForm.outcomeTypeId)
	);
	let saleNeedsManual = $derived(
		!eventForm.outcomeTypeId || Boolean(selectedOutcome?.requires_manual_value)
	);

	onMount(() => {
		void loadReferenceData();
	});

	function defaultLeadDraft(): LeadDraft {
		return {
			leadId: '',
			name: '',
			countryCode: '55',
			areaCode: '16',
			number: '',
			email: '',
			notes: '',
			academyId: '',
			presenter: 'RECEPTIONIST',
			professorId: ''
		};
	}

	function createLeadDraft() {
		if (!browser) return defaultLeadDraft();
		try {
			const saved = localStorage.getItem(DRAFT_KEY);
			return saved ? { ...defaultLeadDraft(), ...JSON.parse(saved) } : defaultLeadDraft();
		} catch {
			return defaultLeadDraft();
		}
	}

	function saveLeadDraft() {
		if (!browser) return;
		localStorage.setItem(DRAFT_KEY, JSON.stringify(leadDraft));
		draftSaveStatus = `Rascunho salvo às ${new Intl.DateTimeFormat('pt-BR', {
			hour: '2-digit',
			minute: '2-digit'
		}).format(new Date())}`;
	}

	async function loadReferenceData() {
		if (!session.user) return;
		attendanceMessage = '';
		try {
			const [academyData, professorData, outcomeData, lossData] = await Promise.all([
				api<{ academies: Academy[] }>('/api/admin/academies'),
				api<{ professors: Professor[] }>('/api/admin/professors'),
				api<{ outcomeTypes: OutcomeType[] }>('/api/admin/outcome-types'),
				api<{ lossReasons: LossReason[] }>('/api/admin/loss-reasons')
			]);
			academies = academyData.academies;
			professors = professorData.professors;
			outcomeTypes = outcomeData.outcomeTypes;
			lossReasons = lossData.lossReasons;
			if (!leadDraft.academyId && activeAcademies[0]) leadDraft.academyId = activeAcademies[0].id;
			await loadQueue();
		} catch (error) {
			attendanceMessage = errorMessage(error);
		}
	}

	async function loadQueue() {
		if (!session.user) return;
		queueLoading = true;
		attendanceMessage = '';
		try {
			const data = await api<{ attendances: Attendance[] }>(
				`/api/attendances${queryString({ academyId: leadDraft.academyId })}`
			);
			queue = data.attendances;
			if (!queue.some((attendance) => attendance.id === selectedAttendanceId)) {
				selectedAttendanceId = queue[0]?.id ?? '';
			}
		} catch (error) {
			attendanceMessage = errorMessage(error);
		} finally {
			queueLoading = false;
		}
	}

	async function checkDuplicates() {
		attendanceBusy = true;
		attendanceMessage = '';
		try {
			const data = await api<{ exact: DuplicateLead[]; probable: DuplicateLead[] }>(
				`/api/leads/duplicates${queryString({
					name: leadDraft.name,
					email: leadDraft.email,
					countryCode: leadDraft.countryCode,
					areaCode: leadDraft.areaCode,
					phoneNumber: leadDraft.number
				})}`
			);
			duplicateExact = data.exact;
			duplicateProbable = data.probable;
			attendanceMessage =
				data.exact.length || data.probable.length
					? 'Possíveis duplicidades encontradas.'
					: 'Nenhuma duplicidade encontrada.';
		} catch (error) {
			attendanceMessage = errorMessage(error);
		} finally {
			attendanceBusy = false;
		}
	}

	function useDuplicate(lead: DuplicateLead) {
		leadDraft.leadId = lead.id;
		leadDraft.name = lead.name;
		leadDraft.email = lead.email ?? '';
		saveLeadDraft();
		attendanceMessage = 'Lead existente selecionado para o atendimento.';
	}

	async function createAttendance(event: SubmitEvent) {
		event.preventDefault();
		attendanceBusy = true;
		attendanceMessage = '';
		try {
			const payload = {
				academyId: leadDraft.academyId,
				leadId: leadDraft.leadId || undefined,
				lead: {
					name: leadDraft.name,
					email: leadDraft.email || null,
					phone: {
						countryCode: leadDraft.countryCode,
						areaCode: leadDraft.areaCode,
						number: leadDraft.number
					},
					notes: leadDraft.notes || null
				},
				professorId: leadDraft.presenter === 'PROFESSOR' ? leadDraft.professorId || null : null,
				presenter: leadDraft.presenter,
				status: 'IN_PROGRESS'
			};
			const data = await api<{ attendance: Attendance }>('/api/attendances', {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			selectedAttendanceId = data.attendance.id;
			const academyId = leadDraft.academyId;
			Object.assign(leadDraft, { ...defaultLeadDraft(), academyId });
			saveLeadDraft();
			duplicateExact = [];
			duplicateProbable = [];
			attendanceMessage = 'Atendimento aberto com sucesso.';
			await loadQueue();
		} catch (error) {
			attendanceMessage = errorMessage(error);
		} finally {
			attendanceBusy = false;
		}
	}

	async function submitAttendanceEvent(event: SubmitEvent) {
		event.preventDefault();
		if (!selectedAttendanceId) {
			attendanceMessage = 'Selecione um atendimento antes de registrar eventos.';
			return;
		}
		if (
			eventForm.type === 'SALE' &&
			browser &&
			!window.confirm('Confirmar venda para este atendimento?')
		)
			return;

		attendanceBusy = true;
		attendanceMessage = '';
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
			} else if (
				eventForm.type === 'EXPERIMENTAL_CLASS_SCHEDULED' ||
				eventForm.type === 'FOLLOW_UP_SCHEDULED'
			) {
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

			await api<{ event: { id: string } }>(`/api/attendances/${selectedAttendanceId}/events`, {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			eventForm.description = '';
			eventForm.manualLabel = '';
			eventForm.manualValue = '';
			attendanceMessage = 'Evento registrado.';
			await loadQueue();
		} catch (error) {
			attendanceMessage = errorMessage(error);
		} finally {
			attendanceBusy = false;
		}
	}
</script>

<svelte:head>
	<title>Atendimento | Tracker de conversão</title>
</svelte:head>

<section class="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
	<div class="space-y-6">
		<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
			<h2 class="text-2xl font-bold text-slate-950">Novo atendimento</h2>
			<p class="text-slate-600">Campos grandes para abrir a ficha rapidamente na recepção.</p>
			<form
				class="mt-5 grid gap-4"
				onsubmit={createAttendance}
				oninput={saveLeadDraft}
				onchange={saveLeadDraft}
			>
				<div class="grid gap-4 sm:grid-cols-2">
					<label class="text-sm font-medium text-slate-700">
						Nome do lead
						<input
							class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
							bind:value={leadDraft.name}
							required
						/>
					</label>
					<label class="text-sm font-medium text-slate-700">
						Email opcional
						<input
							class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
							type="email"
							bind:value={leadDraft.email}
						/>
					</label>
				</div>
				<fieldset class="grid gap-3 sm:grid-cols-[0.6fr_0.6fr_1.8fr]">
					<legend class="sr-only">WhatsApp</legend>
					<label class="text-sm font-medium text-slate-700"
						>País<input
							class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
							inputmode="numeric"
							bind:value={leadDraft.countryCode}
							required
						/></label
					>
					<label class="text-sm font-medium text-slate-700"
						>DDD<input
							class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
							inputmode="numeric"
							bind:value={leadDraft.areaCode}
							required
						/></label
					>
					<label class="text-sm font-medium text-slate-700"
						>Número<input
							class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
							inputmode="numeric"
							bind:value={leadDraft.number}
							required
						/></label
					>
				</fieldset>
				<div class="grid gap-4 sm:grid-cols-2">
					<label class="text-sm font-medium text-slate-700">
						Academia
						<select
							class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
							bind:value={leadDraft.academyId}
							required
						>
							<option value="" disabled>Selecione</option>
							{#each activeAcademies as academy (academy.id)}
								<option value={academy.id}>{academy.name}</option>
							{/each}
						</select>
					</label>
					<label class="text-sm font-medium text-slate-700">
						Apresentação
						<select
							class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
							bind:value={leadDraft.presenter}
						>
							<option value="RECEPTIONIST">Recepção</option>
							<option value="PROFESSOR">Professor</option>
						</select>
					</label>
				</div>
				{#if leadDraft.presenter === 'PROFESSOR'}
					<label class="text-sm font-medium text-slate-700">
						Professor
						<select
							class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
							bind:value={leadDraft.professorId}
							required
						>
							<option value="" disabled>Selecione</option>
							{#each filteredProfessors as professor (professor.id)}
								<option value={professor.id}>{professor.name}</option>
							{/each}
						</select>
					</label>
				{/if}
				<label class="text-sm font-medium text-slate-700">
					Observações
					<textarea
						class="mt-1 w-full rounded-2xl border-slate-300"
						rows="3"
						bind:value={leadDraft.notes}></textarea>
				</label>
				<p class="text-xs font-medium text-emerald-700">{draftSaveStatus}</p>
				<div class="grid gap-3 sm:grid-cols-2">
					<button
						type="button"
						class="rounded-2xl border border-slate-300 px-5 py-4 text-base font-bold text-slate-700 hover:bg-slate-50"
						onclick={checkDuplicates}
						disabled={attendanceBusy}
					>
						Checar duplicidade
					</button>
					<button
						class="rounded-2xl bg-emerald-600 px-5 py-4 text-base font-bold text-white hover:bg-emerald-700 disabled:opacity-60"
						disabled={attendanceBusy}
					>
						Abrir atendimento
					</button>
				</div>
			</form>
			<Notice message={attendanceMessage} />
			{#if duplicateExact.length || duplicateProbable.length}
				<div class="mt-4 grid gap-3">
					{#each [...duplicateExact, ...duplicateProbable] as lead (lead.id)}
						<div
							class="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-3"
						>
							<p class="text-sm">
								<strong>{lead.name}</strong><br />{lead.email ?? 'Sem email'} · {lead.whatsapp_e164 ??
									'Sem telefone'}
							</p>
							<button
								class="rounded-xl bg-amber-600 px-3 py-2 text-sm font-bold text-white"
								type="button"
								onclick={() => useDuplicate(lead)}>Usar lead</button
							>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	</div>

	<div class="space-y-6">
		<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h2 class="text-2xl font-bold text-slate-950">Fila visual</h2>
					<p class="text-slate-600">Selecione um atendimento para registrar o próximo evento.</p>
				</div>
				<button
					class="rounded-2xl border border-slate-300 px-4 py-3 font-semibold text-slate-700 hover:bg-slate-50"
					onclick={loadQueue}
					disabled={queueLoading}
				>
					Atualizar fila
				</button>
			</div>
			{#if queue.length}
				<div class="mt-5 grid gap-3 md:grid-cols-2">
					{#each queue as attendance (attendance.id)}
						<button
							type="button"
							class={`rounded-2xl border p-4 text-left transition ${selectedAttendanceId === attendance.id ? 'border-sky-500 bg-sky-50 ring-2 ring-sky-200' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
							onclick={() => (selectedAttendanceId = attendance.id)}
						>
							<span class="text-sm font-bold text-slate-950">{attendance.lead_name}</span>
							<span class="mt-1 block text-xs text-slate-500">{attendance.whatsapp_e164}</span>
							<span
								class="mt-3 inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700"
								>{statusLabel(attendance.status)}</span
							>
							<span class="mt-2 block text-xs text-slate-500"
								>{attendance.professor_name ?? 'Sem professor'} · {dateTime(
									attendance.started_at
								)}</span
							>
						</button>
					{/each}
				</div>
			{:else}
				<Empty text="Nenhum atendimento aberto para esta visão." />
			{/if}
		</section>

		<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
			<h3 class="text-xl font-bold text-slate-950">Registrar evento</h3>
			<p class="text-sm text-slate-600">
				{#if selectedAttendance}
					Selecionado: <strong>{selectedAttendance.lead_name}</strong>
				{:else}
					Selecione um atendimento na fila.
				{/if}
			</p>
			<form class="mt-5 grid gap-4" onsubmit={submitAttendanceEvent}>
				<label class="text-sm font-medium text-slate-700">
					Tipo de evento
					<select
						class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
						bind:value={eventForm.type}
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
									required
								/></label
							>
							<label class="text-sm font-medium text-slate-700"
								>Valor em R$<input
									class="mt-1 w-full rounded-2xl border-slate-300"
									inputmode="decimal"
									bind:value={eventForm.manualValue}
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
							required
						>
							<option value="" disabled>Selecione</option>
							{#each activeLossReasons as reason (reason.id)}
								<option value={reason.id}>{reason.label}</option>
							{/each}
						</select>
					</label>
				{:else if eventForm.type === 'EXPERIMENTAL_CLASS_SCHEDULED' || eventForm.type === 'FOLLOW_UP_SCHEDULED'}
					<label class="text-sm font-medium text-slate-700"
						>Data e horário<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							type="datetime-local"
							bind:value={eventForm.scheduledFor}
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
						required={eventForm.type === 'OTHER' || eventForm.type === 'NOTE'}></textarea>
				</label>
				<button
					class="rounded-2xl bg-sky-600 px-5 py-4 text-base font-bold text-white hover:bg-sky-700 disabled:opacity-60"
					disabled={attendanceBusy || !selectedAttendanceId}
				>
					Registrar evento
				</button>
			</form>
		</section>
	</div>
</section>
