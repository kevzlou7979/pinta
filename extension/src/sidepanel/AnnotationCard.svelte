<script lang="ts">
  import type { Annotation } from "@pinta/shared";

  let {
    annotation,
    onremove,
  }: { annotation: Annotation; onremove: () => void } = $props();
</script>

<li
  class="rounded-md border border-ink-200 bg-white p-3 text-sm space-y-1.5 shadow-sm"
>
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5 text-[11px] text-ink-500">
        <span class="uppercase tracking-wide font-medium">{annotation.kind}</span>
        {#if annotation.target?.selector}
          <span class="truncate font-mono">{annotation.target.selector}</span>
        {/if}
      </div>
      <p class="text-ink-900 mt-1">{annotation.comment}</p>
    </div>
    <button
      type="button"
      class="text-ink-400 hover:text-red-600 text-xs"
      onclick={onremove}
      aria-label="Remove annotation"
    >
      Remove
    </button>
  </div>
</li>
