<script lang="ts">
  import { confirmService } from "../lib/confirm.svelte.js";
  const p = $derived(confirmService.pending);
</script>

{#if p}
  <div
    class="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
    role="button"
    tabindex="-1"
    aria-label="Dismiss"
    onclick={() => confirmService.answer(false)}
    onkeydown={(e) => e.key === "Escape" && confirmService.answer(false)}
  >
    <div
      class="w-full max-w-xs rounded-lg border border-ink-200 bg-white dark:border-night-line dark:bg-night-card shadow-2xl p-4 space-y-3"
      role="dialog"
      aria-modal="true"
      tabindex="0"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      {#if p.title}
        <h3 class="text-sm font-semibold text-ink-900 dark:text-night-text">{p.title}</h3>
      {/if}
      <p class="text-[13px] text-ink-600 dark:text-night-dim leading-snug whitespace-pre-line">
        {p.message}
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <button
          type="button"
          class="text-[13px] px-3 py-1.5 rounded-md border border-ink-200 dark:border-night-line text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt"
          onclick={() => confirmService.answer(false)}
        >
          {p.cancelLabel ?? "Cancel"}
        </button>
        <button
          type="button"
          class="text-[13px] font-medium px-3 py-1.5 rounded-md text-white {p.danger
            ? 'bg-red-600 hover:bg-red-700'
            : 'bg-brand-pink hover:bg-brand-magenta dark:hover:bg-brand-pink-light'}"
          onclick={() => confirmService.answer(true)}
        >
          {p.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </div>
  </div>
{/if}
