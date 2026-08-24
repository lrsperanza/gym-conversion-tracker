<script lang="ts">
	import { tick } from 'svelte';
	import { dateTime } from '$lib/api/client';
	import { createClip, clipStreamUrl, getClipJob, listClipCameras } from '$lib/api/clips';
	import { errorMessage } from '$lib/helpers';
	import type { AcademyCamera, ClipJob, LeadEvent } from '$lib/types';

	let {
		event,
		onClose
	}: {
		event: LeadEvent | null;
		onClose: () => void;
	} = $props();

	const POLL_INTERVAL_MS = 5_000;
	const DEFAULT_RATE = 8;
	const PLAYBACK_RATES = [1, 2, 4, 8] as const;
	const clockFormatter = new Intl.DateTimeFormat('pt-BR', {
		timeZone: 'America/Sao_Paulo',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});

	type PlaybackRate = (typeof PLAYBACK_RATES)[number];

	let selectedCameraId = $state('');
	let startValue = $derived(event ? datetimeLocalValue(event.created_at, -5) : '');
	let endValue = $derived(event ? datetimeLocalValue(event.created_at, 2) : '');
	let submitting = $state(false);
	let message = $state('');
	let messageKind = $state<'info' | 'warning' | 'error'>('info');
	let job = $state<ClipJob | null>(null);
	let videoUrl = $state<string | null>(null);
	let videoElement = $state<HTMLVideoElement | null>(null);
	let baseOffsetSeconds = $state(0);
	let currentOffsetSeconds = $state(0);
	let bufferedOffsetSeconds = $state(0);
	let selectedRate = $state<PlaybackRate>(DEFAULT_RATE);
	let isBuffering = $state(false);
	let isPlaying = $state(false);
	let isMuted = $state(true);
	let isSeeking = $state(false);

	let pollToken = 0;
	let streamToken = 0;

	let camerasPromise = $derived(event ? listClipCameras(event.academy_id) : null);
	let canSubmit = $derived(Boolean(event && startValue && endValue && !submitting));
	let clipDurationSeconds = $derived(job ? Math.max(0, job.durationSeconds) : 0);
	let generatedProgressPercent = $derived(
		job && job.durationSeconds > 0
			? `${Math.max(0, Math.min(100, (job.positionSeconds / job.durationSeconds) * 100))}%`
			: '0%'
	);
	let generatedProgressLabel = $derived(
		job && job.durationSeconds > 0
			? `${Math.max(0, Math.min(100, Math.round((job.positionSeconds / job.durationSeconds) * 100)))}%`
			: ''
	);
	let currentPercent = $derived(offsetPercent(currentOffsetSeconds));
	let bufferedPercent = $derived(offsetPercent(bufferedOffsetSeconds));
	let messageClass = $derived(
		messageKind === 'error'
			? 'border-red-200 bg-red-50 text-red-800'
			: messageKind === 'warning'
				? 'border-amber-200 bg-amber-50 text-amber-900'
				: 'border-sky-200 bg-sky-50 text-sky-900'
	);
	let canUsePlayer = $derived(Boolean(job && videoUrl && clipDurationSeconds > 0));
	let currentClockLabel = $derived(formatClockTime(currentOffsetSeconds));
	let bufferedClockLabel = $derived(formatClockTime(bufferedOffsetSeconds));
	let startClockLabel = $derived(formatClockTime(0));
	let endClockLabel = $derived(formatClockTime(clipDurationSeconds));
	let playerNote = $derived.by(() => {
		if (!job) return '';
		if (job.status === 'pulling' && job.actualRate) return `DVR em ${job.actualRate}x`;
		if (job.actualRate && job.actualRate !== selectedRate) return `DVR em ${job.actualRate}x`;
		return '';
	});

	function delay(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function datetimeLocalValue(iso: string, offsetMinutes = 0) {
		const timestamp = Date.parse(iso);
		if (!Number.isFinite(timestamp)) return '';
		const targetTimestamp = timestamp + offsetMinutes * 60_000;
		const local = new Date(
			targetTimestamp - new Date(targetTimestamp).getTimezoneOffset() * 60_000
		);
		return local.toISOString().slice(0, 16);
	}

	function datetimeLocalToIso(value: string) {
		return new Date(value).toISOString();
	}

	function intervalDurationMinutes() {
		const startMs = new Date(startValue).getTime();
		const endMs = new Date(endValue).getTime();
		if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
		return (endMs - startMs) / 60_000;
	}

	function defaultCameraId(cameras: AcademyCamera[]) {
		return cameras.find((camera) => camera.isDefault)?.id ?? cameras[0]?.id ?? '';
	}

	function effectiveCameraId(cameras: AcademyCamera[]) {
		return selectedCameraId || defaultCameraId(cameras);
	}

	function resetTransientState() {
		selectedCameraId = '';
		submitting = false;
		message = '';
		messageKind = 'info';
		job = null;
		videoUrl = null;
		videoElement = null;
		baseOffsetSeconds = 0;
		currentOffsetSeconds = 0;
		bufferedOffsetSeconds = 0;
		selectedRate = DEFAULT_RATE;
		isBuffering = false;
		isPlaying = false;
		isMuted = true;
		isSeeking = false;
	}

	function validateInterval(maxDurationMinutes: number) {
		const duration = intervalDurationMinutes();
		if (duration === null) return 'Informe datas válidas para início e fim.';
		if (duration <= 0) return 'O fim do recorte precisa ser depois do início.';
		if (maxDurationMinutes > 0 && duration > maxDurationMinutes) {
			return `O intervalo selecionado tem ${Math.ceil(duration)} minutos. O limite desta academia é de ${maxDurationMinutes} minutos.`;
		}
		return '';
	}

	function clampOffset(value: number) {
		if (!Number.isFinite(value)) return 0;
		return Math.max(0, Math.min(clipDurationSeconds, value));
	}

	function offsetPercent(value: number) {
		if (clipDurationSeconds <= 0) return '0%';
		return `${(clampOffset(value) / clipDurationSeconds) * 100}%`;
	}

	function formatClockTime(offsetSeconds: number) {
		if (!job) return '--:--:--';
		const startTimestamp = Date.parse(job.start);
		if (!Number.isFinite(startTimestamp)) return '--:--:--';
		return clockFormatter.format(new Date(startTimestamp + clampOffset(offsetSeconds) * 1_000));
	}

	function statusLabel(status: ClipJob['status']) {
		if (status === 'failed') return 'Falhou';
		if (status === 'pulling') return 'Gerando trecho';
		return 'Pronto';
	}

	function defaultJobMessage(currentJob: ClipJob) {
		if (currentJob.status === 'failed') return currentJob.error || 'Falha ao preparar o vídeo.';
		if (currentJob.status === 'pulling') return 'DVR gerando o trecho solicitado...';
		return 'Linha do tempo pronta para navegar.';
	}

	function currentVideoOffset() {
		if (!videoElement) return currentOffsetSeconds;
		return clampOffset(baseOffsetSeconds + videoElement.currentTime);
	}

	function updateTimelineFromVideo() {
		if (!videoElement) return;
		if (!isSeeking) currentOffsetSeconds = currentVideoOffset();
		if (videoElement.buffered.length > 0) {
			const lastRange = videoElement.buffered.length - 1;
			bufferedOffsetSeconds = clampOffset(baseOffsetSeconds + videoElement.buffered.end(lastRange));
		}
	}

	function applyVideoSettings() {
		if (!videoElement) return;
		videoElement.defaultPlaybackRate = selectedRate;
		videoElement.playbackRate = selectedRate;
		videoElement.muted = isMuted;
	}

	function captureVideoElement(element: HTMLVideoElement) {
		videoElement = element;
		void tick().then(() => {
			if (videoElement === element) applyVideoSettings();
		});

		return () => {
			if (videoElement === element) videoElement = null;
		};
	}

	async function tryPlayVideo() {
		if (!videoElement) return;
		try {
			await videoElement.play();
		} catch {
			isPlaying = false;
		}
	}

	function handleVideoReady() {
		applyVideoSettings();
		updateTimelineFromVideo();
	}

	function handleCanPlay() {
		isBuffering = false;
		applyVideoSettings();
	}

	function handlePlaying() {
		isPlaying = true;
		isBuffering = false;
	}

	function handlePause() {
		isPlaying = false;
		isBuffering = false;
	}

	function handleWaiting() {
		isBuffering = true;
	}

	function handleVolumeChange() {
		if (!videoElement) return;
		isMuted = videoElement.muted;
	}

	async function togglePlay() {
		if (!videoElement) return;
		if (videoElement.paused) {
			isBuffering = true;
			await tryPlayVideo();
		} else {
			videoElement.pause();
		}
	}

	function toggleMute() {
		isMuted = !isMuted;
		if (videoElement) videoElement.muted = isMuted;
	}

	async function loadStreamFromOffset(targetOffset: number, rate: PlaybackRate, token: number) {
		if (!job || token !== pollToken) return false;
		const requestToken = ++streamToken;
		const safeOffset = clampOffset(targetOffset);
		baseOffsetSeconds = safeOffset;
		currentOffsetSeconds = safeOffset;
		bufferedOffsetSeconds = safeOffset;
		isBuffering = true;
		isSeeking = false;
		videoUrl = null;

		try {
			const nextUrl = await clipStreamUrl(job.id, safeOffset, rate);
			if (token !== pollToken || requestToken !== streamToken) return false;
			videoUrl = nextUrl;
			await tick();
			if (token !== pollToken || requestToken !== streamToken) return false;
			applyVideoSettings();
			await tryPlayVideo();
			return true;
		} catch (error) {
			if (token !== pollToken || requestToken !== streamToken) return false;
			isBuffering = false;
			messageKind = 'error';
			message = errorMessage(error, 'Não foi possível carregar o ponto selecionado.');
			return false;
		}
	}

	async function seekToOffset(targetOffset: number) {
		if (!job) return;
		const token = pollToken;
		await loadStreamFromOffset(targetOffset, selectedRate, token);
	}

	async function changePlaybackRate(nextRate: PlaybackRate) {
		if (nextRate === selectedRate && videoElement?.playbackRate === nextRate) return;
		const targetOffset = currentVideoOffset();
		selectedRate = nextRate;
		applyVideoSettings();
		if (job) await loadStreamFromOffset(targetOffset, nextRate, pollToken);
	}

	function handleSeekInput(inputEvent: Event) {
		const target = inputEvent.currentTarget as HTMLInputElement;
		isSeeking = true;
		currentOffsetSeconds = clampOffset(Number(target.value));
	}

	async function handleSeekCommit(inputEvent: Event) {
		const target = inputEvent.currentTarget as HTMLInputElement;
		await seekToOffset(Number(target.value));
	}

	async function handleRateChange(changeEvent: Event) {
		const target = changeEvent.currentTarget as HTMLSelectElement;
		const nextRate = Number(target.value) as PlaybackRate;
		if (PLAYBACK_RATES.includes(nextRate)) await changePlaybackRate(nextRate);
	}

	async function waitForJob(initialJob: ClipJob, token: number) {
		let currentJob = initialJob;
		while (token === pollToken && currentJob.status !== 'failed') {
			await delay(POLL_INTERVAL_MS);
			if (token !== pollToken) return;

			try {
				currentJob = await getClipJob(currentJob.id);
			} catch (error) {
				if (token !== pollToken) return;
				messageKind = 'warning';
				message = errorMessage(error, 'Não foi possível atualizar o status do DVR.');
				continue;
			}

			if (token !== pollToken) return;
			job = currentJob;
			messageKind = currentJob.status === 'failed' ? 'error' : 'info';
			message = currentJob.message || defaultJobMessage(currentJob);
		}

		if (currentJob.status === 'failed') {
			messageKind = 'error';
			message = currentJob.error || currentJob.message || 'Falha ao preparar o vídeo.';
			isBuffering = false;
		}
	}

	async function submitClip(submitEvent: SubmitEvent, cameraId: string, maxDurationMinutes: number) {
		submitEvent.preventDefault();
		if (!event || !cameraId || submitting) return;

		const validationError = validateInterval(maxDurationMinutes);
		if (validationError) {
			messageKind = 'error';
			message = validationError;
			return;
		}

		const currentEvent = event;
		const token = ++pollToken;
		++streamToken;
		submitting = true;
		messageKind = 'info';
		message = 'Solicitando o recorte ao DVR...';
		job = null;
		videoUrl = null;
		videoElement = null;
		baseOffsetSeconds = 0;
		currentOffsetSeconds = 0;
		bufferedOffsetSeconds = 0;
		selectedRate = DEFAULT_RATE;
		isBuffering = false;
		isPlaying = false;
		isSeeking = false;

		try {
			const createdJob = await createClip(
				currentEvent.attendance_id,
				cameraId,
				datetimeLocalToIso(startValue),
				datetimeLocalToIso(endValue)
			);
			if (token !== pollToken) return;
			job = createdJob;
			message = createdJob.message || 'Linha do tempo pronta para navegar.';
			await loadStreamFromOffset(0, DEFAULT_RATE, token);
			if (token !== pollToken) return;
			void waitForJob(createdJob, token);
		} catch (error) {
			if (token !== pollToken) return;
			messageKind = 'error';
			message = errorMessage(error, 'Não foi possível preparar o vídeo.');
		} finally {
			if (token === pollToken) submitting = false;
		}
	}

	function handleClose() {
		if (submitting) return;
		++pollToken;
		++streamToken;
		resetTransientState();
		onClose();
	}
</script>

<dialog
	class="fixed inset-0 z-50 m-auto w-[min(42rem,calc(100vw-2rem))] rounded-3xl border border-slate-200 bg-white p-0 shadow-2xl backdrop:bg-slate-950/40"
	open={event !== null}
	onclose={handleClose}
	oncancel={(dialogEvent) => {
		if (submitting) dialogEvent.preventDefault();
	}}
	onclick={(dialogEvent) => {
		if (dialogEvent.target === dialogEvent.currentTarget) handleClose();
	}}
>
	{#if event}
		<div class="max-h-[calc(100vh-2rem)] overflow-y-auto p-5">
			<div class="flex items-start justify-between gap-4">
				<div>
					<h3 class="text-xl font-bold text-slate-950">Revisar vídeo da venda</h3>
					<p class="text-sm text-slate-600">
						{event.label_snapshot} · {dateTime(event.created_at)}
					</p>
					{#if event.academy_name}
						<p class="mt-1 text-xs font-semibold text-slate-500">{event.academy_name}</p>
					{/if}
				</div>
				<button
					type="button"
					class="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
					onclick={handleClose}
					aria-label="Fechar modal"
					disabled={submitting}
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

			<div class="mt-5 grid gap-4">
				<p
					class="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-900"
				>
					A duração completa aparece na linha do tempo desde o início. Escolher outro
					horário reinicia a reprodução naquele ponto; o padrão é 8x e o DVR pode avançar
					por quadros-chave nessa velocidade.
				</p>

				{#if camerasPromise}
					{#await camerasPromise}
						<p
							class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600"
						>
							Carregando câmeras da academia...
						</p>
						<div class="flex justify-end">
							<button
								type="button"
								class="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
								onclick={handleClose}
								disabled={submitting}
							>
								Fechar
							</button>
						</div>
					{:then data}
						{#if data.cameras.length === 0}
							<div
								class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600"
							>
								<p class="font-semibold text-slate-800">Nenhuma câmera configurada.</p>
								<p class="mt-1">
									Configure as câmeras desta academia antes de revisar vídeos de vendas.
								</p>
							</div>
							<div class="flex justify-end">
								<button
									type="button"
									class="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
									onclick={handleClose}
									disabled={submitting}
								>
									Fechar
								</button>
							</div>
						{:else}
							{@const selectedId = effectiveCameraId(data.cameras)}
							{@const selectedCamera =
								data.cameras.find((camera) => camera.id === selectedId) ?? null}
							<form
								class="grid gap-4"
								onsubmit={(submitEvent) =>
									submitClip(submitEvent, selectedId, data.maxDurationMinutes)}
							>
								<label class="text-sm font-medium text-slate-700">
									Câmera
									<select
										class="mt-1 w-full rounded-2xl border-slate-300"
										value={selectedId}
										onchange={(changeEvent) => {
											selectedCameraId = changeEvent.currentTarget.value;
										}}
										disabled={submitting}
										required
									>
										{#each data.cameras as camera (camera.id)}
											<option value={camera.id}>
												{camera.name}{camera.isDefault ? ' · padrão' : ''} · {camera.dvrName}
												· canal {camera.channel}
											</option>
										{/each}
									</select>
								</label>

								<div class="grid gap-4 sm:grid-cols-2">
									<label class="text-sm font-medium text-slate-700">
										Início
										<input
											class="mt-1 w-full rounded-2xl border-slate-300"
											type="datetime-local"
											bind:value={startValue}
											disabled={submitting}
											required
										/>
									</label>
									<label class="text-sm font-medium text-slate-700">
										Fim
										<input
											class="mt-1 w-full rounded-2xl border-slate-300"
											type="datetime-local"
											bind:value={endValue}
											disabled={submitting}
											required
										/>
									</label>
								</div>

								{#if selectedCamera}
									<p class="text-xs text-slate-500">
										Usando {selectedCamera.name} em {selectedCamera.dvrName}. Limite do
										recorte: {data.maxDurationMinutes} minutos.
									</p>
								{/if}

								{#if message}
									<p class={`rounded-2xl border px-4 py-3 text-sm font-medium ${messageClass}`}>
										{message}
									</p>
								{/if}

								{#if job}
									<div class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
										<div class="flex flex-wrap items-center justify-between gap-2">
											<p class="font-semibold text-slate-800">{job.cameraName}</p>
											<p class="text-xs font-bold uppercase tracking-wide text-slate-500">
												{statusLabel(job.status)}
											</p>
										</div>
										{#if generatedProgressLabel}
											<div class="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
												<div
													class="h-full rounded-full bg-sky-600 transition-all"
													style:width={generatedProgressPercent}
												></div>
											</div>
											<p class="mt-1 text-xs text-slate-500">
												DVR gerado até {formatClockTime(job.positionSeconds)} ·
												{generatedProgressLabel}
											</p>
										{/if}
									</div>
								{/if}

								{#if videoUrl}
									<div class="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
										<div class="relative overflow-hidden rounded-2xl bg-slate-950">
											{#key videoUrl}
												<video
													{@attach captureVideoElement}
													class="aspect-video w-full bg-slate-950"
													autoplay
													crossorigin="use-credentials"
													muted={isMuted}
													playsinline
													src={videoUrl}
													aria-label="Clipe da câmera para revisão da venda"
													onloadedmetadata={handleVideoReady}
													oncanplay={handleCanPlay}
													onplaying={handlePlaying}
													onplay={handlePlaying}
													onpause={handlePause}
													onended={handlePause}
													onwaiting={handleWaiting}
													onstalled={handleWaiting}
													onprogress={updateTimelineFromVideo}
													ontimeupdate={updateTimelineFromVideo}
													onvolumechange={handleVolumeChange}
												></video>
											{/key}
											{#if isBuffering}
												<div
													class="absolute inset-0 grid place-items-center bg-slate-950/35 text-sm font-semibold text-white"
												>
													Carregando ponto selecionado...
												</div>
											{/if}
										</div>

										<div class="grid gap-3">
											<div class="relative h-2 overflow-hidden rounded-full bg-slate-200">
												<div
													class="absolute inset-y-0 left-0 rounded-full bg-slate-300"
													style:width={bufferedPercent}
												></div>
												<div
													class="absolute inset-y-0 left-0 rounded-full bg-sky-600"
													style:width={currentPercent}
												></div>
											</div>
											<input
												class="w-full accent-sky-600"
												type="range"
												min="0"
												max={clipDurationSeconds}
												step="0.1"
												value={currentOffsetSeconds}
												title={currentClockLabel}
												aria-label="Selecionar horário do vídeo"
												aria-valuetext={currentClockLabel}
												disabled={!canUsePlayer}
												oninput={handleSeekInput}
												onchange={handleSeekCommit}
											/>
											<div class="flex items-center justify-between text-xs font-semibold text-slate-500">
												<span>{startClockLabel}</span>
												<span class="text-slate-700">{currentClockLabel}</span>
												<span>{endClockLabel}</span>
											</div>
										</div>

										<div class="flex flex-wrap items-center justify-between gap-3">
											<div class="flex flex-wrap items-center gap-2">
												<button
													type="button"
													class="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-800 disabled:opacity-60"
													onclick={togglePlay}
													disabled={!canUsePlayer}
												>
													{isPlaying ? 'Pausar' : 'Reproduzir'}
												</button>
												<button
													type="button"
													class="rounded-2xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white disabled:opacity-60"
													onclick={toggleMute}
													disabled={!canUsePlayer}
												>
													{isMuted ? 'Ativar som' : 'Silenciar'}
												</button>
												<label class="text-sm font-semibold text-slate-700">
													Velocidade
													<select
														class="ml-2 rounded-xl border-slate-300 text-sm"
														value={selectedRate}
														onchange={handleRateChange}
														disabled={!canUsePlayer}
													>
														{#each PLAYBACK_RATES as rate (rate)}
															<option value={rate}>{rate}x</option>
														{/each}
													</select>
												</label>
											</div>
											<div class="text-xs text-slate-500">
												{#if playerNote}
													<span class="font-semibold text-slate-600">{playerNote}</span>
													<span aria-hidden="true"> · </span>
												{/if}
												<span>Buffer até {bufferedClockLabel}</span>
											</div>
										</div>

										<p class="text-xs text-slate-500">
											O vídeo fica disponível temporariamente; selecione qualquer horário do
											intervalo para pedir aquele ponto ao DVR.
										</p>
									</div>
								{/if}

								<div class="flex flex-wrap justify-end gap-2">
									<button
										type="button"
										class="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
										onclick={handleClose}
										disabled={submitting}
									>
										Fechar
									</button>
									<button
										class="rounded-2xl bg-sky-600 px-5 py-3 font-bold text-white hover:bg-sky-700 disabled:opacity-60"
										disabled={!canSubmit || !selectedId}
									>
										{submitting ? 'Solicitando vídeo...' : 'Gerar vídeo'}
									</button>
								</div>
							</form>
						{/if}
					{:catch error}
						<p class="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
							Não foi possível carregar as câmeras: {errorMessage(error)}
						</p>
						<div class="flex justify-end">
							<button
								type="button"
								class="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
								onclick={handleClose}
								disabled={submitting}
							>
								Fechar
							</button>
						</div>
					{/await}
				{/if}
			</div>
		</div>
	{/if}
</dialog>
