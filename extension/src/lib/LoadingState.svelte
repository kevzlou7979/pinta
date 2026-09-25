<script lang="ts">
  // The one loading state — PaintLoader over a title + hint with the same
  // centred rhythm as EmptyState, so "working on it" and "nothing yet"
  // share one silhouette across every tab. `action` is the row under the
  // text (Cancel / Try another file). Root owns the status live region;
  // the fan inside is decorative so the wait is announced once.
  import type { Snippet } from "svelte";
  import PaintLoader from "./PaintLoader.svelte";

  type Props = {
    title: string;
    hint?: string;
    /** Rich hint (inline <code>) — same styling as `hint`. */
    richHint?: Snippet;
    action?: Snippet;
    /** md fan + tighter padding, for inside a card or list. */
    compact?: boolean;
    /** Element for the title — same contract as EmptyState. */
    heading?: "h2" | "h3" | "p";
    class?: string;
  };

  let { title, hint, richHint, action, compact = false, heading = "p", class: cls = "" }: Props = $props();
</script>

<div
  class="pinta-loading-state flex flex-col items-center text-center {compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-10'} {cls}"
  role="status"
  aria-live="polite"
  data-compact={compact ? "true" : undefined}
>
  <PaintLoader size={compact ? "md" : "lg"} decorative />
  <div class="space-y-1 min-w-0 max-w-full">
    <svelte:element this={heading} class="{compact ? 'text-[13px]' : 'text-sm'} font-semibold text-ink-900 dark:text-night-text">{title}</svelte:element>
    {#if hint}
      <p class="text-[12px] text-ink-500 dark:text-night-mute leading-snug max-w-[240px] mx-auto">{hint}</p>
    {:else if richHint}
      <div class="text-[12px] text-ink-500 dark:text-night-mute leading-snug max-w-[240px] mx-auto">{@render richHint()}</div>
    {/if}
  </div>
  {#if action}
    <div class="flex items-center justify-center gap-3 flex-wrap">{@render action()}</div>
  {/if}
</div>
