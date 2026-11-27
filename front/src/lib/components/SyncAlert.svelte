<script lang="ts">
	import { dateTime, money } from '$lib/api/client';
	import type { SyncHealth } from '$lib/types';

	let { sync } = $props<{ sync?: SyncHealth | null }>();
</script>

{#if sync && !sync.ok}
	<div
		class="rounded-3xl border border-rose-300 bg-rose-50 p-5 text-rose-900 shadow-sm"
		role="alert"
	>
		<p class="text-base font-bold">
			Falha na conferência com o EVO: receita e rankings estão incompletos
		</p>
		<p class="mt-1 text-sm">
			Vendas não conferidas ficam fora da receita até a conferência voltar a rodar.
			{#if sync.overdue.sales > 0}
				Hoje faltam <strong>{sync.overdue.sales} vendas ({money(sync.overdue.amount_cents)})</strong
				>, a mais antiga lançada em {dateTime(sync.overdue.oldest)}.
			{/if}
		</p>
		<ul class="mt-2 list-disc space-y-0.5 pl-5 text-sm">
			{#each sync.problems as problem (problem)}
				<li>{problem}</li>
			{/each}
		</ul>
		<p class="mt-2 text-xs text-rose-800/80">
			Última conferência bem-sucedida: {sync.lastSuccessAt
				? dateTime(sync.lastSuccessAt)
				: 'nenhuma registrada'}
			{#if sync.lastRun}
				· última tentativa: {dateTime(sync.lastRun.started_at)}
			{/if}
		</p>
	</div>
{:else if sync?.warnings.length}
	<div
		class="rounded-3xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
		role="status"
	>
		{#each sync.warnings as warning (warning)}
			<p>{warning}</p>
		{/each}
	</div>
{/if}
