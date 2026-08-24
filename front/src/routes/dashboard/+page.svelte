<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { api, dateTime, money, percent } from '$lib/api/client';
	import { canAccessDashboard } from '$lib/auth/roles';
	import Empty from '$lib/components/Empty.svelte';
	import MetricTable from '$lib/components/MetricTable.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import {
		channelLabel,
		dateToIso,
		errorMessage,
		formatDay,
		queryString,
		statusLabel
	} from '$lib/helpers';
	import { getSessionContext } from '$lib/session';
	import type { Academy, Attendance, AttendanceChannel, DashboardSummary } from '$lib/types';
	import { onMount } from 'svelte';

	type AuditRow = {
		attendance_id: string;
		started_at: string;
		status: Attendance['status'];
		lead_name: string;
		whatsapp_e164: string;
		receptionist_name: string;
		professor_name?: string | null;
		label_snapshot?: string | null;
		amount_cents?: number | null;
		loss_reason?: string | null;
	};

	const { session } = getSessionContext();

	let academies = $state.raw<Academy[]>([]);
	let dashboard = $state.raw<DashboardSummary | null>(null);
	let auditRows = $state.raw<AuditRow[]>([]);
	let dashboardLoading = $state(false);
	let dashboardMessage = $state('');
	let dashboardFilter = $state({
		academyId: '',
		from: '',
		to: '',
		channel: '' as '' | AttendanceChannel
	});
	let activeAcademies = $derived(academies.filter((academy) => academy.active));
	let revenuePerVisit = $derived(
		dashboard?.kpi.attendances ? dashboard.kpi.revenue_cents / dashboard.kpi.attendances : 0
	);
	let revenuePerSale = $derived(
		dashboard?.kpi.converted ? dashboard.kpi.revenue_cents / dashboard.kpi.converted : 0
	);
	let timelineMax = $derived.by(() =>
		Math.max(1, ...(dashboard?.timeline ?? []).map((row) => row.attendances))
	);
	let timelinePoints = $derived.by(() =>
		(dashboard?.timeline ?? []).map((row, index, rows) => ({
			...row,
			x: rows.length === 1 ? 50 : (index / (rows.length - 1)) * 100,
			y: 36 - (row.attendances / timelineMax) * 30,
			height: Math.max(2, (row.attendances / timelineMax) * 30),
			label: formatDay(row.day)
		}))
	);
	let timelinePath = $derived(
		timelinePoints
			.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
			.join(' ')
	);

	onMount(() => {
		if (!session.user) return;
		if (!canAccessDashboard(session.user)) {
			void goto(resolve('/atendimento'), { replaceState: true });
			return;
		}
		void loadInitialData();
	});

	async function loadInitialData() {
		if (!session.user || !canAccessDashboard(session.user)) return;
		dashboardLoading = true;
		dashboardMessage = '';
		try {
			const academyData = await api<{ academies: Academy[] }>('/api/admin/academies');
			academies = academyData.academies;
			if (!dashboardFilter.academyId && activeAcademies.length === 1) {
				dashboardFilter.academyId = activeAcademies[0].id;
			}
			await loadDashboardSummary();
		} catch (error) {
			dashboardMessage = errorMessage(error);
		} finally {
			dashboardLoading = false;
		}
	}

	async function loadDashboard() {
		if (!session.user || !canAccessDashboard(session.user)) return;
		dashboardLoading = true;
		dashboardMessage = '';
		try {
			await loadDashboardSummary();
		} catch (error) {
			dashboardMessage = errorMessage(error);
		} finally {
			dashboardLoading = false;
		}
	}

	async function loadDashboardSummary() {
		const filter = queryString({
			academyId: dashboardFilter.academyId,
			from: dateToIso(dashboardFilter.from),
			to: dateToIso(dashboardFilter.to, true),
			channel: dashboardFilter.channel
		});
		const [summary, audit] = await Promise.all([
			api<DashboardSummary>(`/api/dashboard/summary${filter}`),
			api<{ rows: AuditRow[] }>(`/api/dashboard/audit${filter}`)
		]);
		if (!summary?.kpi || !Array.isArray(audit?.rows)) {
			throw new Error('Resposta inválida do dashboard.');
		}
		auditRows = audit.rows;
		dashboard = summary;
	}
</script>

