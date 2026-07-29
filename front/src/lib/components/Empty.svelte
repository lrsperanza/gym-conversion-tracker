<script lang="ts">
	let { text } = $props<{ text: string }>();
</script>

<p
	class="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500"
>
	{text}
</p>
