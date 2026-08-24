<script lang="ts">
	import { browser } from '$app/environment';
	import { ApiError, api, dateTime } from '$lib/api/client';
	import Empty from '$lib/components/Empty.svelte';
	import EventFormModal from '$lib/components/EventFormModal.svelte';
	import LeadEventsTimeline from '$lib/components/LeadEventsTimeline.svelte';
	import LeadMergeModal from '$lib/components/LeadMergeModal.svelte';
	import LeadNameEditor from '$lib/components/LeadNameEditor.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import ProfessorFormModal from '$lib/components/ProfessorFormModal.svelte';
	import {
		channelLabel,
		errorMessage,
		eventTypeLabel,
		isImminent,
		isQueueVisible,
		parsePhone,
		queryString,
		statusLabel
	} from '$lib/helpers';
	import { getSessionContext } from '$lib/session';
	import type {
		Academy,
		Attendance,
		AttendanceChannel,
		LossReason,
		OutcomeType,
		Professor
	} from '$lib/types';
	import { onMount } from 'svelte';

	type QuickDraft = {
		name: string;
		academyId: string;
		channel: AttendanceChannel;
	};
	type EditingField = 'phone' | 'email' | 'professor';
	type EditingTarget = {
		attendanceId: string;
		field: EditingField;
	};
	type LeadMergeCandidate = {
		id: string;
		name: string;
		whatsapp_e164?: string | null;
		email?: string | null;
	};
	type DraftLead = {
		name?: string;
		phone?: { countryCode: string; areaCode: string; number: string };
		email?: string | null;
	};

	const DRAFT_KEY = 'attendance-quick-draft';
	const NEW_PROFESSOR = '__new__';
	const { session } = getSessionContext();

	let academies = $state.raw<Academy[]>([]);
	let professors = $state.raw<Professor[]>([]);
	let outcomeTypes = $state.raw<OutcomeType[]>([]);
	let lossReasons = $state.raw<LossReason[]>([]);
	let queue = $state.raw<Attendance[]>([]);
	let queueLoading = $state(false);
	let attendanceMessage = $state('');
	let attendanceBusy = $state(false);
	let closingAttendanceId = $state<string | null>(null);
	let channelBusyId = $state<string | null>(null);
	let quickDraft = $state<QuickDraft>(createQuickDraft());
	let editing = $state<EditingTarget | null>(null);
	let editingValue = $state('');
	let editingBusy = $state(false);
	let modalAttendance = $state.raw<Attendance | null>(null);
	let professorModalAttendance = $state.raw<Attendance | null>(null);
	let mergeAttendance = $state.raw<Attendance | null>(null);
	let mergeExistingLead = $state.raw<LeadMergeCandidate | null>(null);
	let mergeDraftLead = $state.raw<DraftLead | null>(null);
	let now = $state(new Date());
	let activeAcademies = $derived(academies.filter((academy) => academy.active));
	let visibleQueue = $derived(queue.filter((attendance) => isQueueVisible(attendance, now)));
	let hiddenScheduledCount = $derived(queue.length - visibleQueue.length);

	onMount(() => {
		void loadReferenceData();
		const timer = window.setInterval(() => {
			now = new Date();
		}, 30_000);
		return () => window.clearInterval(timer);
	});

	function defaultQuickDraft(): QuickDraft {
		return { name: '', academyId: '', channel: 'PRESENCIAL' };
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
			const [academyData, professorData, lossData] = await Promise.all([
				api<{ academies: Academy[] }>('/api/admin/academies'),
				api<{ professors: Professor[] }>('/api/admin/professors'),
				api<{ lossReasons: LossReason[] }>('/api/admin/loss-reasons'),
				reloadOutcomeTypes()
			]);
			academies = academyData.academies;
			professors = professorData.professors;
			lossReasons = lossData.lossReasons;
			if (!quickDraft.academyId && activeAcademies[0]) quickDraft.academyId = activeAcademies[0].id;
			await loadQueue();
		} catch (error) {
			attendanceMessage = errorMessage(error);
		}
	}

	async function reloadOutcomeTypes() {
		const data = await api<{ outcomeTypes: OutcomeType[] }>('/api/admin/outcome-types');
		outcomeTypes = data.outcomeTypes;
	}

	async function loadProfessors() {
		const data = await api<{ professors: Professor[] }>('/api/admin/professors');
		professors = data.professors;
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
			await api<{ attendance: Attendance }>('/api/attendances', {
				method: 'POST',
				body: JSON.stringify({
					academyId: quickDraft.academyId,
					lead: { name: quickDraft.name.trim() || 'INSERIR NOME' },
					presenter: 'RECEPTIONIST',
					channel: quickDraft.channel,
					status: 'IN_PROGRESS'
				})
			});
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

	async function closeAttendance(attendance: Attendance) {
		if (!attendance.outcome_event_type || closingAttendanceId) return;
		if (
			browser &&
			!window.confirm(
				`Fechar o atendimento de ${attendance.lead_name}? Ele sairá da fila e poderá ser reaberto na aba Leads.`
			)
		) {
			return;
		}
		closingAttendanceId = attendance.id;
		attendanceMessage = '';
		try {
			await api<{ event: { id: string } }>(`/api/attendances/${attendance.id}/events`, {
				method: 'POST',
				body: JSON.stringify({ type: 'CLOSE' })
			});
			attendanceMessage = 'Atendimento fechado.';
			await loadQueue();
		} catch (error) {
			attendanceMessage = errorMessage(error);
		} finally {
			closingAttendanceId = null;
		}
	}

	function professorsForAcademy(academyId: string) {
		return professors.filter((professor) => professor.academy_id === academyId && professor.active);
	}

	function academyName(academyId: string) {
		return academies.find((academy) => academy.id === academyId)?.name ?? null;
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

	async function patchLead(attendance: Attendance, payload: Record<string, unknown>) {
		await api<{ lead: { id: string } }>(`/api/leads/${attendance.lead_id}`, {
			method: 'PATCH',
			body: JSON.stringify(payload)
		});
	}

	function duplicateLeadFromError(error: unknown): LeadMergeCandidate | null {
		if (!(error instanceof ApiError) || error.status !== 409) return null;
		const details = error.details;
		if (!details || typeof details !== 'object') return null;
		const candidate = details as Record<string, unknown>;
		if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return null;
		return {
			id: candidate.id,
			name: candidate.name,
			whatsapp_e164: typeof candidate.whatsapp_e164 === 'string' ? candidate.whatsapp_e164 : null,
			email: typeof candidate.email === 'string' ? candidate.email : null
		};
	}

	function phoneFromAttendance(attendance: Attendance) {
		return attendance.whatsapp_e164
			? (parsePhone(attendance.whatsapp_e164) ?? undefined)
			: undefined;
	}

	function openMergeModal(
		attendance: Attendance,
		existingLead: LeadMergeCandidate,
		draftLead: DraftLead
	) {
		mergeAttendance = attendance;
		mergeExistingLead = existingLead;
		mergeDraftLead = draftLead;
		cancelEdit();
		attendanceMessage = 'Já existe um lead com este contato. Escolha quais dados manter.';
	}

	function closeMergeModal() {
		mergeAttendance = null;
		mergeExistingLead = null;
		mergeDraftLead = null;
	}

	async function handleLeadMerged() {
		closeMergeModal();
		attendanceMessage = 'Lead vinculado ao atendimento.';
		await loadQueue();
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
			const duplicate = duplicateLeadFromError(error);
			if (duplicate) {
				openMergeModal(attendance, duplicate, {
					name: attendance.lead_name,
					phone,
					email: attendance.lead_email
				});
				return;
			}
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
			const duplicate = duplicateLeadFromError(error);
			if (duplicate) {
				openMergeModal(attendance, duplicate, {
					name: attendance.lead_name,
					phone: phoneFromAttendance(attendance),
					email: editingValue.trim() || null
				});
				return;
			}
			attendanceMessage = errorMessage(error);
		} finally {
			editingBusy = false;
		}
	}

	async function updateAttendanceChannel(attendance: Attendance, channel: AttendanceChannel) {
		if (attendance.channel === channel || channelBusyId) return;
		channelBusyId = attendance.id;
		attendanceMessage = '';
		try {
			await api<{ attendance: Attendance }>(`/api/attendances/${attendance.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ channel })
			});
			attendanceMessage = `Canal atualizado para ${channelLabel(channel)}.`;
			await loadQueue();
		} catch (error) {
			attendanceMessage = errorMessage(error);
		} finally {
			channelBusyId = null;
		}
	}

	async function patchProfessor(attendance: Attendance) {
		await api<{ attendance: Attendance }>(`/api/attendances/${attendance.id}`, {
			method: 'PATCH',
			body: JSON.stringify({
				professorId: editingValue || null,
				presenter: editingValue ? 'PROFESSOR' : 'RECEPTIONIST'
			})
		});
	}

	async function saveProfessor(attendance: Attendance) {
		editingBusy = true;
		attendanceMessage = '';
		try {
			await patchProfessor(attendance);
			cancelEdit();
			attendanceMessage = 'Professor atualizado.';
			await loadQueue();
		} catch (error) {
			attendanceMessage = errorMessage(error);
		} finally {
			editingBusy = false;
		}
	}

	function handleProfessorChange(attendance: Attendance) {
		if (editingValue === NEW_PROFESSOR) {
			professorModalAttendance = attendance;
			editingValue = attendance.professor_id ?? '';
			return;
		}
		void saveProfessor(attendance);
	}

	async function handleProfessorCreated(professor: Professor) {
		if (!professorModalAttendance) return;
		const attendance = professorModalAttendance;
		editingBusy = true;
		attendanceMessage = '';
		try {
			await loadProfessors();
			editingValue = professor.id;
			await patchProfessor(attendance);
			professorModalAttendance = null;
			cancelEdit();
			await loadQueue();
			attendanceMessage = 'Professor cadastrado e vinculado ao atendimento.';
		} catch (error) {
			attendanceMessage = errorMessage(error);
			throw error;
		} finally {
			editingBusy = false;
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
				<label class="text-sm font-medium text-slate-700">
					Canal
					<select
						class="mt-1 w-full rounded-2xl border-slate-300 text-lg"
						bind:value={quickDraft.channel}
					>
						<option value="PRESENCIAL">Presencial</option>
						<option value="ONLINE">Online</option>
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
					<button
						class="rounded-2xl border border-slate-300 px-4 py-3 font-semibold text-slate-700 hover:bg-slate-50"
						onclick={loadQueue}
						disabled={queueLoading}
					>
						Atualizar fila
					</button>
				</div>
			</div>
			{#if hiddenScheduledCount > 0}
				<p class="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-600">
					{hiddenScheduledCount} aguardando horário agendado
				</p>
			{/if}

			{#if visibleQueue.length}
				<div class="mt-5 grid gap-3">
					{#each visibleQueue as attendance (attendance.id)}
						<article class="rounded-2xl border border-slate-200 bg-white p-4 transition">
							<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
								<div class="min-w-0 flex-1">
									<LeadNameEditor
										leadId={attendance.lead_id}
										name={attendance.lead_name}
										onSaved={() => loadQueue()}
									/>
									<span class="mt-1 block text-xs text-slate-500">
										{attendance.receptionist_name} · {statusLabel(attendance.status)} · {dateTime(
											attendance.started_at
										)}
									</span>
								</div>
								<div class="flex flex-wrap items-center gap-2">
									{#if attendance.next_scheduled_for}
										<span
											class={`rounded-full px-3 py-1 text-xs font-bold ring-1 ${
												isImminent(attendance.next_scheduled_for, now)
													? 'bg-amber-100 text-amber-900 ring-amber-300'
													: 'bg-sky-50 text-sky-800 ring-sky-200'
											}`}
										>
											{eventTypeLabel(attendance.next_event_type)} · {dateTime(
												attendance.next_scheduled_for
											)}
										</span>
									{/if}
									{#if attendance.outcome_event_type}
										<span
											class={`rounded-full px-3 py-1 text-xs font-bold ring-1 ${
												attendance.outcome_event_type === 'SALE'
													? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
													: 'bg-red-50 text-red-800 ring-red-200'
											}`}
										>
											{attendance.outcome_event_type === 'SALE'
												? 'Venda registrada'
												: 'Perda registrada'}
										</span>
										<button
											type="button"
											class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-60"
											onclick={() => void closeAttendance(attendance)}
											disabled={closingAttendanceId === attendance.id}
										>
											{closingAttendanceId === attendance.id ? 'Fechando...' : 'Fechar atendimento'}
										</button>
									{/if}
									<button
										type="button"
										class="rounded-xl bg-sky-600 px-4 py-2 text-sm font-bold text-white hover:bg-sky-700"
										onclick={() => (modalAttendance = attendance)}
									>
										Registrar evento
									</button>
								</div>
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
											onchange={() => handleProfessorChange(attendance)}
											disabled={editingBusy}
											{@attach autofocus}
										>
											<option value="">Recepção (sem professor)</option>
											{#each professorsForAcademy(attendance.academy_id) as professor (professor.id)}
												<option value={professor.id}>{professor.name}</option>
											{/each}
											<option value={NEW_PROFESSOR}>+ Cadastrar novo professor</option>
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
									<div
										class="inline-flex rounded-full bg-slate-100 p-0.5 text-xs font-bold text-slate-600 ring-1 ring-slate-200"
										aria-label={`Canal do atendimento de ${attendance.lead_name}`}
									>
										{#each ['PRESENCIAL', 'ONLINE'] as channel (channel)}
											<button
												type="button"
												class={`rounded-full px-2 py-1 transition ${
													attendance.channel === channel
														? 'bg-white text-sky-800 shadow-sm'
														: 'hover:bg-white/70'
												}`}
												onclick={() =>
													void updateAttendanceChannel(attendance, channel as AttendanceChannel)}
												disabled={channelBusyId === attendance.id || attendance.channel === channel}
												aria-pressed={attendance.channel === channel}
											>
												{channelLabel(channel)}
											</button>
										{/each}
									</div>
								</div>
							{/if}

							<LeadEventsTimeline
								leadId={attendance.lead_id}
								count={attendance.lead_events_count}
								label="Eventos do lead"
							/>
						</article>
					{/each}
				</div>
			{:else}
				<Empty text="Nenhum atendimento visível para esta visão." />
			{/if}
		</section>
	</div>
</section>

<EventFormModal
	attendance={modalAttendance}
	{outcomeTypes}
	{lossReasons}
	onClose={() => (modalAttendance = null)}
	onSaved={loadQueue}
	onPlansSynced={reloadOutcomeTypes}
/>

<ProfessorFormModal
	academyId={professorModalAttendance?.academy_id ?? null}
	academyName={professorModalAttendance ? academyName(professorModalAttendance.academy_id) : null}
	onClose={() => (professorModalAttendance = null)}
	onCreated={handleProfessorCreated}
/>

<LeadMergeModal
	attendance={mergeAttendance}
	existingLead={mergeExistingLead}
	draftLead={mergeDraftLead}
	onClose={closeMergeModal}
	onMerged={handleLeadMerged}
/>
