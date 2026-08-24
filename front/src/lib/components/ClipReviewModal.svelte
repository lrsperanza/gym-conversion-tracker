<script lang="ts">
	import { dateTime } from '$lib/api/client';
	import { createClip, fetchClipUrl, getClipJob, listClipCameras } from '$lib/api/clips';
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

	let selectedCameraId = $state('');
	let startValue = $derived(event ? datetimeLocalValue(event.created_at, -5) : '');
	let endValue = $derived(event ? datetimeLocalValue(event.created_at, 2) : '');
	let busy = $state(false);
	let message = $state('');
	let messageKind = $state<'info' | 'warning' | 'error'>('info');
	let job = $state<ClipJob | null>(null);
	let videoUrl = $state<string | null>(null);

	let pollToken = 0;
	let currentVideoUrl: string | null = null;

	let camerasPromise = $derived(event ? listClipCameras(event.academy_id) : null);
	let canSubmit = $derived(Boolean(event && startValue && endValue && !busy));
	let messageClass = $derived(
		messageKind === 'error'
			? 'border-red-200 bg-red-50 text-red-800'
			: messageKind === 'warning'
				? 'border-amber-200 bg-amber-50 text-amber-900'
				: 'border-sky-200 bg-sky-50 text-sky-900'
	);
	let progressLabel = $derived(
		job && job.status !== 'failed'
			? `${Math.max(0, Math.min(100, Math.round(job.progress)))}%`
			: ''
	);

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

	function setVideoUrl(nextUrl: string | null) {
		if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
		currentVideoUrl = nextUrl;
		videoUrl = nextUrl;
	}

	function resetTransientState() {
		selectedCameraId = '';
		busy = false;
		message = '';
		messageKind = 'info';
		job = null;
		setVideoUrl(null);
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

	async function waitForJob(initialJob: ClipJob, token: number) {
		let currentJob = initialJob;
		while (currentJob.status !== 'completed' && currentJob.status !== 'failed') {
			await delay(POLL_INTERVAL_MS);
			if (token !== pollToken) return;
			currentJob = await getClipJob(currentJob.id);
			if (token !== pollToken) return;
			job = currentJob;
			messageKind = 'info';
			message = currentJob.message || 'Preparando o vídeo...';
		}

		if (currentJob.status === 'failed') {
			throw new Error(currentJob.error || currentJob.message || 'Falha ao preparar o vídeo.');
		}

		message = 'Vídeo pronto para revisão.';
		const url = await fetchClipUrl(currentJob.id);
		if (token !== pollToken) {
			URL.revokeObjectURL(url);
			return;
		}
		setVideoUrl(url);
	}

	async function submitClip(submitEvent: SubmitEvent, cameraId: string, maxDurationMinutes: number) {
		submitEvent.preventDefault();
		if (!event || !cameraId || busy) return;

		const validationError = validateInterval(maxDurationMinutes);
		if (validationError) {
			messageKind = 'error';
			message = validationError;
			return;
		}

		const currentEvent = event;
		const token = ++pollToken;
		busy = true;
		messageKind = 'info';
		message = 'Solicitando o recorte ao DVR...';
		job = null;
		setVideoUrl(null);

		try {
			const createdJob = await createClip(
				currentEvent.attendance_id,
				cameraId,
				datetimeLocalToIso(startValue),
				datetimeLocalToIso(endValue)
			);
			if (token !== pollToken) return;
			job = createdJob;
			message = createdJob.message || 'Recorte em andamento...';
			await waitForJob(createdJob, token);
		} catch (error) {
			if (token !== pollToken) return;
			messageKind = 'error';
			message = errorMessage(error, 'Não foi possível preparar o vídeo.');
		} finally {
			if (token === pollToken) busy = false;
		}
	}

	function handleClose() {
		if (busy) return;
		++pollToken;
		resetTransientState();
		onClose();
	}
</script>

<dialog
	class="fixed inset-0 z-50 m-auto w-[min(42rem,calc(100vw-2rem))] rounded-3xl border border-slate-200 bg-white p-0 shadow-2xl backdrop:bg-slate-950/40"
	open={event !== null}
	onclose={handleClose}
	oncancel={(dialogEvent) => {
		if (busy) dialogEvent.preventDefault();
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

			<div class="mt-5 grid gap-4">
				<p
					class="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-900"
				>
					O DVR reproduz as gravações em tempo real. Um recorte de 5 minutos pode levar cerca de
					5 minutos para ficar pronto.
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
								disabled={busy}
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
									disabled={busy}
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
										disabled={busy}
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
											disabled={busy}
											required
										/>
									</label>
									<label class="text-sm font-medium text-slate-700">
										Fim
										<input
											class="mt-1 w-full rounded-2xl border-slate-300"
											type="datetime-local"
											bind:value={endValue}
											disabled={busy}
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
												{job.status === 'completed'
													? 'Concluído'
													: job.status === 'failed'
														? 'Falhou'
														: 'Processando'}
											</p>
										</div>
										{#if progressLabel}
											<div class="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
												<div
													class="h-full rounded-full bg-sky-600 transition-all"
													style:width={progressLabel}
												></div>
											</div>
											<p class="mt-1 text-xs text-slate-500">{progressLabel}</p>
										{/if}
									</div>
								{/if}

								{#if videoUrl}
									<div class="grid gap-2">
										<video
											class="aspect-video w-full rounded-2xl bg-slate-950"
											controls
											muted
											src={videoUrl}
											aria-label="Clipe da câmera para revisão da venda"
										></video>
										<p class="text-xs text-slate-500">
											O vídeo fica disponível temporariamente; gere novamente se precisar revisar
											outro intervalo.
										</p>
									</div>
								{/if}

								<div class="flex flex-wrap justify-end gap-2">
									<button
										type="button"
										class="rounded-2xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
										onclick={handleClose}
										disabled={busy}
									>
										Fechar
									</button>
									<button
										class="rounded-2xl bg-sky-600 px-5 py-3 font-bold text-white hover:bg-sky-700 disabled:opacity-60"
										disabled={!canSubmit || !selectedId}
									>
										{busy ? 'Preparando vídeo...' : 'Gerar vídeo'}
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
								disabled={busy}
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
