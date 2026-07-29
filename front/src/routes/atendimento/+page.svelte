<script lang="ts">
	import { browser } from '$app/environment';
	import { api, dateTime, money } from '$lib/api/client';
	import Empty from '$lib/components/Empty.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { asCents, errorMessage, queryString, statusLabel } from '$lib/helpers';
	import { getSessionContext } from '$lib/session';
	import type { Academy, Attendance, LossReason, OutcomeType, Professor } from '$lib/types';
	import { onMount } from 'svelte';

	type EventType =
		| 'SALE'
		| 'LOSS'
		| 'EXPERIMENTAL_CLASS_SCHEDULED'
		| 'EXPERIMENTAL_CLASS_NOW'
		| 'FOLLOW_UP_SCHEDULED'
		| 'OTHER'
		| 'REOPEN'
		| 'NOTE';
	type QuickDraft = {
		name: string;
		academyId: string;
	};
	type EditingField = 'phone' | 'email' | 'professor';
	type EditingTarget = {
		attendanceId: string;
		field: EditingField;
	};

	const DRAFT_KEY = 'attendance-quick-draft';
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
	let attendanceMessage = $state('');
	let attendanceBusy = $state(false);
	let quickDraft = $state<QuickDraft>(createQuickDraft());
	let editing = $state<EditingTarget | null>(null);
	let editingValue = $state('');
	let editingBusy = $state(false);
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
	let pendingCount = $derived(
		queue.filter(
			(attendance) =>
				!attendance.whatsapp_e164 || !attendance.lead_email || !attendance.professor_name
		).length
	);

	onMount(() => {
		void loadReferenceData();
	});

	function defaultQuickDraft(): QuickDraft {
		return { name: '', academyId: '' };
	}

	function createQuickDraft() {
		if (!browser) return defaultQuickDraft();
		try {
			const saved = localStorage.getItem(DRAFT_KEY);
			return saved ? { ...defaultQuickDraft(), ...JSON.parse(saved) } : defaultQuickDraft();
		} catch {
			return defaultQuickDraft();
		}
	}

	function saveQuickDraft() {
		if (!browser) return;
		localStorage.setItem(DRAFT_KEY, JSON.stringify(quickDraft));
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
			if (!quickDraft.academyId && activeAcademies[0]) quickDraft.academyId = activeAcademies[0].id;
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
				`/api/attendances${queryString({ academyId: quickDraft.academyId })}`
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

	async function startAttendance(event: SubmitEvent) {
		event.preventDefault();
		attendanceBusy = true;
		attendanceMessage = '';
		try {
			const data = await api<{ attendance: Attendance }>('/api/attendances', {
				method: 'POST',
				body: JSON.stringify({
					academyId: quickDraft.academyId,
					lead: { name: quickDraft.name.trim() },
					presenter: 'RECEPTIONIST',
					status: 'IN_PROGRESS'
				})
			});
			selectedAttendanceId = data.attendance.id;
			quickDraft.name = '';
			saveQuickDraft();
			attendanceMessage = 'Atendimento iniciado. Complete os dados direto na fila quando puder.';
			await loadQueue();
		} catch (error) {
			attendanceMessage = errorMessage(error);
		} finally {
			attendanceBusy = false;
		}
	}

	function professorsForAcademy(academyId: string) {
		return professors.filter((professor) => professor.academy_id === academyId && professor.active);
	}

	function autofocus(node: HTMLElement) {
		node.focus();
	}

	function startEdit(attendance: Attendance, field: EditingField) {
		editing = { attendanceId: attendance.id, field };
		if (field === 'phone') editingValue = attendance.whatsapp_e164?.replace(/^\+55/, '') ?? '';
		else if (field === 'email') editingValue = attendance.lead_email ?? '';
		else editingValue = attendance.professor_id ?? '';
	}

	function cancelEdit() {
		editing = null;
		editingValue = '';
	}

	function parsePhone(raw: string) {
		let digits = raw.replace(/\D/g, '');
		if (digits.startsWith('55') && digits.length >= 12) digits = digits.slice(2);
		if (digits.length < 10) return null;
		return { countryCode: '55', areaCode: digits.slice(0, 2), number: digits.slice(2) };
	}

	async function patchLead(attendance: Attendance, payload: Record<string, unknown>) {
		await api<{ lead: { id: string } }>(`/api/leads/${attendance.lead_id}`, {
			method: 'PATCH',
			body: JSON.stringify(payload)
		});
	}

	async function savePhone(attendance: Attendance) {
		const phone = parsePhone(editingValue);
		if (!phone) {
			attendanceMessage = 'Informe DDD + número (ex.: 16999998888).';
			return;
		}
		editingBusy = true;
		attendanceMessage = '';
		try {
			await patchLead(attendance, { phone });
			cancelEdit();
			attendanceMessage = 'Número salvo.';
			await loadQueue();
		} catch (error) {
			attendanceMessage = errorMessage(error);
		} finally {
			editingBusy = false;
		}
	}

	async function saveEmail(attendance: Attendance) {
		editingBusy = true;
		attendanceMessage = '';
		try {
			await patchLead(attendance, { email: editingValue.trim() || null });
			cancelEdit();
			attendanceMessage = 'Email salvo.';
			await loadQueue();
		} catch (error) {
			attendanceMessage = errorMessage(error);
		} finally {
			editingBusy = false;
		}
	}

	async function saveProfessor(attendance: Attendance) {
		editingBusy = true;
		attendanceMessage = '';
		try {
			await api<{ attendance: Attendance }>(`/api/attendances/${attendance.id}`, {
				method: 'PATCH',
				body: JSON.stringify({
					professorId: editingValue || null,
					presenter: editingValue ? 'PROFESSOR' : 'RECEPTIONIST'
				})
			});
			cancelEdit();
			attendanceMessage = 'Professor atualizado.';
			await loadQueue();
		} catch (error) {
			attendanceMessage = errorMessage(error);
		} finally {
			editingBusy = false;
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
			<p class="text-slate-600">
				Comece só com o primeiro nome. Número, email e professor ficam pendentes na fila para
				completar quando puder.
			</p>
			<form
				class="mt-5 grid gap-4"
				onsubmit={startAttendance}
				oninput={saveQuickDraft}
				onchange={saveQuickDraft}
			>
				<label class="text-sm font-medium text-slate-700">
					Primeiro nome
					<input
						class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
						bind:value={quickDraft.name}
						placeholder="Ex.: Ana"
						autocomplete="off"
						minlength="2"
						required
					/>
				</label>
				<label class="text-sm font-medium text-slate-700">
					Academia
					<select
						class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
						bind:value={quickDraft.academyId}
						onchange={() => void loadQueue()}
						required
					>
						<option value="" disabled>Selecione</option>
						{#each activeAcademies as academy (academy.id)}
							<option value={academy.id}>{academy.name}</option>
						{/each}
					</select>
				</label>
				<button
					class="rounded-2xl bg-emerald-600 px-5 py-4 text-base font-bold text-white hover:bg-emerald-700 disabled:opacity-60"
					disabled={attendanceBusy}
				>
					Iniciar atendimento
				</button>
			</form>
			<Notice message={attendanceMessage} />
		</section>
	</div>

	<div class="space-y-6">
		<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
			<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h2 class="text-2xl font-bold text-slate-950">Fila visual</h2>
					<p class="text-slate-600">
						Toque em um campo pendente para completá-lo sem sair da fila.
					</p>
				</div>
				<div class="flex items-center gap-2">
					{#if pendingCount}
						<span
							class="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800 ring-1 ring-amber-300"
						>
							{pendingCount} com dados pendentes
						</span>
					{/if}
					<button
						class="rounded-2xl border border-slate-300 px-4 py-3 font-semibold text-slate-700 hover:bg-slate-50"
						onclick={loadQueue}
						disabled={queueLoading}
					>
						Atualizar fila
					</button>
				</div>
			</div>
			{#if queue.length}
				<div class="mt-5 grid gap-3">
					{#each queue as attendance (attendance.id)}
						<article
							class={`rounded-2xl border p-4 transition ${selectedAttendanceId === attendance.id ? 'border-sky-500 bg-sky-50 ring-2 ring-sky-200' : 'border-slate-200 bg-white'}`}
						>
							<div class="flex items-start justify-between gap-3">
								<button
									type="button"
									class="min-w-0 flex-1 text-left"
									onclick={() => (selectedAttendanceId = attendance.id)}
								>
									<span class="truncate text-sm font-bold text-slate-950"
										>{attendance.lead_name}</span
									>
									<span class="mt-1 block text-xs text-slate-500">
										{statusLabel(attendance.status)} · {dateTime(attendance.started_at)}
									</span>
								</button>
								{#if selectedAttendanceId === attendance.id}
									<span
										class="shrink-0 rounded-full bg-sky-600 px-3 py-1 text-xs font-bold text-white"
										>Selecionado</span
									>
								{/if}
							</div>

							{#if editing?.attendanceId === attendance.id}
								{#if editing.field === 'phone'}
									<form
										class="mt-3 flex flex-wrap items-center gap-2"
										onsubmit={(event) => {
											event.preventDefault();
											void savePhone(attendance);
										}}
									>
										<input
											class="min-w-0 flex-1 rounded-xl border-slate-300 text-base"
											inputmode="numeric"
											placeholder="DDD + número (ex.: 16999998888)"
											bind:value={editingValue}
											{@attach autofocus}
										/>
										<button
											class="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
											disabled={editingBusy}>Salvar</button
										>
										<button
											type="button"
											class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600"
											onclick={cancelEdit}>Cancelar</button
										>
									</form>
								{:else if editing.field === 'email'}
									<form
										class="mt-3 flex flex-wrap items-center gap-2"
										onsubmit={(event) => {
											event.preventDefault();
											void saveEmail(attendance);
										}}
									>
										<input
											class="min-w-0 flex-1 rounded-xl border-slate-300 text-base"
											type="email"
											placeholder="email@exemplo.com"
											bind:value={editingValue}
											{@attach autofocus}
										/>
										<button
											class="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
											disabled={editingBusy}>Salvar</button
										>
										<button
											type="button"
											class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600"
											onclick={cancelEdit}>Cancelar</button
										>
									</form>
								{:else}
									<div class="mt-3 flex flex-wrap items-center gap-2">
										<select
											class="min-w-0 flex-1 rounded-xl border-slate-300 text-base"
											bind:value={editingValue}
											onchange={() => void saveProfessor(attendance)}
											disabled={editingBusy}
											{@attach autofocus}
										>
											<option value="">Recepção (sem professor)</option>
											{#each professorsForAcademy(attendance.academy_id) as professor (professor.id)}
												<option value={professor.id}>{professor.name}</option>
											{/each}
										</select>
										<button
											type="button"
											class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600"
											onclick={cancelEdit}>Cancelar</button
										>
									</div>
								{/if}
							{:else}
								<div class="mt-3 flex flex-wrap gap-2">
									{#if attendance.whatsapp_e164}
										<button
											type="button"
											class="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 hover:ring-slate-400"
											onclick={() => startEdit(attendance, 'phone')}
											title="Editar número">{attendance.whatsapp_e164}</button
										>
									{:else}
										<button
											type="button"
											class="rounded-full border border-dashed border-amber-400 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100"
											onclick={() => startEdit(attendance, 'phone')}>+ Número</button
										>
									{/if}
									{#if attendance.lead_email}
										<button
											type="button"
											class="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 hover:ring-slate-400"
											onclick={() => startEdit(attendance, 'email')}
											title="Editar email">{attendance.lead_email}</button
										>
									{:else}
										<button
											type="button"
											class="rounded-full border border-dashed border-amber-400 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100"
											onclick={() => startEdit(attendance, 'email')}>+ Email</button
										>
									{/if}
									{#if attendance.professor_name}
										<button
											type="button"
											class="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 hover:ring-slate-400"
											onclick={() => startEdit(attendance, 'professor')}
											title="Trocar professor">{attendance.professor_name}</button
										>
									{:else}
										<button
											type="button"
											class="rounded-full border border-dashed border-amber-400 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100"
											onclick={() => startEdit(attendance, 'professor')}>+ Professor</button
										>
									{/if}
								</div>
							{/if}
						</article>
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
