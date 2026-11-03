<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api/client';
	import { resolveApiHostUrl } from '$lib/api/hosts';
	import { SegmentPlayer, type PlayerSegment } from '$lib/audio/player';
	import { canAccessDashboard } from '$lib/auth/roles';
	import Empty from '$lib/components/Empty.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { errorMessage, queryString, statusLabel } from '$lib/helpers';
	import { getSessionContext } from '$lib/session';
	import type { Academy, AudioSegment, AudioTimeline, AudioTimelineAttendance } from '$lib/types';
	import { onDestroy, onMount, tick, untrack } from 'svelte';

	/** Uma gravação contínua: um profissional logado em um terminal (device) da academia. */
	type Track = {
		key: string;
		userId: string;
		userName: string;
		terminalLabel: string;
		segments: AudioSegment[];
		totalMs: number;
	};
	type Professional = { userId: string; name: string; totalMs: number; tracks: Track[] };
	type Range = { start: number; end: number };

	const TIME_ZONE = 'America/Sao_Paulo';
	// Brasil não tem horário de verão desde 2019: o dia local é sempre UTC-3.
	const UTC_OFFSET = '-03:00';
	const CONTIGUOUS_MS = 1_500;
	const ZOOM_WINDOW_MS = 20 * 60_000;
	const ATTENDANCE_LEAD_IN_MS = 30_000;

	const { session } = getSessionContext();

	const timeFormat = new Intl.DateTimeFormat('pt-BR', {
		timeZone: TIME_ZONE,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});
	const shortTimeFormat = new Intl.DateTimeFormat('pt-BR', {
		timeZone: TIME_ZONE,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	});
	const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE });

	let academies = $state.raw<Academy[]>([]);
	let filter = $state({ academyId: '', date: dayFormat.format(new Date()) });
	let timeline = $state.raw<AudioTimeline | null>(null);
	let trackKey = $state('');
	let loading = $state(false);
	let message = $state('');
	let jumpTime = $state('');
	let volume = $state(1);
	// The player is plain JS; this counter is bumped on every change so the view re-reads it.
	let version = $state(0);

	// `+=` reads `version`; untracked so an effect that calls into the player (setSegments) does not
	// start depending on the counter it bumps, which loops forever.
	const player = new SegmentPlayer(fetchSegment, () => {
		untrack(() => (version += 1));
	});

	let tracks = $derived.by(() => {
		const byKey: Record<string, Track> = {};
		for (const segment of timeline?.segments ?? []) {
			const key = `${segment.userId}|${segment.deviceId}`;
			byKey[key] ??= {
				key,
				userId: segment.userId,
				userName: segment.userName ?? 'Usuário removido',
				// O microfone identifica o terminal; o final do deviceId desempata microfones iguais.
				terminalLabel: `${segment.deviceLabel || 'Microfone'} · ${segment.deviceId.slice(-4)}`,
				segments: [],
				totalMs: 0
			};
			byKey[key].segments.push(segment);
			byKey[key].totalMs += segment.durationMs;
		}
		return Object.values(byKey).sort((a, b) => b.totalMs - a.totalMs);
	});
	let professionals = $derived.by(() => {
		const byUser: Record<string, Professional> = {};
		for (const candidate of tracks) {
			byUser[candidate.userId] ??= {
				userId: candidate.userId,
				name: candidate.userName,
				totalMs: 0,
				tracks: []
			};
			byUser[candidate.userId].tracks.push(candidate);
			byUser[candidate.userId].totalMs += candidate.totalMs;
		}
		return Object.values(byUser).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
	});
	let track = $derived(tracks.find((candidate) => candidate.key === trackKey) ?? null);
	let professional = $derived(
		professionals.find((candidate) => candidate.userId === track?.userId) ?? null
	);
	let onlyProfessionalAttendances = $state(true);
	let attendances = $derived(
		(timeline?.attendances ?? []).filter(
			(attendance) =>
				!onlyProfessionalAttendances ||
				!professional ||
				attendance.receptionistId === professional.userId
		)
	);
	let coverage = $derived.by(() => mergeRanges(track?.segments ?? []));
	let dayStart = $derived(Date.parse(`${filter.date}T00:00:00${UTC_OFFSET}`));
	let dayRange = $derived.by<Range>(() => {
		// Mostra só as horas com gravação ou atendimento (mínimo 06h–22h), em horas cheias.
		const points = [
			...coverage.flatMap((range) => [range.start, range.end]),
			...(timeline?.attendances ?? []).map((attendance) => Date.parse(attendance.startedAt))
		];
		const hour = 3_600_000;
		const start = Math.min(dayStart + 6 * hour, ...points);
		const end = Math.max(dayStart + 22 * hour, ...points);
		return {
			start: Math.max(dayStart, Math.floor((start - dayStart) / hour) * hour + dayStart),
			end: Math.min(dayStart + 24 * hour, Math.ceil((end - dayStart) / hour) * hour + dayStart)
		};
	});
	let position = $derived.by(() => {
		void version;
		return player.position();
	});
	let playing = $derived.by(() => {
		void version;
		return player.playing;
	});
	let playerLoading = $derived.by(() => {
		void version;
		return player.loading;
	});
	let playerError = $derived.by(() => {
		void version;
		return player.error;
	});
	let zoomRange = $derived.by<Range>(() => {
		const start = Math.max(dayRange.start, position - ZOOM_WINDOW_MS / 2);
		const end = Math.min(dayRange.end, start + ZOOM_WINDOW_MS);
		return { start: end - ZOOM_WINDOW_MS, end };
	});
	let hasAudioAtPosition = $derived(
		coverage.some((range) => range.start <= position && range.end > position)
	);
	let hourTicks = $derived.by(() => {
		const ticks: number[] = [];
		for (let tick = dayRange.start; tick <= dayRange.end; tick += 3_600_000) ticks.push(tick);
		return ticks;
	});
	let zoomTicks = $derived.by(() => {
		const ticks: number[] = [];
		const step = 5 * 60_000;
		for (let tick = Math.ceil(zoomRange.start / step) * step; tick <= zoomRange.end; tick += step) {
			ticks.push(tick);
		}
		return ticks;
	});

	$effect(() => {
		const segments: PlayerSegment[] = (track?.segments ?? []).map((segment) => ({
			id: segment.id,
			start: Date.parse(segment.startedAt),
			end: Date.parse(segment.endedAt)
		}));
		untrack(() => player.setSegments(segments));
	});

	$effect(() => {
		player.setVolume(volume);
	});

	onMount(() => {
		if (!session.user) return;
		if (!canAccessDashboard(session.user)) {
			void goto(resolve('/atendimento'), { replaceState: true });
			return;
		}
		const params = page.url.searchParams;
		const at = params.get('at');
		if (params.get('academyId')) filter.academyId = params.get('academyId')!;
		if (at && Number.isFinite(Date.parse(at))) filter.date = dayFormat.format(new Date(at));
		void loadInitialData(at ? Date.parse(at) : null);
	});

	onDestroy(() => player.destroy());

	async function loadInitialData(at: number | null) {
		try {
			const data = await api<{ academies: Academy[] }>('/api/admin/academies');
			academies = data.academies;
			const active = academies.filter((academy) => academy.active);
			if (!filter.academyId && active.length) filter.academyId = active[0].id;
			await loadTimeline(at);
		} catch (error) {
			message = errorMessage(error);
		}
	}

	async function loadTimeline(at: number | null = null) {
		if (!filter.academyId || !filter.date) return;
		player.pause();
		loading = true;
		message = '';
		try {
			const from = new Date(dayStart).toISOString();
			const to = new Date(dayStart + 24 * 3_600_000).toISOString();
			timeline = await api<AudioTimeline>(
				`/api/audio/timeline${queryString({ academyId: filter.academyId, from, to })}`
			);
			if (timeline.truncated) message = 'Período com trechos demais; a lista foi cortada.';
			const target = at ?? null;
			const preferred = target !== null ? trackCovering(target) : null;
			trackKey =
				preferred?.key ??
				(tracks.some((t) => t.key === trackKey) ? trackKey : (tracks[0]?.key ?? ''));
			const firstSegment = Date.parse(track?.segments[0]?.startedAt ?? '');
			player.seek(target ?? (Number.isFinite(firstSegment) ? firstSegment : dayStart));
		} catch (error) {
			message = errorMessage(error);
			timeline = null;
		} finally {
			loading = false;
		}
	}

	async function fetchSegment(id: string) {
		const response = await fetch(`${await resolveApiHostUrl()}/api/audio/segments/${id}/file`, {
			credentials: 'include'
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return response.arrayBuffer();
	}

	function trackCovering(time: number, preferUserId?: string) {
		const covering = tracks.filter((candidate) =>
			candidate.segments.some(
				(segment) => Date.parse(segment.startedAt) <= time && Date.parse(segment.endedAt) > time
			)
		);
		return covering.find((candidate) => candidate.userId === preferUserId) ?? covering[0] ?? null;
	}

	/** Troca de profissional: começa pelo terminal em que ele mais gravou no dia. */
	function selectProfessional(userId: string) {
		const next = professionals.find((candidate) => candidate.userId === userId);
		if (next) trackKey = next.tracks.toSorted((a, b) => b.totalMs - a.totalMs)[0]!.key;
	}

	function durationLabel(ms: number) {
		const minutes = Math.round(ms / 60_000);
		return minutes >= 60
			? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
			: `${minutes} min`;
	}

	function mergeRanges(segments: AudioSegment[]): Range[] {
		const ranges: Range[] = [];
		for (const segment of segments) {
			const start = Date.parse(segment.startedAt);
			const end = Date.parse(segment.endedAt);
			const last = ranges.at(-1);
			if (last && start - last.end <= CONTIGUOUS_MS) last.end = Math.max(last.end, end);
			else ranges.push({ start, end });
		}
		return ranges;
	}

	function togglePlay() {
		if (player.playing) player.pause();
		else void player.play();
	}

	function skip(ms: number) {
		player.seek(player.position() + ms);
	}

	function seekFromBar(event: MouseEvent, range: Range) {
		const bar = event.currentTarget as HTMLElement;
		const rect = bar.getBoundingClientRect();
		const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
		player.seek(range.start + ratio * (range.end - range.start));
	}

	function seekFromKeyboard(event: KeyboardEvent, stepMs: number) {
		if (event.key === 'ArrowLeft') skip(-stepMs);
		else if (event.key === 'ArrowRight') skip(stepMs);
		else return;
		event.preventDefault();
		event.stopPropagation();
	}

	function jumpToTime(event: SubmitEvent) {
		event.preventDefault();
		const match = jumpTime.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
		if (!match) {
			message = 'Informe o horário como HH:MM ou HH:MM:SS.';
			return;
		}
		message = '';
		const [, hours, minutes, seconds = '0'] = match;
		player.seek(dayStart + ((+hours * 60 + +minutes) * 60 + +seconds) * 1_000);
	}

	async function jumpToAttendance(attendance: AudioTimelineAttendance) {
		const startedAt = Date.parse(attendance.startedAt);
		const covering = trackCovering(startedAt, attendance.receptionistId);
		if (covering && covering.key !== trackKey) trackKey = covering.key;
		// Trocar de gravação recria a lista do player no $effect; o play precisa vir depois disso.
		await tick();
		await player.play(startedAt - ATTENDANCE_LEAD_IN_MS);
	}

	function onKeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		if (target?.closest('input, select, textarea, button, [role="slider"]')) return;
		if (event.key === ' ') {
			event.preventDefault();
			togglePlay();
		} else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			const step = event.shiftKey ? 60_000 : 10_000;
			skip(event.key === 'ArrowLeft' ? -step : step);
		}
	}

	function percentIn(range: Range, time: number) {
		return ((time - range.start) / (range.end - range.start)) * 100;
	}

	function widthIn(range: Range, start: number, end: number) {
		const left = Math.max(range.start, start);
		const right = Math.min(range.end, end);
		return right > left ? ((right - left) / (range.end - range.start)) * 100 : 0;
	}
