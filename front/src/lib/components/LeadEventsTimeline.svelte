<script lang="ts">
	import { api, dateTime, money } from '$lib/api/client';
	import { isReceptionistOnly } from '$lib/auth/roles';
	import { errorMessage, eventToneClass, eventTypeLabel, isScheduledEventType } from '$lib/helpers';
	import { getSessionContext } from '$lib/session';
	import type { LeadEvent } from '$lib/types';
	import ClipReviewModal from './ClipReviewModal.svelte';

	let {
		leadId,
		count = null,
		label = 'Histórico do lead'
	}: {
		leadId: string;
		count?: number | null;
		label?: string;
	} = $props();

	const { session } = getSessionContext();

	/** Nestes tipos a descrição é gerada pelo backend e só repete o rótulo do evento. */
	const GENERATED_DESCRIPTION: string[] = ['SALE', 'TOUR_RECEPTIONIST', 'TOUR_PROFESSOR'];

	let open = $state(false);
	let reviewEvent = $state<LeadEvent | null>(null);
	let canReviewClips = $derived(!isReceptionistOnly(session.user));

	/** Muda quando o lead troca ou quando um evento novo é registrado, forçando recarga. */
	let requestKey = $derived(`${leadId}:${count ?? ''}`);
	let countLabel = $derived(count ? `${count} evento${count === 1 ? '' : 's'}` : '');

	async function fetchEvents() {
		const data = await api<{ events: LeadEvent[] }>(`/api/leads/${leadId}/events`);
		return data.events;
	}
</script>

<div class="mt-3 border-t border-slate-100 pt-2">
	<button
		type="button"
		class="flex w-full items-center justify-between gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-slate-50"
		onclick={() => (open = !open)}
		aria-expanded={open}
	>
		<span class="text-xs font-bold text-slate-700">
			{label}{#if countLabel}<span class="font-semibold text-slate-500"> · {countLabel}</span>{/if}
		</span>
		<span class="flex items-center gap-1 text-xs font-bold text-sky-700">
			{open ? 'Ocultar' : 'Ver'}
			<svg
				class={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
				viewBox="0 0 20 20"
				fill="currentColor"
				aria-hidden="true"
			>
				<path
					fill-rule="evenodd"
					d="M5.22 7.22a.75.75 0 0 1 1.06 0L10 10.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 8.28a.75.75 0 0 1 0-1.06Z"
					clip-rule="evenodd"
				/>
			</svg>
		</span>
	</button>

	{#if open}
		{#key requestKey}
			{#await fetchEvents()}
				<p class="mt-2 px-2 text-xs text-slate-500">Carregando eventos...</p>
			{:then events}
				{#if events.length}
					<ol class="mt-2 ml-3 space-y-3 border-l border-slate-200 pl-4">
						{#each events as event (event.id)}
							<li class="space-y-1">
								<div class="flex flex-wrap items-center gap-2">
									<span
										class={`rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${eventToneClass(event.type)}`}
									>
										{eventTypeLabel(event.type)}
									</span>
									<span class="text-[11px] text-slate-500">{dateTime(event.created_at)}</span>
									{#if isScheduledEventType(event.type) && event.schedule_cancelled}
										<span
											class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500"
										>
											cancelado depois
										</span>
									{/if}
								</div>
								{#if isScheduledEventType(event.type) && event.scheduled_for}
									<p
										class={`text-xs font-bold ${event.schedule_cancelled ? 'text-slate-400 line-through' : 'text-sky-800'}`}
									>
										Agendado para {dateTime(event.scheduled_for)}
									</p>
								{/if}
								{#if event.type === 'SALE' && event.label_snapshot}
									<div class="flex flex-wrap items-center gap-2">
										<p class="text-xs font-bold text-emerald-800">
											{event.label_snapshot} · {money(event.amount_cents)}
										</p>
										{#if canReviewClips}
											<button
												type="button"
												class="rounded-full border border-emerald-200 px-2.5 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-50"
												onclick={() => (reviewEvent = event)}
											>
												Revisar vídeo
											</button>
										{/if}
									</div>
								{/if}
								{#if event.loss_reason_label}
									<p class="text-xs font-bold text-red-800">Motivo: {event.loss_reason_label}</p>
								{/if}
								{#if event.description && !GENERATED_DESCRIPTION.includes(event.type)}
									<p class="text-xs text-slate-600">{event.description}</p>
								{/if}
								<p class="text-[11px] text-slate-400">
									{event.actor_name}{event.academy_name ? ` · ${event.academy_name}` : ''}
								</p>
							</li>
						{/each}
					</ol>
				{:else}
					<p class="mt-2 px-2 text-xs text-slate-500">Nenhum evento registrado para este lead.</p>
				{/if}
			{:catch error}
				<p class="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-800">
					{errorMessage(error)}
				</p>
			{/await}
		{/key}
	{/if}

	{#if canReviewClips}
		<ClipReviewModal event={reviewEvent} onClose={() => (reviewEvent = null)} />
	{/if}
</div>
