<script lang="ts">
	let { message = '' } = $props<{ message?: string }>();
</script>

{#if message}
	<p
		class="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-medium text-sky-900"
		aria-live="polite"
	>
		{message}
	</p>
{/if}
