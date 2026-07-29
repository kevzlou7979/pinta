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
  import { confirmDialog } from "../lib/confirm.svelte.js";
  import StepList from "./StepList.svelte";

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

  // ── Per-card "how to test" steps (like Test Pilot's detail "?"). Shown
  // only when the module declares `tab.cardStepsOp`. Cached per card on the
  // board slot so a refresh keeps them; expanded state is local.
  const stepsOp = $derived(tab.cardStepsOp);
  const cardSteps = $derived(slot?.cardSteps ?? {});
  // Per-card maps now — several cards' beakers can run at once.
  const cardStepsPending = $derived(slot?.cardStepsPending ?? {});
  const cardStepsError = $derived(slot?.cardStepsError ?? {});
  // Group ids whose cards should NOT show the "how to test" beaker. The
  // module declares these in `tab.cardStepsExcludeGroups` (e.g. the tasks
  // module hides it on Review — those items are already being verified).
  const stepsExcludeGroups = $derived(new Set(tab.cardStepsExcludeGroups ?? []));
  function cardShowsSteps(c: ModuleBoardCard): boolean {
    return !!stepsOp && !stepsExcludeGroups.has(c.group);
  }
  let openSteps = $state<Set<string>>(new Set());

  function toggleSteps(c: ModuleBoardCard): void {
    const next = new Set(openSteps);
    if (next.has(c.id)) {
      next.delete(c.id);
    } else {
      next.add(c.id);
      // Fetch on first open (nothing cached, this card not already in flight).
      if (stepsOp && !cardSteps[c.id] && !cardStepsPending[c.id]) {
        void app.runModuleCardSteps(spec.id, stepsOp, {
          id: c.id,
          title: c.title,
          url: cardUrl(c),
        });
      }
    }
    openSteps = next;
  }
  function retrySteps(c: ModuleBoardCard): void {
    if (stepsOp && !cardStepsPending[c.id]) {
      void app.runModuleCardSteps(spec.id, stepsOp, {
        id: c.id,
        title: c.title,
        url: cardUrl(c),
      });
    }
  }

  // ── Per-step screenshots (Generate screenshots button) ──────────────
  const shotsOp = $derived(tab.cardStepsShotsOp);
  const cardShots = $derived(slot?.cardShots ?? {});
  const cardShotsPending = $derived(slot?.cardShotsPending ?? {});
  const cardShotsError = $derived(slot?.cardShotsError ?? {});

  function generateShots(c: ModuleBoardCard): void {
    const steps = cardSteps[c.id]?.steps ?? [];
    if (!shotsOp || cardShotsPending[c.id] || steps.length === 0) return;
    void app.runModuleCardShots(
      spec.id,
      shotsOp,
      { id: c.id, title: c.title, url: cardUrl(c) },
      steps,
    );
  }

  // ── Copy a card: "#id title" + description + link ───────────────────
  // One paste carries everything an agent / commit message / chat needs.
  let copiedCardId = $state<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  async function copyCard(c: ModuleBoardCard): Promise<void> {
    const lines = [`#${c.id} ${c.title}`.trim()];
    if (c.description?.trim()) lines.push(c.description.trim());
    const link = cardUrl(c);
    if (link) lines.push(link);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      copiedCardId = c.id;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copiedCardId = null), 1500);
    } catch {
      // Clipboard blocked (rare in a side panel) — silent no-op.
    }
  }

  // ── Section tabs ────────────────────────────────────────────────────
  // The featuredSection groups (Up Next / In Progress / Review / Done …)
  // render as a segmented tab bar so the user flips between them instead of
  // scrolling one long stack. A "Pickups" tab leads when the board declares
  // a featured list. Data-driven — whatever sections the board ships become
  // the tabs.
  const FEATURED_TAB = "__pickups__";
  let activeSection = $state<string | null>(null);

  const sectionTabs = $derived.by(() => {
    const tabs: { id: string; name: string; color?: string; count: number }[] = [];
    if (board?.featured && board.featured.length) {
      tabs.push({ id: FEATURED_TAB, name: "Pickups", count: featuredCards().length });
    }
    for (const g of sectionGroups()) {
      tabs.push({
        id: g.id,
        name: g.name,
        color: g.color,
        count: cardsInGroup(g.id).length,
      });
    }
    return tabs;
  });

  // Default / validate the active tab whenever the tab set changes. Keep the
  // user's pick if it still exists (even when it empties out on a refresh);
  // otherwise land on the first tab that has cards.
  $effect(() => {
    const tabs = sectionTabs;
    if (!tabs.length) {
      activeSection = null;
      return;
    }
    if (activeSection && tabs.some((t) => t.id === activeSection)) return;
    activeSection = (tabs.find((t) => t.count > 0) ?? tabs[0]!).id;
  });

  function activeTabCards(): ModuleBoardCard[] {
    if (activeSection === FEATURED_TAB) return featuredCards();
    if (activeSection) return cardsInGroup(activeSection);
    return [];
  }
  function activeTabName(): string {
    return sectionTabs.find((t) => t.id === activeSection)?.name ?? "";
  }

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

  // Confirm-gated actions (Complete, Move to review, End Day, batch Complete)
  // route through the shared in-panel modal (native confirm() is a silent
  // no-op inside Chrome side panels).
  function askConfirm(message: string, run: () => void): void {
    void confirmDialog({ message }).then((ok) => {
      if (ok) run();
    });
  }

  // ── Multi-start ────────────────────────────────────────────────────
  // Tick several cards, hit "Start" once. ALL ops are dispatched up-front
  // (state.runModuleOpBatch) so the agent sees the whole batch before its
  // start op hands the terminal off to real work; the single agent answers
  // them in dispatch order. `slot.batchRemaining` is the source of truth:
  // [0] is the card the agent is handling NOW (pulsing "Starting…"), the
  // rest are "Queued". Cards do NOT move groups until the agent actually
  // flips them — the module only flips the task it's about to work.
  let selectedIds = $state<Set<string>>(new Set());
  // How many cards the current batch started with — drives the progress text.
  let batchTotal = $state(0);
  const batchIds = $derived(slot?.batchRemaining ?? []);
  const batchActive = $derived(batchIds.length > 0);
  const batchLeft = $derived(batchIds.length);

  // The batch button's verb mirrors what the selected cards will actually
  // DO — their primary-action labels. All "Triage" picks → "Triage 4";
  // all "Start working" → "Start 4"; a mixed selection is honest about it
  // ("Run 4 actions") instead of pretending everything starts.
  const batchLabel = $derived.by(() => {
    if (!board) return `Start ${selectedIds.size}`;
    const byId = new Map(board.cards.map((c) => [c.id, c] as const));
    const labels = new Set<string>();
    for (const id of selectedIds) {
      const c = byId.get(id);
      const a = c ? startAction(c) : undefined;
      if (a?.op) labels.add(a.label);
    }
    const n = selectedIds.size;
    if (labels.size === 1) {
      // First word keeps the button tight ("Start working" → "Start").
      const word = [...labels][0]!.split(/\s+/)[0]!;
      return `${word} ${n}`;
    }
    return `Run ${n} action${n === 1 ? "" : "s"}`;
  });

  // A card is selectable when its primary action is an agent `op` (a bare
  // deep-link or a client-only handoff isn't a "start"). Selection is
  // frozen while a batch runs so the queue can't shift under us.
  function isSelectable(c: ModuleBoardCard): boolean {
    return !batchActive && !!startAction(c)?.op;
  }
  function isSelected(id: string): boolean {
    return selectedIds.has(id);
  }
  function toggleSelect(id: string): void {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
  }
  function clearSelection(): void {
    selectedIds = new Set();
  }
  // Card batch status: "starting" = the agent is on it now, "queued" =
  // dispatched, waiting its turn behind the current one.
  function batchStatus(id: string): "starting" | "queued" | null {
    const i = batchIds.indexOf(id);
    if (i === 0) return "starting";
    if (i > 0) return "queued";
    return null;
  }
  // Pulsing border: the card the agent is handling now, or one the agent
  // reports as actively being worked (`card.working`, agent-truth that
  // survives refreshes while a task is being coded).
  function isWorking(c: ModuleBoardCard): boolean {
    return batchStatus(c.id) === "starting" || !!c.working;
  }

  // Kick off a batch from the current selection. All ops dispatch at once;
  // slot.batchRemaining drives the per-card chips from here on. When any
  // selected card's action declares a `confirm` (e.g. Complete/approve),
  // ask ONCE for the whole batch — per-card dialogs would be noise, but
  // mass-completing with no prompt at all is a footgun.
  function startSelected(): void {
    if (!board || batchActive || pending) return;
    const byId = new Map(board.cards.map((c) => [c.id, c] as const));
    const items: { cardId: string; op: string }[] = [];
    let needsConfirm = false;
    const labels = new Set<string>();
    for (const id of selectedIds) {
      const c = byId.get(id);
      const a = c ? startAction(c) : undefined;
      if (a?.op) {
        items.push({ cardId: id, op: a.op });
        if (a.confirm) needsConfirm = true;
        labels.add(a.label);
      }
    }
    if (items.length === 0) return;
    const go = () => {
      clearSelection();
      notice = null;
      batchTotal = items.length;
      void app.runModuleOpBatch(spec.id, items);
    };
    if (needsConfirm) {
      const verb = labels.size === 1 ? [...labels][0]! : "Run the actions of";
      askConfirm(
        `${verb} ${items.length} selected task${items.length === 1 ? "" : "s"}?`,
        go,
      );
      return;
    }
    go();
  }

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
    // A refreshed board may have dropped cards the user had ticked (e.g. one
    // just started + moved groups). Prune the selection to what still exists
    // so the "Start N" count can't outlive its cards.
    if (selectedIds.size) {
      const live = new Set(board.cards.map((c) => c.id));
      const next = new Set([...selectedIds].filter((id) => live.has(id)));
      if (next.size !== selectedIds.size) selectedIds = next;
    }
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
  function doCardAction(c: ModuleBoardCard, a: ModuleBoardCardAction): void {
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
  function runCardAction(c: ModuleBoardCard, a: ModuleBoardCardAction): void {
    if (a.confirm) {
      askConfirm(a.confirm, () => doCardAction(c, a));
      return;
    }
    doCardAction(c, a);
  }
  // Board-level header actions (e.g. "End Day") — like a card op but with no
  // card target: spinner the header button, keep the board visible.
  function runBoardAction(a: ModuleBoardCardAction): void {
    if (!a.op) return;
    const go = () => {
      pendingCardId = null;
      pendingActionId = null;
      pendingBoardActionId = a.id;
      void app.runModuleOp(spec.id, a.op!);
    };
    if (a.confirm) {
      askConfirm(a.confirm, go);
      return;
    }
    go();
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
  {@const bstat = batchStatus(c.id)}
  <div
    class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-alt overflow-hidden"
    class:pinta-card-working={isWorking(c)}
  >
    <div class="flex items-start gap-2 px-3 py-2.5">
      <!-- Multi-start select box (only for cards whose primary action is an
           agent op; frozen while a batch runs). -->
      {#if isSelectable(c)}
        <label class="shrink-0 pt-0.5 cursor-pointer" title="Select to start">
          <input
            type="checkbox"
            class="w-4 h-4 accent-brand-pink cursor-pointer"
            checked={isSelected(c.id)}
            onchange={() => toggleSelect(c.id)}
            aria-label={`Select ${c.title}`}
          />
        </label>
      {/if}
      <!-- Flat card: one line — #id · title · link · status badge at the end -->
      <div class="flex-1 min-w-0">
        <div
          class="text-[13.5px] font-semibold leading-snug text-ink-900 dark:text-night-text break-words"
        >
          <span class="text-ink-400 dark:text-night-mute font-normal tabular-nums">#{c.id}</span>
          {#if c.badge}
            <span
              class="inline-block align-middle mx-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full"
              style={`background:${col};color:${textOn(col)}`}>{c.badge}</span
            >
          {/if}
          {c.title}{#if url}<a
            href={url}
            target="_blank"
            rel="noopener"
            class="inline-flex items-center align-[-0.15em] ml-1 text-ink-400 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light"
            title="Open in GitLab"
            aria-label="Open in GitLab"
          ><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg></a>{/if}
        </div>
        {#if bstat || c.working}
          <div class="mt-1.5 flex items-center gap-1.5 flex-wrap">
            {#if bstat === "starting"}
              <span class="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-brand-pink text-white">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                Starting…
              </span>
            {:else if bstat === "queued"}
              <span class="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border border-brand-pink/50 text-brand-pink dark:text-brand-pink-light">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Queued
              </span>
            {:else if c.working}
              <span class="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-brand-pink text-white">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                Agent working
              </span>
            {/if}
          </div>
        {/if}
      </div>
      <!-- Primary action (Start / Triage) — GitLab link sits after the title -->
      <div class="shrink-0 flex items-center gap-1">
        <!-- Copy: #id · title (+ description) · link — paste into a chat / commit -->
        <button
          type="button"
          class="inline-flex items-center justify-center w-7 h-7 rounded-md border border-ink-200 dark:border-night-line text-ink-500 dark:text-night-mute hover:text-brand-pink hover:border-brand-pink dark:hover:text-brand-pink-light transition-colors"
          class:text-brand-pink={copiedCardId === c.id}
          onclick={() => copyCard(c)}
          title="Copy id, description and link"
          aria-label="Copy id, description and link"
        >
          {#if copiedCardId === c.id}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
          {:else}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          {/if}
        </button>
        {#if cardShowsSteps(c)}
          <!-- "How to test" — beaker icon, mirrors Test Pilot's detail steps.
               Turns primary once its steps have been fetched. -->
          <button
            type="button"
            class="inline-flex items-center justify-center w-7 h-7 rounded-md border border-ink-200 dark:border-night-line text-ink-500 dark:text-night-mute hover:text-brand-pink hover:border-brand-pink dark:hover:text-brand-pink-light transition-colors disabled:opacity-50"
            class:text-brand-pink={openSteps.has(c.id) || !!cardSteps[c.id]}
            class:border-brand-pink={!!cardSteps[c.id]}
            onclick={() => toggleSteps(c)}
            aria-pressed={openSteps.has(c.id)}
            title={tab.cardStepsLabel ?? "How to test"}
            aria-label={tab.cardStepsLabel ?? "How to test"}
          >
            {#if cardStepsPending[c.id]}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            {:else}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6M10 3v6.5L5 18a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-8.5V3" /></svg>
            {/if}
          </button>
        {/if}
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
    {#if cardShowsSteps(c) && openSteps.has(c.id)}
      <!-- "How to test" steps for this card — numbered timeline via the
           shared StepList (identical to Test Pilot / Report). -->
      <div class="px-3 pb-3 pt-2 border-t border-ink-100 dark:border-night-line">
        {#if cardStepsPending[c.id]}
          <div class="flex items-center gap-2 text-[12px] text-ink-500 dark:text-night-mute">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            Working out how to test this…
            <button type="button" class="underline ml-auto" onclick={() => app.cancelModuleCardSteps(spec.id, c.id)}>Cancel</button>
          </div>
        {:else if cardSteps[c.id]}
          <StepList steps={cardSteps[c.id]?.steps ?? []} />
          {#if shotsOp}
            <!-- Per-step proof screenshots: agent walks the running app and
                 captures one PNG after each step (Report-shots rails). -->
            <div class="mt-2 pt-2 border-t border-ink-100 dark:border-night-line space-y-2">
              {#if cardShotsPending[c.id]}
                <div class="flex items-center gap-2 text-[12px] text-ink-500 dark:text-night-mute">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                  Driving the app and capturing each step…
                  <button type="button" class="underline ml-auto" onclick={() => app.cancelModuleCardShots(spec.id, c.id)}>Cancel</button>
                </div>
              {:else}
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 text-[12px] font-semibold rounded-md px-2.5 py-1 text-brand-pink dark:text-brand-pink-light border border-ink-200 dark:border-night-line hover:border-brand-pink transition-colors disabled:opacity-50"
                    disabled={!!cardShotsPending[c.id]}
                    onclick={() => generateShots(c)}
                    title="The agent performs each step in the running app and captures a screenshot per step"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
                    {cardShots[c.id] ? "Re-generate screenshots" : (tab.cardStepsShotsLabel ?? "Generate screenshots")}
                  </button>
                  {#if cardShotsError[c.id] && !cardShots[c.id]}
                    <span class="text-[11px] text-red-600 dark:text-red-400 min-w-0 break-words">{cardShotsError[c.id]}</span>
                  {/if}
                </div>
                {#if cardShots[c.id]}
                  <div class="grid grid-cols-2 gap-2">
                    {#each cardShots[c.id]?.shots ?? [] as s (s.step + ":" + s.shotKey)}
                      {@const src = s.ok ? app.moduleCardShotUrl(spec.id, c.id, s.shotKey) : null}
                      <div class="rounded-md border border-ink-200 dark:border-night-line overflow-hidden bg-ink-50 dark:bg-night-card">
                        <div class="px-2 py-1 text-[10px] font-semibold text-ink-500 dark:text-night-mute flex items-center justify-between gap-1">
                          <span>Step {s.step}</span>
                          {#if !s.ok}<span class="text-red-500 normal-case font-normal truncate" title={s.note}>failed</span>{/if}
                        </div>
                        {#if src}
                          <a href={src} target="_blank" rel="noopener" title={s.note ?? `Open step ${s.step} screenshot`}>
                            <img {src} alt="Step {s.step} screenshot" class="block w-full h-24 object-cover object-top" loading="lazy" />
                          </a>
                        {:else}
                          <div class="h-24 flex items-center justify-center text-[10px] text-ink-400 dark:text-night-mute px-2 text-center">{s.note ?? "Not captured"}</div>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
        {:else if cardStepsError[c.id]}
          <div class="text-[12px] text-red-600 dark:text-red-400 flex items-center justify-between gap-2">
            <span class="min-w-0 break-words">{cardStepsError[c.id]}</span>
            <button type="button" class="shrink-0 underline" onclick={() => retrySteps(c)}>Retry</button>
          </div>
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

  {#if pending && !pendingCardId && !pendingBoardActionId && !batchActive}
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

    <!-- Multi-start bar — tick cards below, Start them all from here. -->
    {#if selectedIds.size > 0 || batchActive}
      <div
        class="sticky top-0 z-10 flex items-center gap-2 rounded-lg border border-brand-pink/40 bg-brand-pink/5 dark:bg-brand-pink/10 px-3 py-2"
      >
        {#if batchActive}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="animate-spin text-brand-pink dark:text-brand-pink-light shrink-0" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
          <span class="flex-1 text-[12px] font-medium text-ink-700 dark:text-night-text">
            Running {batchTotal - batchLeft + 1} of {batchTotal}…
          </span>
        {:else}
          <span class="flex-1 text-[12px] font-medium text-ink-700 dark:text-night-text">
            {selectedIds.size} selected
          </span>
          <button
            type="button"
            class="text-[12px] text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text underline"
            onclick={clearSelection}>Clear</button
          >
          <button
            type="button"
            class="inline-flex items-center gap-1.5 text-[12px] font-semibold rounded-md px-3 py-1.5 bg-brand-pink text-white hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50"
            disabled={!!pending}
            onclick={startSelected}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4" /></svg>
            {batchLabel}
          </button>
        {/if}
      </div>
    {/if}

    {#if view === "featured"}
      {#if sectionTabs.length}
        <!-- Section tabs — flip between Up Next / In Progress / Review /
             Done instead of one long scroll. Horizontally scrollable so
             more sections never wrap awkwardly in the narrow panel. -->
        <div
          class="flex items-center gap-1 overflow-x-auto pb-0.5 -mx-0.5 px-0.5"
          role="tablist"
          aria-label="Task sections"
        >
          {#each sectionTabs as t (t.id)}
            <button
              type="button"
              role="tab"
              aria-selected={activeSection === t.id}
              class="shrink-0 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors {activeSection ===
              t.id
                ? 'bg-brand-pink text-white'
                : 'text-ink-600 dark:text-night-dim bg-ink-100/70 dark:bg-night-line/50 hover:bg-ink-200 dark:hover:bg-night-line'}"
              onclick={() => (activeSection = t.id)}
            >
              {#if t.color && t.id !== FEATURED_TAB}
                <span
                  class="w-2 h-2 rounded-full"
                  style={`background:${activeSection === t.id ? "currentColor" : t.color}`}
                ></span>
              {/if}
              {t.name}
              <span
                class="text-[10px] tabular-nums rounded-full px-1.5 py-0.5 {activeSection ===
                t.id
                  ? 'bg-white/25'
                  : 'bg-ink-200/80 dark:bg-night-alt text-ink-500 dark:text-night-mute'}"
                >{t.count}</span
              >
            </button>
          {/each}
        </div>

        <!-- Active section's cards -->
        {#if activeTabCards().length}
          <div class="space-y-2">
            {#each activeTabCards() as c (c.id)}
              {@render cardRow(c)}
            {/each}
          </div>
        {:else}
          <div
            class="rounded-lg border border-dashed border-ink-200 dark:border-night-line text-[12px] text-ink-400 dark:text-night-mute text-center py-7"
          >
            Nothing in {activeTabName()}.
          </div>
        {/if}
      {:else}
        <div
          class="rounded-lg border border-dashed border-ink-200 dark:border-night-line text-[12px] text-ink-400 dark:text-night-mute text-center py-7"
        >
          Nothing to pick up right now. Nice and clear.
        </div>
      {/if}
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
