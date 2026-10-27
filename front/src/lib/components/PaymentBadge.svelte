<script lang="ts">
	import { paymentStatusLabel } from '$lib/helpers';
	import type { SalePaymentStatus } from '$lib/types';

	let { status, title }: { status?: SalePaymentStatus | null; title?: string | null } = $props();

	const styles: Record<SalePaymentStatus, string> = {
		A_CONFERIR: 'bg-slate-100 text-slate-600 ring-slate-200',
		PAGO: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
		PAGAMENTO_PENDENTE: 'bg-amber-50 text-amber-700 ring-amber-200',
		NAO_PAGO: 'bg-rose-50 text-rose-700 ring-rose-200'
	};
</script>

{#if status}
	<span
		class="rounded-full px-2 py-0.5 text-xs font-semibold ring-1 {styles[status]}"
		title={title ?? undefined}>{paymentStatusLabel(status)}</span
	>
{/if}
