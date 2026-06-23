<script lang="ts">
  // Phase 19 — generic tab for an imported INTERACTIVE module. Everything
  // here is data-driven: the tab's label/icon/action come from the
  // module manifest's `tab`, and the rendered board comes from the
  // ModuleBoard the module's agent returns. No plugin-specific code — the
  // Workflow Tasks module and any future board-style plugin share this
  // exact renderer.
  import type { ModuleSpec } from "../lib/modules.js";
  import type {
    ModuleBoardCard,
    ModuleBoardCardAction,
    ModuleBoardGroup,
  } from "@pinta/shared";
  import { app } from "../lib/state.svelte.js";

  type Props = {
    spec: ModuleSpec;
    /** Switch the side panel to the Test Pilot tab — passed by App.svelte so
     *  a client-side handoff (e.g. "Add to Test Pilot") can offer a jump. */
    onOpenTestPilot?: () => void;
  };
  let { spec, onOpenTestPilot }: Props = $props();

  const tab = $derived(spec.tab!);
  const slot = $derived(app.moduleBoards[spec.id]);
  const board = $derived(slot?.board ?? null);
  const pending = $derived(slot?.pending ?? null);
  const error = $derived(slot?.error ?? null);

  let view = $state<"featured" | "board">("featured");
  // Which card + action is mid-flight, so we spinner ONLY that button and
  // suppress the full-width board banner for per-card actions. Set in
  // runCardAction, reset by run() (a board-level refresh); always gated on
  // `pending` in the markup so a stale id never shows once the op resolves.
  let pendingCardId = $state<string | null>(null);
  let pendingActionId = $state<string | null>(null);
  // A board-level header action (e.g. "End Day") mid-flight → spinner just
  // that header button and suppress the full-width refresh banner.
  let pendingBoardActionId = $state<string | null>(null);
  // Transient confirmation for a client-side handoff (e.g. "Added to Test
  // Pilot → <today>"). Shown as a dismissible notice above the board.
  let notice = $state<string | null>(null);

  // Default to the featured list when the board declares one (e.g. the
  // Workflow module's "today" pickups); else show the full board. Recompute
  // only when a fresh board lands so a manual view switch sticks.
  let lastGen = $state<number | null>(null);
  $effect(() => {
    if (!board) return;
    if (board.generatedAt === lastGen) return;
    lastGen = board.generatedAt;
    // Featured view when the board declares pickups OR any group opts into a
    // labelled section; otherwise the full board (flat-board back-compat).
    const hasSections = board.groups.some((g) => g.featuredSection);
    view =
      (board.featured && board.featured.length) || hasSections
        ? "featured"
        : "board";
    notice = null;
  });

  // The board headline arrives as a single composite string with the active
  // filter appended after a "·" separator (e.g. "Today · domain:client"). Split
  // it so the first segment stays the heading and each trailing segment renders
  // as its own filter badge on the line below the title.
  const headline = $derived.by(() => {
    const raw = board?.title ?? tab.name;
    const segs = raw.split("·").map((s) => s.trim()).filter(Boolean);
    return { text: segs[0] ?? raw, badges: segs.slice(1) };
  });

  function run(): void {
    // Board-level refresh → full-width banner, not a card spinner.
    pendingCardId = null;
    pendingActionId = null;
    pendingBoardActionId = null;
    notice = null;
    void app.runModuleOp(spec.id, tab.op ?? "list");
  }
  function groupColor(id: string): string {
    return board?.groups.find((g) => g.id === id)?.color ?? "#64748b";
  }
  // Pick black/white text for a solid `hex` chip background by relative
  // luminance (WCAG-ish crossover at 0.179), so a status pill stays
  // readable on any group color — white-on-amber was failing in dark mode.
  function textOn(hex: string): string {
    const h = (hex || "").replace("#", "");
    const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    if (f.length < 6) return "#ffffff";
    const ch = (i: number) => {
      const c = parseInt(f.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
    return L > 0.179 ? "#0f172a" : "#ffffff";
  }
  // Groups that opt into the featured view as their own labelled section
  // (e.g. the tasks module's "Review" column), rendered below the pickups.
  function sectionGroups(): ModuleBoardGroup[] {
    return board ? board.groups.filter((g) => g.featuredSection) : [];
  }
  // A card's action buttons. Back-compat: a card carrying only `url` (older
  // boards) gets a single "open" deep-link so existing modules still work.
  function cardActions(c: ModuleBoardCard): ModuleBoardCardAction[] {
    if (c.actions && c.actions.length) return c.actions;
    if (c.url)
      return [{ id: "open", label: tab.cardActionLabel ?? "Open", url: c.url }];
    return [];
  }
  function actionClass(style?: string): string {
    const base =
      "inline-flex items-center gap-1.5 text-[12px] font-semibold rounded-md px-2.5 py-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
    if (style === "primary")
      return `${base} bg-brand-pink text-white hover:bg-brand-magenta dark:hover:bg-brand-pink-light`;
    if (style === "danger")
      return `${base} text-red-600 dark:text-red-400 border border-red-300 dark:border-red-800/60 hover:border-red-500`;
    return `${base} text-brand-pink dark:text-brand-pink-light border border-ink-200 dark:border-night-line hover:border-brand-pink`;
  }
  // Three card-action flavours: `op` round-trips to the agent (it performs
  // the action and returns a refreshed board), `clientOp` is handled in the
  // extension with no round-trip (e.g. "Add to Test Pilot"), and `url` is a
  // plain deep-link handled by the anchor.
  function runCardAction(c: ModuleBoardCard, a: ModuleBoardCardAction): void {
    if (a.confirm && !globalThis.confirm?.(a.confirm)) return;
    if (a.op) {
      // Per-card op → spinner just this button (see markup); no banner.
      pendingCardId = c.id;
      pendingActionId = a.id;
      void app.runModuleOp(spec.id, a.op, c.id);
      return;
    }
    if (a.clientOp) {
      // Client-side handoff — instant, no pending state. Surface the result.
      notice = app.runModuleClientOp(a.clientOp, c).message;
    }
  }
  // Board-level header actions (e.g. "End Day") — like a card op but with no
  // card target: spinner the header button, keep the board visible.
  function runBoardAction(a: ModuleBoardCardAction): void {
    if (!a.op) return;
    if (a.confirm && !globalThis.confirm?.(a.confirm)) return;
    pendingCardId = null;
    pendingActionId = null;
    pendingBoardActionId = a.id;
    void app.runModuleOp(spec.id, a.op);
  }
  // Flat-card quick actions (Image #16 layout): a deep-link (GitLab) and the
  // card's primary op, surfaced on the row itself. Both derive from the
  // generic card data.
  function cardUrl(c: ModuleBoardCard): string | undefined {
    return c.url ?? c.actions?.find((a) => a.url)?.url;
  }
  function startAction(c: ModuleBoardCard): ModuleBoardCardAction | undefined {
    // Actionable = an agent `op` OR a client-side `clientOp` (a bare `url`
    // is a plain link, not the card's primary action). This is the card's
    // PRIMARY action for its current status — the module labels it per state
    // ("Triage" for new, "Start" for ready, "Add to Test Pilot" for review).
    // Prefer an explicitly primary-styled action; else the first one.
    const acts = (c.actions ?? []).filter((a) => a.op || a.clientOp);
    return acts.find((a) => a.style === "primary") ?? acts[0];
  }
  function featuredCards(): ModuleBoardCard[] {
    if (!board) return [];
    const sectionIds = new Set(sectionGroups().map((g) => g.id));
    if (!board.featured || !board.featured.length) {
      // No explicit pickups. With labelled sections present, the sections
      // carry every card -- show nothing on top. Without sections, fall back
      // to the full card list (flat-board back-compat).
      return sectionGroups().length ? [] : board.cards;
    }
    const order = new Map(board.featured.map((id, i) => [id, i] as const));
    return board.cards
      .filter((c) => order.has(c.id) && !sectionIds.has(c.group))
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

{#snippet actionButton(c: ModuleBoardCard, a: ModuleBoardCardAction)}
  {#if a.url}
    <a
      href={a.url}
      target="_blank"
      rel="noopener"
      class={actionClass(a.style)}
    >
      {a.label} &#8594;
    </a>
  {:else if a.op}
    <button
      type="button"
      class={actionClass(a.style)}
      disabled={!!pending}
      onclick={() => runCardAction(c, a)}
    >
      {#if pending && pendingCardId === c.id && pendingActionId === a.id}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
      {/if}
      {a.label}
    </button>
  {:else if a.clientOp}
    <button
      type="button"
      class={actionClass(a.style)}
      onclick={() => runCardAction(c, a)}
    >
      {a.label}
    </button>
  {/if}
{/snippet}

{#snippet cardRow(c: ModuleBoardCard)}
  {@const col = groupColor(c.group)}
  {@const url = cardUrl(c)}
  {@const start = startAction(c)}
  {@const moreActions = cardActions(c).filter((a) => (a.op || a.clientOp) && a.id !== start?.id)}
  <div
    class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-alt overflow-hidden"
  >
    <div class="flex items-start gap-2 px-3 py-2.5">
      <!-- Flat card: title / badge / #id (no click-to-expand) -->
      <div class="flex-1 min-w-0">
        <div
          class="text-[13.5px] font-semibold leading-snug text-ink-900 dark:text-night-text break-words"
        >
          {c.title}{#if url}<a
            href={url}
            target="_blank"
            rel="noopener"
            class="inline-flex items-center align-[-0.15em] ml-1 text-ink-400 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light"
            title="Open in GitLab"
            aria-label="Open in GitLab"
          ><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg></a>{/if}
        </div>
        {#if c.badge}
          <span
            class="inline-block mt-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full"
            style={`background:${col};color:${textOn(col)}`}>{c.badge}</span
          >
        {/if}
        <div class="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-400 dark:text-night-mute">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></svg>
          <span class="tabular-nums">{c.id}</span>
        </div>
      </div>
      <!-- Primary action (Start / Triage) — GitLab link sits after the title -->
      <div class="shrink-0 flex items-center gap-1">
        {#if start}
          <button
            type="button"
            class="inline-flex items-center gap-1 text-[11px] font-semibold rounded-md px-2 py-1 bg-brand-pink text-white hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50"
            disabled={!!pending}
            onclick={() => runCardAction(c, start)}
            title={start.label}
            aria-label={start.label}
          >
            {#if pending && pendingCardId === c.id && pendingActionId === start.id}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            {:else if start.id === "triage" || /triage/i.test(start.label)}
              <!-- Triage (new task) → clipboard-check, not the ▶ play glyph -->
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /><path d="m9 14 2 2 4-4" /></svg>
            {:else if start.clientOp === "add-to-test-pilot" || /test pilot/i.test(start.label)}
              <!-- Add to Test Pilot → beaker glyph (matches the Test Pilot tab) -->
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6M10 3v6.5L5 18a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-8.5V3" /></svg>
            {:else}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4" /></svg>
            {/if}
            {start.label}
          </button>
        {/if}
      </div>
    </div>
    {#if moreActions.length}
      <!-- Secondary ops live on the flat card too (no expand) -->
      <div class="px-3 pb-2.5 flex flex-wrap items-center gap-1.5">
        {#each moreActions as a (a.id)}
          {@render actionButton(c, a)}
        {/each}
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

  {#if notice}
    <div
      class="rounded-md border border-brand-pink/30 bg-brand-pink/5 dark:bg-brand-pink/10 text-[12px] px-3 py-2 flex items-center justify-between gap-2"
    >
      <span class="leading-snug text-ink-700 dark:text-night-text">{notice}</span>
      <div class="shrink-0 flex items-center gap-2">
        {#if onOpenTestPilot && app.moduleReady("test-pilot")}
          <button
            type="button"
            class="font-semibold text-brand-pink dark:text-brand-pink-light hover:underline"
            onclick={() => {
              notice = null;
              onOpenTestPilot?.();
            }}>Open Test Pilot &#8594;</button
          >
        {/if}
        <button
          type="button"
          class="text-ink-400 dark:text-night-mute hover:text-ink-700 dark:hover:text-night-text"
          aria-label="Dismiss"
          onclick={() => (notice = null)}>&#10005;</button
        >
      </div>
    </div>
  {/if}

  {#if pending && !pendingCardId && !pendingBoardActionId}
    <!-- Running — board-level refresh only. A per-card action (pendingCardId
         set) spinners its own button instead, leaving the board visible. -->
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
    <header class="space-y-1.5">
      <div class="flex items-center gap-2 flex-wrap">
        <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">
          {headline.text}
        </h2>
        <span class="text-[11px] text-ink-400 dark:text-night-mute"
          >updated {fmtTime(board.generatedAt)}</span
        >
        <span class="flex-1"></span>
        {#each tab.boardActions ?? [] as a (a.id)}
          {#if a.url}
            <a
              href={a.url}
              target="_blank"
              rel="noopener"
              class={actionClass(a.style)}>{a.label}</a
            >
          {:else if a.op}
            <button
              type="button"
              class={actionClass(a.style)}
              disabled={!!pending}
              onclick={() => runBoardAction(a)}
            >
              {#if pending && pendingBoardActionId === a.id}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
              {/if}
              {a.label}
            </button>
          {/if}
        {/each}
        <button
          type="button"
          class="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md text-brand-pink dark:text-brand-pink-light hover:bg-ink-100 dark:hover:bg-night-line transition-colors"
          title="Refresh"
          aria-label="Refresh"
          onclick={run}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>
      </div>
      {#if headline.badges.length}
        <div class="flex flex-wrap items-center gap-1.5">
          {#each headline.badges as b (b)}
            <span
              class="inline-flex items-center text-[10px] font-medium px-2 py-0.5 rounded-full bg-brand-pink/10 text-brand-pink dark:bg-brand-pink-light/10 dark:text-brand-pink-light"
              >{b}</span
            >
          {/each}
        </div>
      {/if}
    </header>

    {#if view === "featured"}
      {#if featuredCards().length}
        <div class="space-y-2">
          {#each featuredCards() as c (c.id)}
            {@render cardRow(c)}
          {/each}
        </div>
      {:else if !sectionGroups().length}
        <div
          class="rounded-lg border border-dashed border-ink-200 dark:border-night-line text-[12px] text-ink-400 dark:text-night-mute text-center py-7"
        >
          Nothing to pick up right now. Nice and clear.
        </div>
      {/if}

      <!-- Groups that opt into the featured view as their own section
           (e.g. Review): listed below the pickups, same expandable cards. -->
      {#each sectionGroups() as g (g.id)}
        <section class="space-y-2 pt-1">
          <h3
            class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide"
          >
            <span
              class="w-2 h-2 rounded-full"
              style={`background:${g.color ?? "#64748b"}`}
            ></span>
            <span style={`color:${g.color ?? "inherit"}`}>{g.name}</span>
            <span class="text-ink-400 dark:text-night-mute"
              >{cardsInGroup(g.id).length}</span
            >
          </h3>
          {#if cardsInGroup(g.id).length === 0}
            <div
              class="rounded-lg border border-dashed border-ink-200 dark:border-night-line text-[12px] text-ink-400 dark:text-night-mute text-center py-5"
            >
              Nothing in {g.name}.
            </div>
          {:else}
            {#each cardsInGroup(g.id) as c (c.id)}
              {@render cardRow(c)}
            {/each}
          {/if}
        </section>
      {/each}
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