<svelte:head>
	<title>Dashboard | Tracker de conversão</title>
</svelte:head>

{#if session.user && canAccessDashboard(session.user)}
	<section class="space-y-6">
		<div class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
			<div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
				<div>
					<h2 class="text-2xl font-bold text-slate-950">Dashboard</h2>
					<p class="text-slate-600">
						KPIs, evolução temporal, atribuição de conversão e auditoria.
					</p>
				</div>
				<form
					class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
					onsubmit={(event) => {
						event.preventDefault();
						void loadDashboard();
					}}
				>
					<label class="text-sm font-medium text-slate-700">
						Academia
						<select
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={dashboardFilter.academyId}
						>
							<option value="">Todas</option>
							{#each academies as academy (academy.id)}
								<option value={academy.id}>{academy.name}</option>
							{/each}
						</select>
					</label>
					<label class="text-sm font-medium text-slate-700">
						Canal
						<select
							class="mt-1 w-full rounded-2xl border-slate-300"
							bind:value={dashboardFilter.channel}
						>
							<option value="">Todos</option>
							<option value="PRESENCIAL">{channelLabel('PRESENCIAL')}</option>
							<option value="ONLINE">{channelLabel('ONLINE')}</option>
						</select>
					</label>
					<label class="text-sm font-medium text-slate-700">
						De
						<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							type="date"
							bind:value={dashboardFilter.from}
						/>
					</label>
					<label class="text-sm font-medium text-slate-700">
						Até
						<input
							class="mt-1 w-full rounded-2xl border-slate-300"
							type="date"
							bind:value={dashboardFilter.to}
						/>
					</label>
					<button
						class="self-end rounded-2xl bg-sky-600 px-5 py-3 font-bold text-white hover:bg-sky-700 disabled:opacity-60"
						type="submit"
						disabled={dashboardLoading}
					>
						{dashboardLoading ? 'Atualizando...' : 'Aplicar'}
					</button>
				</form>
			</div>
		</div>

		<Notice message={dashboardMessage} />

		<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
			<div class="rounded-3xl bg-slate-950 p-5 text-white shadow-sm">
				<p class="text-sm text-slate-300">Receita</p>
				<p class="mt-2 text-3xl font-bold">{money(dashboard?.kpi.revenue_cents)}</p>
			</div>
			<div class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<p class="text-sm text-slate-500">Taxa de conversão</p>
				<p class="mt-2 text-3xl font-bold text-emerald-600">
					{percent(dashboard?.kpi.conversionRate)}
				</p>
			</div>
			<div class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<p class="text-sm text-slate-500">Atendimentos</p>
				<p class="mt-2 text-3xl font-bold text-slate-950">{dashboard?.kpi.attendances ?? 0}</p>
			</div>
			<div class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<p class="text-sm text-slate-500">Convertidos</p>
				<p class="mt-2 text-3xl font-bold text-slate-950">{dashboard?.kpi.converted ?? 0}</p>
			</div>
			<div class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<p class="text-sm text-slate-500">Receita/visita</p>
				<p class="mt-2 text-3xl font-bold text-slate-950">{money(revenuePerVisit)}</p>
			</div>
			<div class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<p class="text-sm text-slate-500">Receita/venda</p>
				<p class="mt-2 text-3xl font-bold text-slate-950">{money(revenuePerSale)}</p>
			</div>
		</div>

		<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
			<div class="flex items-center justify-between">
				<h3 class="text-base font-semibold text-slate-900">Evolução temporal</h3>
				<span class="text-sm text-slate-500">Atendimentos por dia</span>
			</div>
			{#if timelinePoints.length}
				<div class="mt-5 grid gap-5 lg:grid-cols-[1.2fr_1fr]">
					<svg
						class="h-52 w-full overflow-visible rounded-2xl bg-slate-50 p-3"
						viewBox="0 0 100 40"
						role="img"
						aria-label="Linha de evolução de atendimentos"
					>
						<path
							d={timelinePath}
							fill="none"
							stroke="#0284c7"
							stroke-width="1.8"
							stroke-linecap="round"
						/>
						{#each timelinePoints as point (point.day)}
							<circle cx={point.x} cy={point.y} r="1.8" fill="#0284c7" />
						{/each}
					</svg>
					<div class="flex h-52 items-end gap-2 rounded-2xl bg-slate-50 p-4">
						{#each timelinePoints as point (point.day)}
							<div class="flex flex-1 flex-col items-center justify-end gap-2">
								<div
									class="w-full rounded-t-xl bg-sky-500"
									style:height={`${point.height * 5}px`}
									title={`${point.attendances} atendimentos`}
								></div>
								<span class="text-xs text-slate-500">{point.label}</span>
							</div>
						{/each}
					</div>
				</div>
			{:else}
				<Empty text="Sem evolução temporal para exibir." />
			{/if}
		</section>

		<div class="grid gap-6 xl:grid-cols-2">
			<MetricTable title="Recepcionistas" rows={dashboard?.receptionists ?? []} />
			<MetricTable title="Professores" rows={dashboard?.professors ?? []} />
		</div>

		<div class="grid gap-6 xl:grid-cols-2">
			<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<h3 class="text-base font-semibold text-slate-900">Duplas recepção + professor</h3>
				{#if dashboard?.pairs.length}
					<div class="mt-4 space-y-3">
						{#each dashboard.pairs as pair (`${pair.receptionist_name}-${pair.professor_name}`)}
							<div class="rounded-2xl border border-slate-200 p-4">
								<p class="font-semibold text-slate-900">
									{pair.receptionist_name} + {pair.professor_name}
								</p>
								<p class="mt-1 text-sm text-slate-600">
									{pair.converted}/{pair.attendances} conversões ({percent(pair.conversionRate)}) ·
									Professor global:
									{percent(pair.professor_global_conversion_rate)}
								</p>
								<p class="text-sm font-medium text-slate-900">{money(pair.revenue_cents)}</p>
							</div>
						{/each}
					</div>
				{:else}
					<Empty text="Sem duplas com professor no período." />
				{/if}
			</section>

			<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
				<h3 class="text-base font-semibold text-slate-900">Atribuição de fechamento</h3>
				{#if dashboard?.closers.length}
					<div class="mt-4 divide-y divide-slate-100">
						{#each dashboard.closers as closer (closer.id)}
							<div class="flex items-center justify-between gap-4 py-3">
								<div>
									<p class="font-semibold text-slate-900">{closer.name}</p>
									<p class="text-sm text-slate-500">{closer.sales} vendas fechadas</p>
								</div>
								<p class="font-bold text-slate-950">{money(closer.revenue_cents)}</p>
							</div>
						{/each}
					</div>
				{:else}
					<Empty text="Nenhuma venda atribuída ainda." />
				{/if}
			</section>
		</div>

		<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
			<h3 class="text-base font-semibold text-slate-900">Auditoria de atendimentos</h3>
			{#if auditRows.length}
				<div class="mt-4 overflow-x-auto">
					<table class="min-w-full text-left text-sm">
						<thead class="text-xs tracking-wide text-slate-500 uppercase">
							<tr>
								<th class="py-2 pr-4">Lead</th>
								<th class="py-2 pr-4">Recepção</th>
								<th class="py-2 pr-4">Professor</th>
								<th class="py-2 pr-4">Status</th>
								<th class="py-2 pr-4">Resultado</th>
								<th class="py-2">Abertura</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-slate-100">
							{#each auditRows as row (row.attendance_id)}
								<tr>
									<td class="py-3 pr-4 font-medium"
										>{row.lead_name}<br /><span class="text-xs text-slate-500"
											>{row.whatsapp_e164}</span
										></td
									>
									<td class="py-3 pr-4">{row.receptionist_name}</td>
									<td class="py-3 pr-4">{row.professor_name ?? '-'}</td>
									<td class="py-3 pr-4">{statusLabel(row.status)}</td>
									<td class="py-3 pr-4"
										>{row.label_snapshot ?? row.loss_reason ?? '-'}{row.amount_cents
											? ` · ${money(row.amount_cents)}`
											: ''}</td
									>
									<td class="py-3">{dateTime(row.started_at)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<Empty text="Nenhum atendimento auditável encontrado." />
			{/if}
		</section>
	</section>
{:else}
	<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
		<h2 class="text-2xl font-bold text-slate-950">Redirecionando...</h2>
		<p class="text-slate-600">Seu perfil não tem acesso ao dashboard.</p>
	</section>
{/if}
