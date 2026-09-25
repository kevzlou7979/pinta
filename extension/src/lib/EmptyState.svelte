<script lang="ts">
  // The one empty state — centred icon chip + title + hint, the Annotate
  // "Start annotating" pattern lifted into a shared shell so every tab's
  // "nothing here yet" looks the same. `children` renders full-width
  // below the hint (pickers, toggles, secondary buttons); `action` is the
  // primary CTA row. `compact` is the in-card / in-list variant.
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    hint?: string;
    /** Rich hint (inline <code>, <strong>) — same styling as `hint`. */
    richHint?: Snippet;
    icon?: Snippet;
    action?: Snippet;
    children?: Snippet;
    compact?: boolean;
    /** Element for the title — tab-level states keep the heading level
     *  their old markup had (h2 / h3) so the outline survives; in-card
     *  and list states stay a plain `p`. */
    heading?: "h2" | "h3" | "p";
    class?: string;
  };

  let {
    title,
    hint,
    richHint,
    icon,
    action,
    children,
    compact = false,
    heading = "p",
    class: cls = "",
  }: Props = $props();
</script>

<div
  class="pinta-empty-state flex flex-col items-center text-center {compact ? 'gap-2 px-4 py-7' : 'gap-3 px-6 py-12'} {cls}"
  data-compact={compact ? "true" : undefined}
>
  <div
    class="rounded-full bg-brand-pink/10 dark:bg-brand-pink-light/10 flex items-center justify-center text-brand-pink dark:text-brand-pink-light shrink-0 {compact ? 'w-10 h-10' : 'w-14 h-14'}"
    aria-hidden="true"
  >
    {#if icon}
      {@render icon()}
    {:else}
      <!-- Default: a static three-swatch paint fan, the loader at rest. -->
      <svg width={compact ? 18 : 24} height={compact ? 18 : 24} viewBox="14 14 112 90" fill="none" aria-hidden="true">
        <rect x="50" y="22" width="40" height="76" rx="10" fill="currentColor" opacity="0.35" transform="rotate(-34 70 92)" />
        <rect x="50" y="22" width="40" height="76" rx="10" fill="currentColor" opacity="0.65" />
        <rect x="50" y="22" width="40" height="76" rx="10" fill="currentColor" transform="rotate(34 70 92)" />
      </svg>
    {/if}
  </div>
  <div class="space-y-1 min-w-0 max-w-full">
    <svelte:element this={heading} class="{compact ? 'text-[13px]' : 'text-sm'} font-semibold text-ink-900 dark:text-night-text">{title}</svelte:element>
    {#if hint}
      <p class="text-[12px] text-ink-500 dark:text-night-mute leading-snug max-w-[240px] mx-auto">{hint}</p>
    {:else if richHint}
      <div class="text-[12px] text-ink-500 dark:text-night-mute leading-snug max-w-[240px] mx-auto">{@render richHint()}</div>
    {/if}
  </div>
  {#if children}
    <div class="w-full min-w-0 text-left">{@render children()}</div>
  {/if}
  {#if action}
    <div class="w-full min-w-0 flex flex-col items-center gap-2">{@render action()}</div>
  {/if}
</div>
