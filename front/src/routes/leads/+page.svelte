<script lang="ts">
	import { api } from '$lib/api/client';
	import Empty from '$lib/components/Empty.svelte';
	import LeadRow from '$lib/components/LeadRow.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { errorMessage, queryString } from '$lib/helpers';
	import { getSessionContext } from '$lib/session';
	import type { LeadSummary } from '$lib/types';
	import { onMount } from 'svelte';

	const { session } = getSessionContext();

	let scheduledLeads = $state.raw<LeadSummary[]>([]);
	let searchLeads = $state.raw<LeadSummary[]>([]);
	let scheduledLoading = $state(false);
	let searchLoading = $state(false);
	let scheduledMessage = $state('');
	let searchMessage = $state('');
	let searchQuery = $state('');
	let searchRequestId = 0;
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	onMount(() => {
		void loadScheduled();
		void loadSearch('');
		return () => {
			if (searchTimer) window.clearTimeout(searchTimer);
		};
	});

	async function loadScheduled() {
		if (!session.user) return;
		scheduledLoading = true;
		scheduledMessage = '';
		try {
			const data = await api<{ leads: LeadSummary[] }>(
				`/api/leads${queryString({ scheduled: 'upcoming', limit: '50' })}`
			);
			scheduledLeads = data.leads;
		} catch (error) {
			scheduledMessage = errorMessage(error);
		} finally {
			scheduledLoading = false;
		}
	}

	async function loadSearch(query = searchQuery.trim()) {
		if (!session.user) return;
		const requestId = ++searchRequestId;
		searchLoading = true;
		searchMessage = '';
		try {
			const data = await api<{ leads: LeadSummary[] }>(
				`/api/leads${queryString({ search: query, limit: '50' })}`
			);
			if (requestId === searchRequestId) searchLeads = data.leads;
		} catch (error) {
			if (requestId === searchRequestId) searchMessage = errorMessage(error);
		} finally {
			if (requestId === searchRequestId) searchLoading = false;
		}
	}

	async function refreshLeads() {
		await Promise.all([loadScheduled(), loadSearch()]);
	}

	function scheduleSearch(value: string) {
		searchQuery = value;
		if (searchTimer) window.clearTimeout(searchTimer);
		searchTimer = window.setTimeout(() => {
			searchTimer = null;
			void loadSearch(value.trim());
		}, 300);
	}
</script>

<svelte:head>
	<title>Leads | Tracker de conversão</title>
</svelte:head>

<section class="space-y-6">
	<section class="rounded-3xl bg-sky-50 p-5 shadow-sm ring-1 ring-sky-100">
		<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div>
				<p class="text-sm font-bold tracking-[0.2em] text-sky-700 uppercase">Agendamentos</p>
				<h2 class="text-2xl font-bold text-slate-950">Próximos contatos</h2>
				<p class="text-slate-600">Leads com aula experimental ou follow-up marcado.</p>
			</div>
			<button
				class="rounded-2xl border border-sky-200 bg-white px-4 py-3 font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-60"
				onclick={loadScheduled}
				disabled={scheduledLoading}
			>
				Atualizar
			</button>
		</div>

		<div class="mt-5 space-y-3">
			<Notice message={scheduledMessage} />
			{#if scheduledLoading}
				<p class="rounded-2xl bg-white px-4 py-6 text-center text-sm text-slate-500">
					Carregando agendamentos...
				</p>
			{:else if scheduledLeads.length}
				<div class="grid gap-3">
					{#each scheduledLeads as lead (lead.id)}
						<LeadRow lead={lead} mode="scheduled" onChanged={refreshLeads} />
					{/each}
				</div>
			{:else}
				<Empty text="Nenhum agendamento futuro encontrado." />
			{/if}
		</div>
	</section>

	<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
		<div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
			<div>
				<h2 class="text-2xl font-bold text-slate-950">Todos os leads</h2>
				<p class="text-slate-600">Busque, edite dados e reabra atendimentos finalizados.</p>
			</div>
			<label class="w-full text-sm font-medium text-slate-700 lg:max-w-md">
				Buscar lead
				<input
					class="mt-1 w-full rounded-2xl border-slate-300 text-base"
					placeholder="Nome, email ou telefone"
					value={searchQuery}
					oninput={(event) => scheduleSearch(event.currentTarget.value)}
				/>
			</label>
		</div>

		<div class="mt-5 space-y-3">
			<Notice message={searchMessage} />
			{#if searchLoading}
				<p class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
					Buscando leads...
				</p>
			{:else if searchLeads.length}
				<div class="grid gap-3">
					{#each searchLeads as lead (lead.id)}
						<LeadRow lead={lead} mode="search" onChanged={refreshLeads} />
					{/each}
				</div>
			{:else}
				<Empty text="Nenhum lead encontrado para esta busca." />
			{/if}
		</div>
	</section>
</section>
