<script lang="ts">
  // Phase 19 — generic tab for an imported INTERACTIVE module. Everything
  // here is data-driven: the tab's label/icon/action come from the
  // module manifest's `tab`, and the rendered board comes from the
  // ModuleBoard the module's agent returns. No plugin-specific code — the
  // Workflow Tasks module and any future board-style plugin share this
  // exact renderer.
  import type { ModuleSpec } from "../lib/modules.js";
  import type { ModuleBoardCard } from "@pinta/shared";
  import { app } from "../lib/state.svelte.js";

  type Props = { spec: ModuleSpec };
  let { spec }: Props = $props();

  const tab = $derived(spec.tab!);
  const slot = $derived(app.moduleBoards[spec.id]);
  const board = $derived(slot?.board ?? null);
  const pending = $derived(slot?.pending ?? null);
  const error = $derived(slot?.error ?? null);

  let view = $state<"featured" | "board">("featured");
  let openCard = $state<string | null>(null);

  // Default to the featured list when the board declares one (e.g. the
  // Workflow module's "today" pickups); else show the full board. Recompute
  // only when a fresh board lands so a manual view switch sticks.
  let lastGen = $state<number | null>(null);
  $effect(() => {
    if (!board) return;
    if (board.generatedAt === lastGen) return;
    lastGen = board.generatedAt;
    view = board.featured && board.featured.length ? "featured" : "board";
    openCard = null;
  });

  const hasFeatured = $derived(!!board?.featured && board.featured.length > 0);

  function run(): void {
    void app.runModuleOp(spec.id, tab.op ?? "list");
  }
  function groupColor(id: string): string {
    return board?.groups.find((g) => g.id === id)?.color ?? "#64748b";
  }
  function groupIndex(id: string): number {
    return board?.groups.findIndex((g) => g.id === id) ?? 0;
  }
  function featuredCards(): ModuleBoardCard[] {
    if (!board) return [];
    if (!board.featured || !board.featured.length) return board.cards;
    const order = new Map(board.featured.map((id, i) => [id, i] as const));
    return board.cards
      .filter((c) => order.has(c.id))
      .sort((a, b) => (order.get(a.id)! - order.get(b.id)!));
  }
  function cardsInGroup(gid: string): ModuleBoardCard[] {
    return board
      ? board.cards
          .filter((c) => c.group === gid)
          .sort((a, b) => Number(b.highlight) - Number(a.highlight))
      : [];
  }
  function fmtTime(ms: number): string {
    try {
      return new Date(ms).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }
</script>

{#snippet cardRow(c: ModuleBoardCard)}
  {@const gi = groupIndex(c.group)}
  {@const col = groupColor(c.group)}
  <div
    class="rounded-lg border bg-white dark:bg-night-alt overflow-hidden transition-colors"
    class:border-ink-200={!c.highlight}
    class:dark:border-night-line={!c.highlight}
    style={c.highlight ? `border-color:${col}` : ""}
  >
    <button
      type="button"
      class="w-full flex items-center gap-2 px-3 py-2 text-left"
      onclick={() => (openCard = openCard === c.id ? null : c.id)}
    >
      <span
        class="shrink-0 w-2.5 h-2.5 rounded-full"
        style={`background:${col}`}
      ></span>
      <span class="shrink-0 text-[11px] tabular-nums text-ink-400 dark:text-night-mute"
        >{c.id}</span
      >
      <span
        class="flex-1 min-w-0 truncate text-[13px] font-medium text-ink-900 dark:text-night-text"
        >{c.title}</span
      >
      {#if c.badge}
        <span
          class="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full text-white"
          style={`background:${col}`}>{c.badge}</span
        >
      {/if}
      <span
        class="shrink-0 text-ink-400 dark:text-night-mute transition-transform"
        class:rotate-90={openCard === c.id}>&#8250;</span
      >
    </button>
    {#if openCard === c.id}
      <div class="px-3 pb-3 border-t border-ink-100 dark:border-night-line">
        <!-- Stage trace: one dot per group, current = this card's group -->
        {#if board}
          <div class="flex items-center mt-3 mb-2">
            {#each board.groups as g, i}
              <div class="flex-1 flex flex-col items-center gap-1 relative">
                {#if i > 0}
                  <div
                    class="absolute top-[7px] -left-1/2 w-full h-0.5"
                    style={`background:${i <= gi ? col : "var(--tw-prose-hr,#cbd5e1)"}`}
                  ></div>
                {/if}
                <div
                  class="w-4 h-4 rounded-full border-2 z-10 bg-white dark:bg-night-alt"
                  style={i <= gi
                    ? `background:${col};border-color:${col}`
                    : "border-color:#cbd5e1"}
                  class:ring-4={i === gi}
                ></div>
                <div
                  class="text-[9px] uppercase tracking-wide"
                  class:font-bold={i === gi}
                  class:text-ink-700={i === gi}
                  class:dark:text-night-text={i === gi}
                  class:text-ink-400={i !== gi}
                  class:dark:text-night-mute={i !== gi}
                >
                  {g.name}
                </div>
              </div>
            {/each}
          </div>
        {/if}
        <div class="flex flex-wrap items-center gap-1.5 mt-2">
          {#if c.subtitle}
            <span class="text-[11px] text-ink-500 dark:text-night-mute"
              >{c.subtitle}</span
            >
          {/if}
          {#each c.tags ?? [] as t}
            <span
              class="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-100 text-ink-600 dark:bg-night-line dark:text-night-dim"
              >{t}</span
            >
          {/each}
        </div>
        {#if c.meta}
          <dl class="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5">
            {#each Object.entries(c.meta) as [k, v]}
              <dt class="text-[11px] text-ink-400 dark:text-night-mute">{k}</dt>
              <dd class="text-[11px] text-ink-700 dark:text-night-dim">{v}</dd>
            {/each}
          </dl>
        {/if}
        {#if c.url}
          <a
            href={c.url}
            target="_blank"
            rel="noopener"
            class="inline-flex items-center gap-1.5 mt-3 text-[12px] font-semibold text-brand-pink dark:text-brand-pink-light border border-ink-200 dark:border-night-line rounded-md px-2.5 py-1 hover:border-brand-pink"
          >
            {tab.cardActionLabel ?? "Open"} &#8594;
          </a>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<section class="space-y-3">
  {#if error}
    <div
      class="rounded-md border border-red-300 dark:border-red-800/50 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 text-[12px] px-3 py-2 flex items-start justify-between gap-2"
    >
      <span class="leading-snug">{error}</span>
      <button
        type="button"
        class="shrink-0 underline"
        onclick={() => (app.moduleBoards[spec.id]!.error = null)}>dismiss</button
      >
    </div>
  {/if}

  {#if pending}
    <!-- Running -->
    <div
      class="rounded-lg border border-brand-pink/30 bg-brand-pink/5 dark:bg-brand-pink/10 p-4 flex items-center gap-3"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="animate-spin text-brand-pink"
        ><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg
      >
      <div class="flex-1 text-[13px] text-ink-700 dark:text-night-text">
        Running {tab.name}… the agent is gathering your tasks.
      </div>
      <button
        type="button"
        class="text-[12px] text-ink-500 dark:text-night-mute underline"
        onclick={() => app.cancelModuleOp(spec.id)}>Cancel</button
      >
    </div>
  {:else if !board}
    <!-- Empty state: the manifest-declared primary action -->
    <div
      class="rounded-xl border border-ink-200 dark:border-night-line bg-white dark:bg-night-alt px-5 py-10 flex flex-col items-center text-center gap-3"
    >
      <h2 class="text-base font-semibold text-ink-900 dark:text-night-text">
        {tab.name}
      </h2>
      {#if spec.description}
        <p class="text-[12px] text-ink-500 dark:text-night-mute max-w-[42ch]">
          {spec.description}
        </p>
      {/if}
      <button
        type="button"
        class="mt-1 inline-flex items-center gap-2 rounded-xl bg-brand-pink hover:bg-brand-magenta dark:hover:bg-brand-pink-light text-white text-sm font-semibold px-5 py-3"
        onclick={run}
      >
        {tab.actionLabel ?? `Run ${tab.name}`} &#8594;
      </button>
      {#if tab.actionHint}
        <p class="text-[11px] text-ink-400 dark:text-night-mute">
          {tab.actionHint}
        </p>
      {/if}
    </div>
  {:else}
    <!-- Board header -->
    <header class="flex items-center gap-2 flex-wrap">
      <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">
        {board.title ?? tab.name}
      </h2>
      <span class="text-[11px] text-ink-400 dark:text-night-mute"
        >updated {fmtTime(board.generatedAt)}</span
      >
      <span class="flex-1"></span>
      {#if hasFeatured}
        <div
          class="inline-flex rounded-lg border border-ink-200 dark:border-night-line p-0.5"
        >
          <button
            type="button"
            class="px-2.5 py-1 rounded-md text-[12px] font-semibold"
            class:bg-ink-100={view === "featured"}
            class:dark:bg-night-line={view === "featured"}
            class:text-ink-400={view !== "featured"}
            onclick={() => (view = "featured")}>Today</button
          >
          <button
            type="button"
            class="px-2.5 py-1 rounded-md text-[12px] font-semibold"
            class:bg-ink-100={view === "board"}
            class:dark:bg-night-line={view === "board"}
            class:text-ink-400={view !== "board"}
            onclick={() => (view = "board")}>Board</button
          >
        </div>
      {/if}
      <button
        type="button"
        class="text-[12px] font-semibold text-brand-pink dark:text-brand-pink-light"
        onclick={run}>Refresh</button
      >
    </header>

    {#if view === "featured"}
      <div class="space-y-2">
        {#if featuredCards().length === 0}
          <div
            class="rounded-lg border border-dashed border-ink-200 dark:border-night-line text-[12px] text-ink-400 dark:text-night-mute text-center py-7"
          >
            Nothing to pick up right now. Nice and clear.
          </div>
        {:else}
          {#each featuredCards() as c (c.id)}
            {@render cardRow(c)}
          {/each}
        {/if}
      </div>
    {:else}
      <div class="flex gap-3 overflow-x-auto pb-2">
        {#each board.groups as g (g.id)}
          <section
            class="shrink-0 w-[210px] rounded-xl border border-ink-200 dark:border-night-line bg-ink-50/50 dark:bg-night-alt/40"
          >
            <h3
              class="flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide border-b border-ink-200 dark:border-night-line"
            >
              <span style={`color:${g.color ?? "inherit"}`}>{g.name}</span>
              <span class="text-ink-400 dark:text-night-mute"
                >{cardsInGroup(g.id).length}</span
              >
            </h3>
            <div class="p-2 space-y-2 min-h-[24px]">
              {#each cardsInGroup(g.id) as c (c.id)}
                {@render cardRow(c)}
              {/each}
            </div>
          </section>
        {/each}
      </div>
    {/if}
  {/if}
</section>
