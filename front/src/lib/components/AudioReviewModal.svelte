<script lang="ts">
	import { api, dateTime } from '$lib/api/client';
	import { errorMessage, eventTypeLabel } from '$lib/helpers';
	import type {
		AttendanceAudioPart,
		AudioPart,
		AudioTimelineEvent,
		LeadEvent
	} from '$lib/types';

	type AudioReviewResponse = {
		parts: AttendanceAudioPart[];
		events: AudioTimelineEvent[];
	};

	let {
		event,
		onClose
	}: {
		event: LeadEvent | null;
		onClose: () => void;
	} = $props();

	const PART_ORDER: Record<AudioPart, number> = { FULL: 0, HEAD: 1, TAIL: 2 };

	let audioPromise = $derived(event ? fetchAudioReview(event.attendance_id) : null);

	async function fetchAudioReview(attendanceId: string) {
		return await api<AudioReviewResponse>(`/api/attendances/${attendanceId}/audio`);
	}

	function orderedParts(parts: AttendanceAudioPart[]) {
		return [...parts].sort((left, right) => PART_ORDER[left.part] - PART_ORDER[right.part]);
	}

	function partLabel(part: AudioPart) {
		const labels: Record<AudioPart, string> = {
			FULL: 'Atendimento completo',
			HEAD: 'Início do atendimento',
			TAIL: 'Fechamento'
		};
		return labels[part];
	}

	function roleLabel(role: string) {
		if (role === 'lead') return 'Lead';
		if (role === 'receptionist') return 'Recepção';
		if (role === 'professor') return 'Professor';
		return role;
	}

	function participantsLabel(part: AttendanceAudioPart) {
		if (!part.participants.length) return 'Participantes não informados';
		return part.participants
			.map((participant) =>
				participant.name ? `${roleLabel(participant.role)}: ${participant.name}` : roleLabel(participant.role)
			)
			.join(' · ');
	}

	function formatSeconds(seconds: number) {
		if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
		const minutes = Math.floor(seconds / 60);
		const rest = Math.round(seconds % 60);
		if (minutes <= 0) return `${rest}s`;
		return `${minutes}min ${rest}s`;
	}

	function headTailGap(parts: AttendanceAudioPart[]) {
		const head = parts.find((part) => part.part === 'HEAD' && part.status === 'UPLOADED');
		const tail = parts.find((part) => part.part === 'TAIL' && part.status === 'UPLOADED');
		if (!head || !tail) return 0;
		const seconds = (Date.parse(tail.windowStart) - Date.parse(head.windowEnd)) / 1_000;
		return Number.isFinite(seconds) && seconds > 1 ? seconds : 0;
	}

	function handleClose() {
		onClose();
	}
</script>

<dialog
	class="fixed inset-0 z-50 m-auto w-[min(42rem,calc(100vw-2rem))] rounded-3xl border border-slate-200 bg-white p-0 shadow-2xl backdrop:bg-slate-950/40"
	open={event !== null}
	onclose={handleClose}
	onclick={(dialogEvent) => {
		if (dialogEvent.target === dialogEvent.currentTarget) handleClose();
	}}
>
	{#if event}
		<div class="max-h-[calc(100vh-2rem)] overflow-y-auto p-5">
			<div class="flex items-start justify-between gap-4">
				<div>
					<h3 class="text-xl font-bold text-slate-950">Revisar áudio</h3>
					<p class="text-sm text-slate-600">
						{eventTypeLabel(event.type)} · {dateTime(event.created_at)}
					</p>
					{#if event.academy_name}
						<p class="mt-1 text-xs font-semibold text-slate-500">{event.academy_name}</p>
					{/if}
				</div>
				<button
					type="button"
					class="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
					onclick={handleClose}
					aria-label="Fechar modal"
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

			{#if audioPromise}
				{#await audioPromise}
					<p
						class="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600"
					>
						Carregando áudios do atendimento...
					</p>
				{:then data}
					<div class="mt-5 grid gap-4">
						{#if data.parts.length}
							{@const sortedParts = orderedParts(data.parts)}
							{@const middleGap = headTailGap(sortedParts)}
							{#if middleGap}
								<p
									class="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900"
								>
									Há um intervalo sem áudio de {formatSeconds(middleGap)} entre o início e o
									fechamento.
								</p>
							{/if}
							{#each sortedParts as part (part.id)}
								<section class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
									<div class="flex flex-wrap items-start justify-between gap-2">
										<div>
											<h4 class="font-bold text-slate-900">{partLabel(part.part)}</h4>
											<p class="text-xs text-slate-500">
												{dateTime(part.windowStart)} até {dateTime(part.windowEnd)}
											</p>
										</div>
										<span
											class={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
												part.status === 'UPLOADED'
													? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
													: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'
											}`}
										>
											{part.status === 'UPLOADED' ? 'Disponível' : 'Pendente'}
										</span>
									</div>

									{#if part.status === 'UPLOADED' && part.downloadUrl}
										<audio class="mt-3 w-full" controls preload="metadata" src={part.downloadUrl}></audio>
									{:else}
										<p class="mt-3 text-sm text-slate-600">
											Este trecho ainda não foi enviado por nenhum computador da recepção.
										</p>
									{/if}

									<div class="mt-3 grid gap-1 text-xs text-slate-500">
										<p>{participantsLabel(part)}</p>
										<p>
											Dispositivo:
											<span class="font-semibold text-slate-700">
												{part.deviceLabel || part.deviceId || 'não informado'}
											</span>
										</p>
										<p>Cobertura: {formatSeconds(part.coveredSeconds)}</p>
										{#if part.gaps.length}
											<p>
												Falhas:
												{part.gaps
													.map((gap) => `${dateTime(gap.start)} (${formatSeconds(gap.seconds)})`)
													.join(' · ')}
											</p>
										{/if}
									</div>
								</section>
							{/each}
						{:else}
							<p
								class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600"
							>
								Nenhum trecho de áudio encontrado para este atendimento.
							</p>
						{/if}

						<section class="rounded-2xl border border-slate-200 p-4">
							<h4 class="font-bold text-slate-900">Linha do tempo</h4>
							{#if data.events.length}
								<ol class="mt-3 space-y-3">
									{#each data.events as timelineEvent (timelineEvent.id)}
										<li>
											<p class="text-sm font-semibold text-slate-800">
												{eventTypeLabel(timelineEvent.type)}
											</p>
											<p class="text-xs text-slate-500">
												{dateTime(timelineEvent.createdAt)} · {timelineEvent.actorName}
											</p>
											{#if timelineEvent.description}
												<p class="mt-1 text-xs text-slate-600">{timelineEvent.description}</p>
											{/if}
										</li>
									{/each}
								</ol>
							{:else}
								<p class="mt-2 text-sm text-slate-500">Sem eventos para exibir.</p>
							{/if}
						</section>
					</div>
				{:catch error}
					<p class="mt-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
						{errorMessage(error, 'Não foi possível carregar os áudios.')}
					</p>
				{/await}
			{/if}

			<div class="mt-5 flex justify-end">
				<button
					type="button"
					class="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 hover:bg-slate-50"
					onclick={handleClose}
				>
					Fechar
				</button>
			</div>
		</div>
	{/if}
</dialog>
