<script lang="ts">
	import { browser } from '$app/environment';
	import { api, dateTime, money } from '$lib/api/client';
	import { evoApi, evoAvailable } from '$lib/api/evo';
	import {
		describeError,
		evoError,
		evoLog,
		evoWarn,
		openEvoDiagnostics
	} from '$lib/api/evo-log.svelte';
	import { asCents, errorMessage, eventTypeLabel } from '$lib/helpers';
	import type {
		Attendance,
		AttendanceEventType,
		EvoCredentialsStatus,
		EvoJobStatus,
		LossReason,
		OutcomeType
	} from '$lib/types';

	type EventTypeOption = {
		value: AttendanceEventType;
		label: string;
	};

	let {
		attendance,
		outcomeTypes,
		lossReasons,
		onClose,
		onSaved,
		onPlansSynced
	}: {
		attendance: Attendance | null;
		outcomeTypes: OutcomeType[];
		lossReasons: LossReason[];
		onClose: () => void;
		onSaved: () => Promise<void> | void;
		onPlansSynced?: () => Promise<void> | void;
	} = $props();

	const baseEventTypes: EventTypeOption[] = [
		{ value: 'SALE', label: 'Venda' },
		{ value: 'LOSS', label: 'Perda' },
		{ value: 'EXPERIMENTAL_CLASS_SCHEDULED', label: 'Aula experimental agendada' },
		{ value: 'EXPERIMENTAL_CLASS_NOW', label: 'Aula experimental agora' },
		{ value: 'FOLLOW_UP_SCHEDULED', label: 'Follow-up agendado' },
		{ value: 'NOTE', label: 'Nota' },
		{ value: 'OTHER', label: 'Outro evento' },
		{ value: 'REOPEN', label: 'Reabrir atendimento' }
	];

	const VISIT_TYPES: readonly string[] = ['Pessoal', 'E-mail', 'Telefone', 'Outro', 'Convite'];

	const HOW_FOUND_US: readonly string[] = [
		'Convite',
		'Veio até academia',
		'Whatsapp',
		'TOTEM/SITE',
		'Gympass',
		'Totalpass',
		'Indicação'
	];

	let busy = $state(false);
	let message = $state('');
	let messageKind = $state<'info' | 'warning' | 'error'>('info');
	let eventForm = $state(createForm());
	let evoBridgeAvailable = $state(false);
	let evoLoading = $state(false);
	let plansSyncBusy = $state(false);
	let evoCredentials = $state<EvoCredentialsStatus | null>(null);
	let sendToEvo = $state(true);
	let evoRetryAttendanceId = $state<string | null>(null);
	let evoCredentialsForm = $state(createCredentialsForm());
	let evoForm = $state(createEvoForm());
	let initializedAttendanceId = $state<string | null>(null);
	let activeOutcomeTypes = $derived(outcomeTypes.filter((outcome) => outcome.active));
	let activeLossReasons = $derived(lossReasons.filter((reason) => reason.active));
	let selectedOutcome = $derived(
		outcomeTypes.find((outcome) => outcome.id === eventForm.outcomeTypeId)
	);
	let evoCredentialsConfigured = $derived(evoCredentials?.configured === true);
	let shouldUseEvo = $derived(eventForm.type === 'SALE' && sendToEvo && evoBridgeAvailable);
	let messageClass = $derived(
		messageKind === 'error'
			? 'border-red-200 bg-red-50 text-red-800'
			: messageKind === 'warning'
				? 'border-amber-200 bg-amber-50 text-amber-900'
				: 'border-sky-200 bg-sky-50 text-sky-900'
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
			type: 'SALE' as AttendanceEventType,
			outcomeTypeId: '',
			manualLabel: '',
			manualValue: '',
			lossReasonId: '',
			scheduledFor: '',
			description: ''
		};
	}

	function createCredentialsForm() {
		return { username: '', password: '' };
	}

	function createEvoForm(currentAttendance: Attendance | null = null) {
		return {
			surname: currentAttendance?.lead_surname ?? '',
			cpf: currentAttendance?.lead_cpf ?? '',
			birthDate: currentAttendance?.lead_birth_date?.slice(0, 10) ?? '',
			gender: currentAttendance?.lead_gender ?? '',
			cep: currentAttendance?.lead_cep ?? '',
			visitType: currentAttendance?.lead_visit_type ?? 'Pessoal',
			howFoundUs: currentAttendance?.lead_how_found_us ?? 'Veio até academia'
		};
	}

	/** Campo em branco vira null: o EVO simplesmente não preenche o que faltar. */
	function opcional(valor: string) {
		return valor.trim() || null;
	}

	function isScheduledEvent(type: AttendanceEventType) {
		return type === 'EXPERIMENTAL_CLASS_SCHEDULED' || type === 'FOLLOW_UP_SCHEDULED';
	}

	function handleClose() {
		if (busy) return;
		eventForm = createForm();
		message = '';
		messageKind = 'info';
		onClose();
	}

	async function loadEvoState(attendanceId: string) {
		evoLoading = true;
		evoLog(`Modal de evento aberto para o atendimento ${attendanceId}: checando o EVO.`);
		try {
			const available = await evoAvailable();
			if (attendance?.id !== attendanceId) return;
			evoBridgeAvailable = available;
			if (!available) {
				evoCredentials = null;
				return;
			}
			const credentials = await api<EvoCredentialsStatus>('/api/evo/credentials');
			if (attendance?.id !== attendanceId) return;
			evoCredentials = credentials;
			evoCredentialsForm.username = credentials.username ?? '';
			evoLog('Modal de evento: EVO disponível para esta venda.', {
				credenciaisConfiguradas: credentials.configured
			});
		} catch (error) {
			if (attendance?.id !== attendanceId) return;
			evoBridgeAvailable = false;
			evoCredentials = null;
			evoError('Modal de evento: não consegui ler as credenciais EVO na API do tracker.', {
				erro: describeError(error)
			});
		} finally {
			if (attendance?.id === attendanceId) evoLoading = false;
		}
	}

	async function saveEvoLeadFields(currentAttendance: Attendance) {
		await api<{ lead: unknown }>(`/api/leads/${currentAttendance.lead_id}`, {
			method: 'PATCH',
			body: JSON.stringify({
				surname: opcional(evoForm.surname),
				cpf: opcional(evoForm.cpf),
				birthDate: opcional(evoForm.birthDate),
				gender: opcional(evoForm.gender),
				cep: opcional(evoForm.cep),
				visitType: opcional(evoForm.visitType),
				howFoundUs: opcional(evoForm.howFoundUs)
			})
		});
	}

	async function ensureEvoCredentials() {
		if (evoCredentialsConfigured) return;
		const credentials = await api<EvoCredentialsStatus>('/api/evo/credentials', {
			method: 'PUT',
			body: JSON.stringify(evoCredentialsForm)
		});
		evoCredentials = credentials;
		evoCredentialsForm.password = '';
	}

	function delay(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function pollEvoJob(jobId: string) {
		const deadline = Date.now() + 600_000;
		let lastLogged = '';
		while (Date.now() < deadline) {
			const { job } = await evoApi<{ job: EvoJobStatus }>(`/evo/status/${jobId}`);
			messageKind = 'info';
			message = job.message || 'EVO em execução...';

			// Only the transitions matter; the poll itself runs once per second.
			const snapshot = `${job.status}|${job.message ?? ''}`;
			if (snapshot !== lastLogged) {
				lastLogged = snapshot;
				evoLog(`Job ${jobId}: ${job.status}${job.message ? ` - ${job.message}` : ''}`);
			}

			if (job.status === 'completed' || job.status === 'failed') return job;
			await delay(1000);
		}
		evoError(`Job ${jobId} passou de 10 minutos sem terminar. Desistindo de acompanhar.`);
		throw new Error('Tempo limite ao preencher o cadastro no EVO.');
	}

	async function submitEvoSale(attendanceId: string) {
		messageKind = 'info';
		message = 'Enviando venda para o EVO...';
		evoLog(`Iniciando o envio da venda do atendimento ${attendanceId} para o EVO.`);

		const { ticket } = await api<{ ticket: string; expiresAt: string }>(
			`/api/evo/attendances/${attendanceId}/ticket`,
			{ method: 'POST' }
		);
		const { jobId } = await evoApi<{ jobId: string }>('/evo/venda', {
			method: 'POST',
			body: JSON.stringify({ attendanceId, ticket })
		});
		evoLog(`Bridge aceitou a venda e criou o job ${jobId}.`);

		const job = await pollEvoJob(jobId);
		if (job.status === 'failed') {
			evoError(`Job ${jobId} terminou com falha: o bridge não conseguiu preencher o EVO.`, {
				mensagem: job.message ?? null,
				erro: job.error ?? null
			});
			throw new Error(job.error || job.message || 'Falha ao preencher o cadastro no EVO.');
		}

		evoLog(`Job ${jobId} concluído: formulário do EVO preenchido.`);
		messageKind = 'info';
		message = 'Venda registrada. Formulário EVO preenchido; revise e salve manualmente.';
	}

	async function syncPlansFromEvo() {
		if (plansSyncBusy) return;
		if (!attendance) return;
		if (!evoBridgeAvailable) {
			messageKind = 'warning';
			message = 'Bridge EVO indisponível. Abra o app Skyfit EVO para atualizar os planos.';
			return;
		}
		if (!evoCredentialsConfigured) {
			messageKind = 'warning';
			message = 'Configure suas credenciais EVO em Conta antes de atualizar os planos.';
			return;
		}

		const currentAttendance = attendance;
		plansSyncBusy = true;
		messageKind = 'info';
		message = 'Buscando planos no EVO...';
		evoLog(`Iniciando sincronização de planos EVO da academia ${currentAttendance.academy_id}.`);
		try {
			const { ticket } = await api<{ ticket: string; expiresAt: string }>('/api/evo/plans/ticket', {
				method: 'POST',
				body: JSON.stringify({ academyId: currentAttendance.academy_id })
			});
			const { jobId } = await evoApi<{ jobId: string }>('/evo/planos', {
				method: 'POST',
				body: JSON.stringify({ ticket })
			});
			evoLog(`Bridge aceitou a sincronização de planos e criou o job ${jobId}.`);

			const job = await pollEvoJob(jobId);
			if (job.status === 'failed') {
				evoError(`Job ${jobId} terminou com falha: o bridge não conseguiu ler os planos do EVO.`, {
					mensagem: job.message ?? null,
					erro: job.error ?? null
				});
				throw new Error(job.error || job.message || 'Falha ao buscar os planos no EVO.');
			}

			const plans = job.plans ?? [];
			if (!plans.length) {
				throw new Error('O EVO não retornou planos para sincronizar.');
			}

			message = 'Sincronizando planos no tracker...';
			const { created, skipped } = await api<{
				created: OutcomeType[];
				skipped: OutcomeType[];
				outcomeTypes: OutcomeType[];
			}>('/api/admin/outcome-types/sync', {
				method: 'POST',
				body: JSON.stringify({
					plans: plans.map(({ nome, valorCents }) => ({ label: nome, valueCents: valorCents }))
				})
			});
			await onPlansSynced?.();

			const createdCount = created.length;
			const skippedCount = skipped.length;
			messageKind = 'info';
			message = `Planos atualizados: ${createdCount} novo${createdCount === 1 ? '' : 's'} e ${skippedCount} já existente${skippedCount === 1 ? '' : 's'}.`;
			evoLog(`Sincronização de planos EVO concluída pelo job ${jobId}.`, {
				planosLidos: plans.length,
				criados: createdCount,
				ignorados: skippedCount
			});
		} catch (error) {
			messageKind = 'error';
			message = `Não foi possível atualizar os planos do EVO: ${errorMessage(error)}`;
			evoError('Sincronização de planos EVO falhou.', { erro: describeError(error) });
		} finally {
			plansSyncBusy = false;
		}
	}

	async function retryEvoSale() {
		if (!evoRetryAttendanceId || busy) return;
		busy = true;
		evoLog(`Nova tentativa manual de enviar o atendimento ${evoRetryAttendanceId} para o EVO.`);
		try {
			await submitEvoSale(evoRetryAttendanceId);
			evoRetryAttendanceId = null;
		} catch (error) {
			messageKind = 'warning';
			message = `Venda registrada, mas o EVO precisa de atenção: ${errorMessage(error)}`;
			evoWarn('A nova tentativa também falhou.', { erro: describeError(error) });
		} finally {
			busy = false;
		}
	}

	async function submitAttendanceEvent(event: SubmitEvent) {
		event.preventDefault();
		if (!attendance) return;
		const currentAttendance = attendance;

		busy = true;
		message = '';
		messageKind = 'info';
		evoRetryAttendanceId = null;
		const useEvoForSale = eventForm.type === 'SALE' && shouldUseEvo;
		try {
			let payload: Record<string, unknown> = { type: eventForm.type };
			if (eventForm.type === 'SALE') {
				if (useEvoForSale) {
					message = 'Salvando dados para o EVO...';
					await saveEvoLeadFields(currentAttendance);
					if (!evoCredentialsConfigured) {
						message = 'Salvando credenciais do EVO...';
						await ensureEvoCredentials();
					}
				}
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

			await api<{ event: { id: string } }>(`/api/attendances/${currentAttendance.id}/events`, {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			eventForm = createForm();
			await onSaved();
			if (!useEvoForSale) {
				message = '';
				onClose();
				return;
			}
			try {
				await submitEvoSale(currentAttendance.id);
			} catch (error) {
				messageKind = 'warning';
				message = `Venda registrada, mas o EVO precisa de atenção: ${errorMessage(error)}`;
				evoRetryAttendanceId = currentAttendance.id;
				evoWarn('Venda salva no tracker, mas o envio para o EVO falhou.', {
					atendimento: currentAttendance.id,
					erro: describeError(error)
				});
			}
		} catch (error) {
			messageKind = 'error';
			message = errorMessage(error);
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		const currentId = attendance?.id ?? null;
		if (!currentId) {
			initializedAttendanceId = null;
			evoBridgeAvailable = false;
			evoLoading = false;
			evoCredentials = null;
			evoCredentialsForm = createCredentialsForm();
			evoForm = createEvoForm();
			sendToEvo = true;
			evoRetryAttendanceId = null;
			return;
		}
		if (currentId === initializedAttendanceId) return;
		initializedAttendanceId = currentId;
		eventForm = createForm();
		message = '';
		messageKind = 'info';
		evoBridgeAvailable = false;
		evoLoading = false;
		evoCredentials = null;
		evoCredentialsForm = createCredentialsForm();
		evoForm = createEvoForm(attendance);
		sendToEvo = true;
		evoRetryAttendanceId = null;
		void loadEvoState(currentId);
	});
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
							{eventTypeLabel(attendance.next_event_type)} em {dateTime(
								attendance.next_scheduled_for
							)}
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
					{#if evoBridgeAvailable}
						<div>
							<button
								type="button"
								class="rounded-2xl border border-sky-200 px-4 py-2 text-sm font-bold text-sky-700 hover:bg-sky-50 disabled:opacity-60"
								onclick={() => void syncPlansFromEvo()}
								disabled={plansSyncBusy || evoLoading || busy}
							>
								{plansSyncBusy ? 'Atualizando planos...' : 'Atualizar planos do EVO'}
							</button>
						</div>
					{/if}
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

					{#if evoLoading}
						<p
							class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600"
						>
							Verificando integração EVO...
						</p>
					{:else if evoBridgeAvailable}
						<label
							class="flex items-center gap-2 rounded-2xl border border-sky-100 bg-sky-50 px-4 py-3 text-sm font-semibold text-sky-900"
						>
							<input
								class="rounded border-slate-300"
								type="checkbox"
								bind:checked={sendToEvo}
								disabled={busy}
							/>
							Cadastrar no EVO
						</label>

						{#if sendToEvo}
							<div class="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
								<div>
									<h4 class="font-bold text-slate-950">Dados para o EVO</h4>
									<p class="text-sm text-slate-600">
										{#if evoCredentialsConfigured}
											Credenciais salvas para {evoCredentials?.username}.
										{:else}
											Informe usuário e senha EVO para esta venda.
										{/if}
									</p>
									<p class="text-sm text-slate-600">
										Campos em branco ficam vazios no formulário do EVO.
									</p>
								</div>

								<div class="grid gap-4 sm:grid-cols-2">
									<label class="text-sm font-medium text-slate-700"
										>Sobrenome<input
											class="mt-1 w-full rounded-2xl border-slate-300"
											bind:value={evoForm.surname}
											disabled={busy}
										/></label
									>
									<label class="text-sm font-medium text-slate-700"
										>CPF<input
											class="mt-1 w-full rounded-2xl border-slate-300"
											inputmode="numeric"
											bind:value={evoForm.cpf}
											disabled={busy}
										/></label
									>
									<label class="text-sm font-medium text-slate-700"
										>Data de nascimento<input
											class="mt-1 w-full rounded-2xl border-slate-300"
											type="date"
											bind:value={evoForm.birthDate}
											disabled={busy}
										/></label
									>
									<label class="text-sm font-medium text-slate-700">
										Gênero
										<select
											class="mt-1 w-full rounded-2xl border-slate-300"
											bind:value={evoForm.gender}
											disabled={busy}
										>
											<option value="">Não informar</option>
											<option value="Masculino">Masculino</option>
											<option value="Feminino">Feminino</option>
											<option value="Outro">Outro</option>
										</select>
									</label>
									<label class="text-sm font-medium text-slate-700"
										>CEP<input
											class="mt-1 w-full rounded-2xl border-slate-300"
											inputmode="numeric"
											bind:value={evoForm.cep}
											disabled={busy}
										/></label
									>
									<label class="text-sm font-medium text-slate-700">
										Tipo de visita
										<select
											class="mt-1 w-full rounded-2xl border-slate-300"
											bind:value={evoForm.visitType}
											disabled={busy}
										>
											<option value="">Não informar</option>
											{#each VISIT_TYPES as option (option)}
												<option value={option}>{option}</option>
											{/each}
										</select>
									</label>
									<label class="text-sm font-medium text-slate-700 sm:col-span-2">
										Como conheceu
										<select
											class="mt-1 w-full rounded-2xl border-slate-300"
											bind:value={evoForm.howFoundUs}
											disabled={busy}
										>
											<option value="">Não informar</option>
											{#each HOW_FOUND_US as option (option)}
												<option value={option}>{option}</option>
											{/each}
										</select>
									</label>
								</div>

								{#if !evoCredentialsConfigured}
									<div class="grid gap-4 border-t border-slate-200 pt-4 sm:grid-cols-2">
										<label class="text-sm font-medium text-slate-700"
											>Usuário EVO<input
												class="mt-1 w-full rounded-2xl border-slate-300"
												bind:value={evoCredentialsForm.username}
												disabled={busy}
												required={shouldUseEvo}
											/></label
										>
										<label class="text-sm font-medium text-slate-700"
											>Senha EVO<input
												class="mt-1 w-full rounded-2xl border-slate-300"
												type="password"
												bind:value={evoCredentialsForm.password}
												disabled={busy}
												required={shouldUseEvo}
											/></label
										>
									</div>
								{/if}
							</div>
						{/if}
					{:else}
						<div
							class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600"
						>
							<p>Integração EVO indisponível. A venda será registrada apenas no tracker.</p>
							<button
								type="button"
								class="mt-2 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-white"
								onclick={openEvoDiagnostics}
							>
								Ver diagnóstico
							</button>
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
						required={eventForm.type === 'OTHER' || eventForm.type === 'NOTE'}></textarea>
				</label>

				{#if message}
					<p class={`rounded-2xl border px-4 py-3 text-sm font-medium ${messageClass}`}>
						{message}
					</p>
				{/if}

				{#if evoRetryAttendanceId}
					<div class="flex justify-end">
						<button
							type="button"
							class="rounded-2xl bg-amber-600 px-5 py-3 font-bold text-white hover:bg-amber-700 disabled:opacity-60"
							onclick={retryEvoSale}
							disabled={busy}
						>
							Tentar preencher o EVO novamente
						</button>
					</div>
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