</script>

<svelte:head>
	<title>Auditoria de áudio | Tracker de conversão</title>
</svelte:head>

<svelte:window onkeydown={onKeydown} />

{#if session.user && canAccessDashboard(session.user)}
	<section class="space-y-6">
		<div class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
			<div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
				<div>
					<a
						class="text-sm font-semibold text-sky-700 hover:underline"
						href={resolve('/dashboard')}
					>
						← Dashboard
					</a>
					<h2 class="text-2xl font-bold text-slate-950">Auditoria de áudio</h2>
					<p class="text-slate-600">
						Gravação contínua da recepção. Os áudios ficam disponíveis por
						{timeline?.retentionDays ?? 30} dias.
					</p>
				</div>
				<form
					class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
					onsubmit={(event) => {
						event.preventDefault();
						void loadTimeline();
					}}
				>
					<label class="text-sm font-medium text-slate-700">
						Academia
						<select
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={filter.academyId}
							onchange={() => void loadTimeline()}
						>
							{#each academies as academy (academy.id)}
								<option value={academy.id}>{academy.name}</option>
							{/each}
						</select>
					</label>
					<label class="text-sm font-medium text-slate-700">
						Dia
						<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							type="date"
							bind:value={filter.date}
							onchange={() => void loadTimeline()}
						/>
					</label>
					<label class="text-sm font-medium text-slate-700">
						Profissional
						<select
							class="mt-1 w-full rounded-2xl border-slate-300"
							value={professional?.userId ?? ''}
							disabled={!professionals.length}
							onchange={(event) => selectProfessional(event.currentTarget.value)}
						>
							{#each professionals as candidate (candidate.userId)}
								<option value={candidate.userId}
									>{candidate.name} ({durationLabel(candidate.totalMs)})</option
								>
							{:else}
								<option value="">Nenhuma gravação</option>
							{/each}
						</select>
					</label>
					{#if professional && professional.tracks.length > 1}
						<label class="text-sm font-medium text-slate-700">
							Terminal
							<select class="mt-1 w-full rounded-2xl border-slate-300" bind:value={trackKey}>
								{#each professional.tracks as candidate (candidate.key)}
									<option value={candidate.key}
										>{candidate.terminalLabel} ({durationLabel(candidate.totalMs)})</option
									>
								{/each}
							</select>
						</label>
					{/if}
				</form>
			</div>
		</div>

		<Notice {message} />

		{#if loading}
			<Empty text="Carregando gravações..." />
		{:else if !track}
			<Empty text="Nenhum áudio gravado nesta academia neste dia." />
		{:else}
			<div class="space-y-5 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
					<div>
						<p class="font-mono text-4xl font-bold tracking-tight text-slate-950 tabular-nums">
							{timeFormat.format(position)}
						</p>
						<p class="text-sm text-slate-500">
							{#if playerLoading}
								Carregando áudio...
							{:else if playerError}
								<span class="text-red-600">{playerError}</span>
							{:else if !hasAudioAtPosition}
								Sem gravação neste horário — o play pula para o próximo trecho.
							{:else}
								{durationLabel(track.totalMs)} gravados neste dia neste terminal
							{/if}
						</p>
					</div>

					<div class="flex flex-wrap items-center gap-2">
						<button
							type="button"
							class="rounded-2xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
							onclick={() => skip(-60_000)}
							title="Voltar 1 minuto (Shift+←)">−1 min</button
						>
						<button
							type="button"
							class="rounded-2xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
							onclick={() => skip(-10_000)}
							title="Voltar 10 segundos (←)">−10 s</button
						>
						<button
							type="button"
							class="inline-flex min-w-28 items-center justify-center gap-2 rounded-2xl bg-sky-600 px-5 py-2 text-sm font-bold text-white shadow-sm hover:bg-sky-700"
							onclick={togglePlay}
							title="Tocar / pausar (espaço)"
						>
							{#if playing}
								<svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
									><rect x="6" y="5" width="4" height="14" rx="1" /><rect
										x="14"
										y="5"
										width="4"
										height="14"
										rx="1"
									/></svg
								>
								Pausar
							{:else}
								<svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
									><path d="M8 5v14l11-7z" /></svg
								>
								Tocar
							{/if}
						</button>
						<button
							type="button"
							class="rounded-2xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
							onclick={() => skip(10_000)}
							title="Avançar 10 segundos (→)">+10 s</button
						>
						<button
							type="button"
							class="rounded-2xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
							onclick={() => skip(60_000)}
							title="Avançar 1 minuto (Shift+→)">+1 min</button
						>
					</div>

					<div class="flex flex-wrap items-center gap-3">
						<form class="flex items-center gap-2" onsubmit={jumpToTime}>
							<input
								class="w-28 rounded-2xl border-slate-300 font-mono text-sm"
								placeholder="HH:MM:SS"
								aria-label="Ir para o horário"
								bind:value={jumpTime}
							/>
							<button
								class="rounded-2xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
								>Ir</button
							>
						</form>
						<label class="flex items-center gap-2 text-sm text-slate-600">
							Volume
							<input type="range" min="0" max="2" step="0.05" bind:value={volume} class="w-24" />
						</label>
					</div>
				</div>

				<div>
					<p class="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">Dia</p>
					<div
						class="relative h-10 cursor-pointer rounded-xl bg-slate-100 ring-1 ring-slate-200"
						role="slider"
						tabindex="0"
						aria-label="Horário no dia"
						aria-valuemin={dayRange.start}
						aria-valuemax={dayRange.end}
						aria-valuenow={position}
						aria-valuetext={timeFormat.format(position)}
						onclick={(event) => seekFromBar(event, dayRange)}
						onkeydown={(event) => seekFromKeyboard(event, 5 * 60_000)}
					>
						{#each coverage as range (range.start)}
							<div
								class="absolute inset-y-1 rounded bg-emerald-400/70"
								style:left={`${percentIn(dayRange, Math.max(range.start, dayRange.start))}%`}
								style:width={`${Math.max(0.15, widthIn(dayRange, range.start, range.end))}%`}
							></div>
						{/each}
						{#each attendances as attendance (attendance.id)}
							<div
								class="absolute inset-y-0 w-0.5 bg-sky-600"
								style:left={`${percentIn(dayRange, Date.parse(attendance.startedAt))}%`}
								title={`${shortTimeFormat.format(Date.parse(attendance.startedAt))} · ${attendance.leadName}`}
							></div>
						{/each}
						<div
							class="pointer-events-none absolute -inset-y-1 w-0.5 bg-red-500"
							style:left={`${percentIn(dayRange, position)}%`}
						></div>
						<div
							class="pointer-events-none absolute inset-y-0 border border-slate-400/60 bg-slate-900/5"
							style:left={`${percentIn(dayRange, zoomRange.start)}%`}
							style:width={`${widthIn(dayRange, zoomRange.start, zoomRange.end)}%`}
						></div>
					</div>
					<div class="relative mt-1 h-4 text-[10px] text-slate-500">
						{#each hourTicks as tick (tick)}
							<span class="absolute -translate-x-1/2" style:left={`${percentIn(dayRange, tick)}%`}
								>{shortTimeFormat.format(tick).slice(0, 2)}h</span
							>
						{/each}
					</div>
				</div>

				<div>
					<p class="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
						Detalhe ({shortTimeFormat.format(zoomRange.start)}–{shortTimeFormat.format(
							zoomRange.end
						)})
					</p>
					<div
						class="relative h-14 cursor-pointer rounded-xl bg-slate-100 ring-1 ring-slate-200"
						role="slider"
						tabindex="0"
						aria-label="Horário em detalhe"
						aria-valuemin={zoomRange.start}
						aria-valuemax={zoomRange.end}
						aria-valuenow={position}
						aria-valuetext={timeFormat.format(position)}
						onclick={(event) => seekFromBar(event, zoomRange)}
						onkeydown={(event) => seekFromKeyboard(event, 10_000)}
					>
						{#each coverage as range (range.start)}
							{#if widthIn(zoomRange, range.start, range.end) > 0}
								<div
									class="absolute inset-y-1 rounded bg-emerald-400/70"
									style:left={`${percentIn(zoomRange, Math.max(range.start, zoomRange.start))}%`}
									style:width={`${widthIn(zoomRange, range.start, range.end)}%`}
								></div>
							{/if}
						{/each}
						{#each zoomTicks as tick (tick)}
							<div
								class="absolute inset-y-0 w-px bg-slate-300"
								style:left={`${percentIn(zoomRange, tick)}%`}
							></div>
						{/each}
						{#each attendances as attendance (attendance.id)}
							{@const startedAt = Date.parse(attendance.startedAt)}
							{#if startedAt >= zoomRange.start && startedAt <= zoomRange.end}
								<div
									class="absolute inset-y-0 w-0.5 bg-sky-600"
									style:left={`${percentIn(zoomRange, startedAt)}%`}
								>
									<span
										class="absolute top-0.5 left-1 max-w-40 truncate rounded bg-sky-600 px-1 text-[10px] font-semibold text-white"
										>{attendance.leadName}</span
									>
								</div>
							{/if}
						{/each}
						<div
							class="pointer-events-none absolute -inset-y-1 w-0.5 bg-red-500"
							style:left={`${percentIn(zoomRange, position)}%`}
						></div>
					</div>
					<div class="relative mt-1 h-4 text-[10px] text-slate-500">
						{#each zoomTicks as tick (tick)}
							<span class="absolute -translate-x-1/2" style:left={`${percentIn(zoomRange, tick)}%`}
								>{shortTimeFormat.format(tick)}</span
							>
						{/each}
					</div>
				</div>

				<p class="text-xs text-slate-500">
					Atalhos: espaço toca/pausa, ← → voltam/avançam 10 s, Shift + ← → 1 min. Clique nas barras
					para ir ao horário.
				</p>
			</div>
		{/if}

		<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h3 class="text-base font-semibold text-slate-900">Atendimentos do dia</h3>
				{#if professional}
					<label class="flex items-center gap-2 text-sm text-slate-600">
						<input type="checkbox" class="rounded" bind:checked={onlyProfessionalAttendances} />
						Só os de {professional.name}
					</label>
				{/if}
			</div>
			{#if attendances.length}
				<div class="mt-4 overflow-x-auto">
					<table class="min-w-full text-left text-sm">
						<thead class="text-xs tracking-wide text-slate-500 uppercase">
							<tr>
								<th class="py-2 pr-4">Abertura</th>
								<th class="py-2 pr-4">Lead</th>
								<th class="py-2 pr-4">Recepção</th>
								<th class="py-2 pr-4">Status</th>
								<th class="py-2"></th>
							</tr>
						</thead>
						<tbody class="divide-y divide-slate-100">
							{#each attendances as attendance (attendance.id)}
								{@const startedAt = Date.parse(attendance.startedAt)}
								{@const audible = trackCovering(startedAt) !== null}
								<tr>
									<td class="py-3 pr-4 font-mono">{timeFormat.format(startedAt)}</td>
									<td class="py-3 pr-4 font-medium">{attendance.leadName}</td>
									<td class="py-3 pr-4">{attendance.receptionistName}</td>
									<td class="py-3 pr-4">{statusLabel(attendance.status)}</td>
									<td class="py-3 text-right">
										<button
											type="button"
											class="rounded-2xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
											disabled={!audible}
											title={audible
												? 'Ouvir a partir de 30 s antes da abertura'
												: 'Sem áudio neste horário'}
											onclick={() => void jumpToAttendance(attendance)}>Ouvir</button
										>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<Empty text="Nenhum atendimento aberto neste dia." />
			{/if}
		</section>
	</section>
{:else}
	<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
		<h2 class="text-2xl font-bold text-slate-950">Redirecionando...</h2>
		<p class="text-slate-600">Seu perfil não tem acesso ao dashboard.</p>
	</section>
{/if}
