<script lang="ts">
  // Reusable numbered step-timeline renderer (Phase 16g). Extracted from
  // TestPilotTab's detail view so the Report module's "How to test" guide
  // renders steps identically — text / inline code / bold, fenced code
  // blocks (with copy), `> Note:` callouts, bullet + numbered lists,
  // headings, and pipe-tables. Each step is step-markdown parsed via
  // `parseStep`.
  import { parseStep } from "../lib/step-md.js";
  import { highlight } from "../lib/prism-setup.js";

  let { steps }: { steps: string[] } = $props();

  // Which fenced code block last had its Copy clicked (keyed by a stable
  // per-block index) — drives the transient "Copied" label.
  let copiedBlock = $state<number | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  async function copyCode(key: number, body: string) {
    try {
      await navigator.clipboard.writeText(body);
      copiedBlock = key;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copiedBlock = null), 1800);
    } catch {
      // Clipboard not permitted — silently no-op (text is still visible).
    }
  }
</script>

<ol class="relative">
  {#each steps as step, i}
    {@const blocks = parseStep(step)}
    <li class="relative flex gap-3 pb-5 last:pb-0">
      <!-- Numbered circle + connecting line -->
      <div class="relative shrink-0 flex flex-col items-center">
        <div class="w-6 h-6 rounded-full border border-ink-300 dark:border-night-line bg-white dark:bg-night-card text-ink-500 dark:text-night-dim text-[11px] font-semibold inline-flex items-center justify-center z-10">
          {i + 1}
        </div>
        {#if i < steps.length - 1}
          <div class="absolute top-6 bottom-0 w-px bg-ink-200 dark:bg-night-line"></div>
        {/if}
      </div>
      <!-- Step content (text, code blocks, callouts) -->
      <div class="flex-1 min-w-0 space-y-2 pt-0.5 pb-1">
        {#each blocks as block, bi (bi)}
          {#if block.kind === "text"}
            <p class="text-[12.5px] text-ink-800 dark:text-night-text leading-relaxed">
              {#each block.parts as part, pi (pi)}
                {#if part.kind === "code"}
                  <code class="font-mono text-[11px] bg-ink-100 dark:bg-night-alt text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                {:else if part.kind === "bold"}
                  <strong class="font-semibold text-ink-900 dark:text-night-text">{part.value}</strong>
                {:else}
                  <span>{part.value}</span>
                {/if}
              {/each}
            </p>
          {:else if block.kind === "code"}
            <div class="rounded-lg overflow-hidden border border-ink-200 dark:border-night-line bg-ink-50 dark:bg-night-alt/60">
              <div class="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute border-b border-ink-200 dark:border-night-line">
                <span>{block.lang || "code"}</span>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 text-[10px] hover:text-brand-pink dark:hover:text-brand-pink-light normal-case tracking-normal font-medium"
                  onclick={() => copyCode(bi + i * 1000, block.body)}
                  title="Copy to clipboard"
                >
                  {#if copiedBlock === bi + i * 1000}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    Copied
                  {:else}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    Copy
                  {/if}
                </button>
              </div>
              <div class="pinta-code px-3 py-2 text-[11px] leading-relaxed overflow-x-auto"><pre><code class="font-mono">{@html highlight(block.body, block.lang)}</code></pre></div>
            </div>
          {:else if block.kind === "note"}
            <div class="border-l-2 border-ink-300 dark:border-night-line pl-3 py-1 text-[12px] text-ink-600 dark:text-night-dim leading-relaxed">
              <span class="font-semibold text-ink-800 dark:text-night-text">Note:</span>
              {#each block.parts as part, pi (pi)}
                {#if part.kind === "code"}
                  <code class="font-mono text-[11px] bg-ink-100 dark:bg-night-alt text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                {:else if part.kind === "bold"}
                  <strong class="font-semibold text-ink-800 dark:text-night-text">{part.value}</strong>
                {:else}
                  <span>{part.value}</span>
                {/if}
              {/each}
            </div>
          {:else if block.kind === "list"}
            <svelte:element
              this={block.ordered ? "ol" : "ul"}
              class="text-[12.5px] text-ink-800 dark:text-night-text pl-5 space-y-1.5 leading-relaxed {block.ordered ? 'list-decimal' : 'list-disc'} marker:text-ink-400 dark:marker:text-night-mute"
            >
              {#each block.items as item, ii (ii)}
                <li>
                  {#each item as part, pi (pi)}
                    {#if part.kind === "code"}
                      <code class="font-mono text-[11px] bg-ink-100 dark:bg-night-alt text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                    {:else if part.kind === "bold"}
                      <strong class="font-semibold text-ink-900 dark:text-night-text">{part.value}</strong>
                    {:else}
                      <span>{part.value}</span>
                    {/if}
                  {/each}
                </li>
              {/each}
            </svelte:element>
          {:else if block.kind === "heading"}
            <svelte:element
              this={`h${Math.min(block.level + 2, 6)}`}
              class="font-bold text-ink-900 dark:text-night-text mt-1 leading-tight {block.level === 1 ? 'text-[14px]' : block.level === 2 ? 'text-[13.5px]' : 'text-[13px]'}"
            >
              {#each block.parts as part, pi (pi)}
                {#if part.kind === "code"}
                  <code class="font-mono text-[11px] bg-ink-100 dark:bg-night-alt text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                {:else if part.kind === "bold"}
                  <strong class="font-bold">{part.value}</strong>
                {:else}
                  <span>{part.value}</span>
                {/if}
              {/each}
            </svelte:element>
          {:else if block.kind === "table"}
            <div class="rounded-md overflow-x-auto border border-ink-200 dark:border-night-line bg-white dark:bg-night-card/60 max-w-full">
              <table class="text-[11.5px] leading-snug w-full">
                <thead class="bg-ink-50 dark:bg-night-bg/60 border-b border-ink-200 dark:border-night-line">
                  <tr>
                    {#each block.headers as cell, ci (ci)}
                      <th class="text-left font-semibold text-ink-700 dark:text-night-text px-2.5 py-1.5 whitespace-nowrap">
                        {#each cell as part, pi (pi)}
                          {#if part.kind === "code"}
                            <code class="font-mono text-[11px] bg-ink-100 dark:bg-night-alt text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                          {:else if part.kind === "bold"}
                            <strong class="font-bold">{part.value}</strong>
                          {:else}
                            <span>{part.value}</span>
                          {/if}
                        {/each}
                      </th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each block.rows as row, ri (ri)}
                    <tr class="border-t border-ink-100 dark:border-night-line/60">
                      {#each row as cell, ci (ci)}
                        <td class="px-2.5 py-1.5 text-ink-800 dark:text-night-text align-top">
                          {#each cell as part, pi (pi)}
                            {#if part.kind === "code"}
                              <code class="font-mono text-[11px] bg-ink-100 dark:bg-night-alt text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                            {:else if part.kind === "bold"}
                              <strong class="font-semibold">{part.value}</strong>
                            {:else}
                              <span>{part.value}</span>
                            {/if}
                          {/each}
                        </td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        {/each}
      </div>
    </li>
  {/each}
</ol>
