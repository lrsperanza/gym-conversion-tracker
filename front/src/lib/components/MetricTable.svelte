<script lang="ts">
	import { money, percent } from '$lib/api/client';
	import { formatDay } from '$lib/helpers';
	import type { MetricRow } from '$lib/types';
	import Empty from './Empty.svelte';

	let { title, rows } = $props<{ title: string; rows: MetricRow[] }>();

	function revenuePerVisit(row: MetricRow) {
		return row.attendances ? row.revenue_cents / row.attendances : 0;
	}

	function revenuePerSale(row: MetricRow) {
		return row.converted ? row.revenue_cents / row.converted : 0;
	}
</script>

<section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
	<h3 class="text-base font-semibold text-slate-900">{title}</h3>
	{#if rows.length}
		<div class="mt-4 overflow-x-auto">
			<table class="min-w-full text-left text-sm">
				<thead class="text-xs tracking-wide text-slate-500 uppercase">
					<tr>
						<th class="py-2 pr-4">Nome</th>
						<th class="py-2 pr-4">Atend.</th>
						<th class="py-2 pr-4">Conv.</th>
						<th class="py-2 pr-4">Taxa de conv.</th>
						<th class="py-2 pr-4">Receita</th>
						<th class="py-2 pr-4">Receita/visita</th>
						<th class="py-2">Receita/venda</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-slate-100">
					{#each rows as row ((row.id ?? row.name ?? row.day) + title)}
						<tr>
							<td class="py-3 pr-4 font-medium text-slate-800">{row.name ?? formatDay(row.day)}</td>
							<td class="py-3 pr-4">{row.attendances}</td>
							<td class="py-3 pr-4">{row.converted}</td>
							<td class="py-3 pr-4">
								<div class="h-2 w-24 rounded-full bg-slate-100">
									<div
										class="h-2 rounded-full bg-emerald-500"
										style:width={`${Math.max(4, row.conversionRate * 100)}%`}
									></div>
								</div>
								<span class="text-xs text-slate-500">{percent(row.conversionRate)}</span>
							</td>
							<td class="py-3 pr-4">{money(row.revenue_cents)}</td>
							<td class="py-3 pr-4">{money(revenuePerVisit(row))}</td>
							<td class="py-3">{money(revenuePerSale(row))}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<Empty text="Sem dados para este filtro." />
	{/if}
</section>
