<script lang="ts">
  // Phase 16 — Report module. View what you shipped (git + gh/glab +
  // Pinta activity, gathered by the /pinta agent) as Read-Mode day
  // cards, and export a clean markdown summary. Phase 16d — actions are
  // standardized into an icon group (Filter range dropdown / Projects
  // dialog / Regenerate / Export) to match the Annotate actions area;
  // the range pills, inline date inputs, and inline Projects panel moved
  // behind the Filter dropdown + Projects modal.

  import { app } from "../lib/state.svelte.js";
  import MicButton from "../lib/voice/MicButton.svelte";
  import StepList from "./StepList.svelte";
  import {
    categoryLabel,
    foldWeekends,
    formatDayHeading,
    formatFileSummary,
    formatRangeLabel,
    formatShortDay,
    humanizeReportTitle,
    isAnnotateRollup,
    isTrackerRef,
    mergeAnnotationChildren,
    mergeCustomItems,
    rangeWindow,
    renderDayMarkdown,
    reportItemDisplayTitle,
    reportProjects,
    type ReportCategory,
    type ReportDay,
    type ReportItem,
    type ReportRange,
  } from "../lib/report.js";

  const RANGES: { id: ReportRange; label: string; hint: string }[] = [
    { id: "daily", label: "Today", hint: "Just today's work" },
    { id: "weekly", label: "This week", hint: "Monday → today" },
    { id: "sprint", label: "Sprint", hint: "Last 10 working days" },
    { id: "custom", label: "Custom", hint: "Pick a single date or a range" },
  ];

  // Shared icon-button style for the actions group (mirrors the header ⋮).
  const ACTION_BTN =
    "relative w-8 h-8 inline-flex items-center justify-center rounded-md border border-ink-200 bg-white text-ink-600 hover:text-brand-pink hover:border-ink-400 dark:border-night-line dark:bg-night-card dark:text-night-dim dark:hover:text-brand-pink-light disabled:opacity-50 transition-colors";

  const run = $derived(app.report.currentRun);
  // Inclusive window the current run covers — used to filter custom items so
  // out-of-range manual entries are hidden (not lost). Older runs may lack
  // since/until, so fall back to the computed range window.
  const runWindow = $derived.by(() => {
    if (!run) return null;
    if (run.since && run.until) return { since: run.since, until: run.until };
    const w = rangeWindow(run.range, run.anchorDate);
    return { since: w.since, until: w.until };
  });
  // Fold weekends for display; the stored run keeps true-dated days. The
  // user's hand-typed custom items are merged in here (within the window),
  // so a refresh that replaces `currentRun` never drops them. With no run
  // yet, manual entries show on their own.
  const days = $derived.by(() => {
    const custom = app.report.customItems;
    if (!run) {
      if (custom.length === 0) return [];
      return foldWeekends(mergeCustomItems([], custom), "custom");
    }
    return foldWeekends(
      mergeCustomItems(run.days, custom, runWindow ?? undefined),
      run.range,
    );
  });
  const rangeLabel = $derived(
    run
      ? run.since && run.until
        ? formatRangeLabel(run.since, run.until)
        : rangeWindow(run.range, run.anchorDate).label
      : days.length > 0
        ? "Manual entries"
        : "",
  );
  const pending = $derived(app.report.pending !== null);
  const connected = $derived(app.connectionStatus === "connected");
  const multiProject = $derived(run ? reportProjects(run).length > 1 : false);
  // Per-item disclosure for roll-up entries (e.g. the "Pinta annotations"
  // parent) — expand to reveal each child title. Keyed by item id.
  let expandedChildren = $state<Record<string, boolean>>({});
  // Per-item disclosure for the technical details (commit sha + changed
  // files) behind the ⓘ icon, so the card reads as plain descriptions until
  // asked. Keyed by item id.
  let expandedDetails = $state<Record<string, boolean>>({});
  const currentRangeName = $derived(
    RANGES.find((r) => r.id === app.report.range)?.label ?? "This week",
  );
  const primaryProject = $derived(
    app.selectedCompanion?.projectRoot
      ? basename(app.selectedCompanion.projectRoot)
      : null,
  );

  let newPath = $state("");
  let filterMenuOpen = $state(false);
  let projectsDialogOpen = $state(false);

  // ─── Per-entry "proof" screenshot (Phase 16f) ───────────────────────
  // Click the camera on a row → if no shot exists yet, ask the /pinta
  // agent to open the entry's page, frame the element the change touched,
  // and capture a PNG (written to disk, served by the companion). If a
  // shot already exists, open the viewer. Re-capture from inside it.
  let shotItem = $state<ReportItem | null>(null);
  let shotDate = $state<string>("");
  // The capture we triggered + are waiting to auto-open the viewer for.
  let awaitingShot = $state<{ item: ReportItem; date: string } | null>(null);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  // Companion URL for the open entry's PNG (null until captured / connected).
  const shotSrc = $derived(shotItem ? app.shotUrl(shotItem.id) : null);
  const shotNote = $derived(shotItem ? app.report.shots[shotItem.id]?.note : undefined);
  const recapturing = $derived(
    !!shotItem && app.report.shotPending === shotItem.id,
  );

  function cameraClick(item: ReportItem, date: string) {
    if (app.report.shotPending) return; // one capture at a time
    if (app.report.shots[item.id]) {
      openShotViewer(item, date); // already captured — just view
    } else {
      capture(item, date);
    }
  }

  function capture(item: ReportItem, date: string) {
    awaitingShot = { item, date };
    void app.captureItemScreenshot(item, date);
  }

  function openShotViewer(item: ReportItem, date: string) {
    shotItem = item;
    shotDate = date;
    copied = false;
  }

  function closeShotViewer() {
    shotItem = null;
    copied = false;
    if (copyTimer) {
      clearTimeout(copyTimer);
      copyTimer = null;
    }
  }

  // Auto-open the viewer when a capture we triggered finishes successfully.
  // (A failed capture surfaces via app.report.error; we just clear the wait.)
  $effect(() => {
    const a = awaitingShot;
    if (!a) return;
    if (app.report.shotPending === a.item.id) return; // still in flight
    if (app.report.shots[a.item.id]) openShotViewer(a.item, a.date);
    awaitingShot = null;
  });

  async function copyShot() {
    if (!shotSrc) return;
    try {
      const blob = await (await fetch(shotSrc)).blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1800);
    } catch {
      // Clipboard image write isn't universally permitted — nudge to Download.
      app.report.error = "Couldn't copy the image — use Download instead.";
    }
  }

  async function downloadShot() {
    if (!shotSrc || !shotItem) return;
    const key = app.report.shots[shotItem.id]?.shotKey ?? shotItem.id;
    try {
      const blob = await (await fetch(shotSrc)).blob();
      downloadBlob(`pinta-report-shot-${shotDate}-${key}.png`, blob);
    } catch {
      app.report.error = "Couldn't download the image.";
    }
  }

  // ─── Per-entry "How to test" guide (Phase 16g) ──────────────────────
  // Click the clipboard icon on a row → if a guide exists, open the viewer;
  // else ask the agent for step-by-step manual QA steps and auto-open when
  // they land. Mirrors the screenshot flow.
  let howToItem = $state<ReportItem | null>(null);
  let howToDate = $state<string>("");
  let awaitingHowTo = $state<{ item: ReportItem; date: string } | null>(null);

  const howToSteps = $derived(
    howToItem ? app.report.howTo[howToItem.id]?.steps ?? [] : [],
  );
  const howToGenerating = $derived(
    !!howToItem && app.report.howToPending === howToItem.id,
  );

  function howToClick(item: ReportItem, date: string) {
    if (app.report.howToPending) return; // one at a time
    howToDate = date;
    if (app.report.howTo[item.id]) {
      howToItem = item; // already generated — just view
    } else {
      generateHowTo(item, date);
    }
  }

  function generateHowTo(item: ReportItem, date: string) {
    howToDate = date;
    awaitingHowTo = { item, date };
    void app.requestHowToTest(item, date);
  }

  function closeHowTo() {
    howToItem = null;
  }

  // Auto-open the viewer when a generation we triggered finishes with steps.
  $effect(() => {
    const a = awaitingHowTo;
    if (!a) return;
    if (app.report.howToPending === a.item.id) return; // still in flight
    if (app.report.howTo[a.item.id]) howToItem = a.item;
    awaitingHowTo = null;
  });

  // ─── Custom (hand-typed) items ──────────────────────────────────────
  // A per-day quick-add lives at the foot of each card; a single global
  // composer (with a date picker) handles days that have no card yet.
  const CATEGORIES: ReportCategory[] = [
    "feature",
    "bug-fix",
    "polish",
    "test",
    "docs",
    "deps",
    "merge",
    "annotate",
    "chore",
  ];
  // Shared field styles for the composers.
  const FIELD_CLS =
    "text-[11.5px] px-2 py-1 rounded border border-ink-200 dark:border-night-line bg-white dark:bg-night-bg text-ink-800 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute focus:outline-none focus:ring-1 focus:ring-brand-pink/40";
  const ADD_BTN_CLS =
    "px-2.5 py-1 text-[11px] rounded border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:border-brand-pink hover:text-brand-pink disabled:opacity-50";

  let addingForDate = $state<string | null>(null); // per-day composer target
  let globalAddOpen = $state(false);
  let draftTitle = $state("");
  let draftTitleEl: HTMLInputElement | undefined = $state();
  let draftCategory = $state<ReportCategory>("feature");
  let draftDate = $state("");

  function openDayComposer(date: string) {
    addingForDate = date;
    globalAddOpen = false;
    draftTitle = "";
    draftCategory = "feature";
  }

  function openGlobalComposer() {
    globalAddOpen = true;
    addingForDate = null;
    draftTitle = "";
    draftCategory = "feature";
    draftDate = todayLocal();
  }

  function closeComposers() {
    addingForDate = null;
    globalAddOpen = false;
    draftTitle = "";
  }

  function submitDayItem(date: string) {
    if (app.addReportCustomItem(date, draftTitle, draftCategory)) closeComposers();
  }

  function submitGlobalItem() {
    if (!draftDate) return;
    if (app.addReportCustomItem(draftDate, draftTitle, draftCategory))
      closeComposers();
  }

  /** Close-on-outside-click action (matches App.svelte's header menu). */
  function clickOutside(node: HTMLElement, cb: () => void) {
    const handler = (e: MouseEvent) => {
      if (!node.contains(e.target as Node)) cb();
    };
    document.addEventListener("mousedown", handler, true);
    return {
      destroy() {
        document.removeEventListener("mousedown", handler, true);
      },
    };
  }

  function basename(p: string): string {
    return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
  }

  function todayLocal(): string {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  }

  function pickRange(r: ReportRange) {
    app.setReportRange(r);
    // Seed the custom window to today so the date inputs aren't blank.
    if (r === "custom" && !app.report.customSince) {
      const t = todayLocal();
      app.setReportCustomRange(t, t);
    }
    // Non-custom ranges apply immediately; custom keeps the dropdown open
    // so the user can pick dates.
    if (r !== "custom") filterMenuOpen = false;
  }

  // From/To changes keep the window ordered.
  function onCustomSince(e: Event) {
    const since = (e.currentTarget as HTMLInputElement).value;
    if (!since) return;
    const until =
      app.report.customUntil && app.report.customUntil >= since
        ? app.report.customUntil
        : since;
    app.setReportCustomRange(since, until);
  }

  function onCustomUntil(e: Event) {
    const until = (e.currentTarget as HTMLInputElement).value;
    if (!until) return;
    const since =
      app.report.customSince && app.report.customSince <= until
        ? app.report.customSince
        : until;
    app.setReportCustomRange(since, until);
  }

  function generate() {
    void app.generateReport();
  }

  function addProject() {
    const p = newPath.trim();
    if (!p) return;
    app.addReportProject(p);
    newPath = "";
  }

  function downloadBlob(filename: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function download(filename: string, md: string) {
    downloadBlob(filename, new Blob([md], { type: "text/markdown" }));
  }

  async function exportAll() {
    if (!run) return;
    // Pull annotation detail for any annotate roll-up day the agent didn't
    // expand, so the markdown carries the children even if never opened.
    await app.prepareReportExport();
    // Human-friendly export: one prose paragraph per day (≤1000 chars),
    // falling back to item lines for any day the agent didn't summarize.
    download(
      `pinta-report-${run.range}-${run.anchorDate}.md`,
      app.exportReportSummaryMarkdown(),
    );
  }

  async function exportDay(day: ReportDay) {
    const needsKids = day.items.some(
      (it) => isAnnotateRollup(it) && !(it.children && it.children.length),
    );
    // Include the weekend days folded into this weekday so their annotations
    // land here rather than being dropped.
    if (needsKids)
      await app.loadAnnotationChildren(day.date, [
        day.date,
        ...(day.foldedFrom ?? []),
      ]);
    const merged = mergeAnnotationChildren([day], app.report.annotationChildren);
    download(
      `pinta-report-${day.date}.md`,
      renderDayMarkdown(merged[0]!, multiProject),
    );
  }

  // Category → chip color. Grouped by intent so the cards scan fast.
  function chipClass(c: ReportCategory): string {
    switch (c) {
      case "bug-fix":
        return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
      case "feature":
        return "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300";
      case "polish":
        return "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300";
      case "test":
        return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
      case "annotate":
        return "bg-pink-100 text-pink-700 dark:bg-pink-950/40 dark:text-pink-300";
      case "deps":
        return "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
      case "docs":
        return "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300";
      case "merge":
      case "chore":
      default:
        return "bg-ink-100 text-ink-600 dark:bg-night-alt dark:text-night-dim";
    }
  }
</script>

{#snippet itemRow(item: ReportItem, date: string, foldedFrom?: string[])}
  {@const capturing = app.report.shotPending === item.id}
  {@const hasShot = !!app.report.shots[item.id]}
  {@const howToBusy = app.report.howToPending === item.id}
  {@const hasHowTo = !!app.report.howTo[item.id]}
  <!-- Roll-up children: the agent's `children` if present, else the
       client-side annotation fallback fetched for this day. Annotate
       roll-ups stay expandable even with no children yet so a click can
       trigger the fetch. -->
  {@const annotateRollup = isAnnotateRollup(item)}
  {@const fallbackKids = app.report.annotationChildren[date]}
  {@const kids =
    (item.children?.length ? item.children : fallbackKids) ?? []}
  {@const canExpand = (item.children?.length ?? 0) > 0 || annotateRollup}
  {@const kidsLoading = app.report.annotationChildrenPending === date}
  {@const isOpen = !!expandedChildren[item.id]}
  <!-- Technical bits (commit sha + changed files) are hidden by default and
       revealed by the ⓘ icon. Tracker refs (#PR / !issue) stay inline. -->
  {@const trackerRef = isTrackerRef(item)}
  {@const commitRef = item.ref && !trackerRef ? item.ref : null}
  {@const fileSummary = formatFileSummary(item)}
  {@const hasDetails = !!commitRef || !!fileSummary}
  {@const detailsOpen = !!expandedDetails[item.id]}
  <li class="group flex items-start gap-2 px-3 py-2">
    <span
      class="shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium {chipClass(item.category)}"
    >
      {categoryLabel(item.category)}
    </span>
    {#if multiProject && item.project}
      <span
        class="shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-ink-100 text-ink-600 dark:bg-night-alt dark:text-night-dim"
        title={item.project}
      >
        {item.project}
      </span>
    {/if}
    {#if item.userAdded}
      <span
        class="shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-ink-100 text-ink-500 dark:bg-night-alt dark:text-night-mute"
        title="You added this entry by hand — it survives Refresh"
      >
        Manual
      </span>
    {/if}
    <div class="min-w-0 flex-1 text-[12.5px] text-ink-800 dark:text-night-text leading-snug">
      {#if trackerRef}
        {#if item.url}
          <a href={item.url} target="_blank" rel="noopener noreferrer" class="font-mono text-[11.5px] text-brand-pink dark:text-brand-pink-light hover:underline">{item.ref}</a>
        {:else}
          <span class="font-mono text-[11.5px] text-ink-500 dark:text-night-mute">{item.ref}</span>
        {/if}
        <span class="text-ink-400 dark:text-night-mute"> — </span>
      {/if}{#if canExpand}
        <button
          type="button"
          class="inline-flex items-start gap-1 text-left break-words hover:text-brand-pink dark:hover:text-brand-pink-light"
          aria-expanded={isOpen}
          onclick={() => {
            const next = !expandedChildren[item.id];
            expandedChildren[item.id] = next;
            if (
              next &&
              annotateRollup &&
              !item.children?.length &&
              !app.report.annotationChildren[date]
            )
              void app.loadAnnotationChildren(date, [
                date,
                ...(foldedFrom ?? []),
              ]);
          }}
        >
          <svg
            class="shrink-0 mt-[3px] transition-transform {isOpen ? 'rotate-90' : ''}"
            width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
          ><polyline points="9 18 15 12 9 6" /></svg>
          <span>{reportItemDisplayTitle(item)}</span>
          {#if kids.length}
            <span class="shrink-0 text-[10px] text-ink-400 dark:text-night-mute">({kids.length})</span>
          {/if}
        </button>
      {:else}<span class="break-words">{reportItemDisplayTitle(item)}</span>{/if}
      {#if item.detail}
        <p class="text-[11px] text-ink-500 dark:text-night-dim mt-0.5 break-words">{item.detail}</p>
      {/if}
      {#if hasDetails && detailsOpen}
        <div class="mt-1 space-y-0.5 text-[10.5px] text-ink-400 dark:text-night-mute font-mono break-words">
          {#if commitRef}
            <p title="Commit">
              <span class="opacity-70">commit</span>
              {#if item.url}
                <a href={item.url} target="_blank" rel="noopener noreferrer" class="text-brand-pink dark:text-brand-pink-light hover:underline">{commitRef}</a>
              {:else}{commitRef}{/if}
            </p>
          {/if}
          {#if fileSummary}
            <p title="Files changed">
              <svg class="inline-block align-[-1px] mr-0.5" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
              {fileSummary}
            </p>
          {/if}
        </div>
      {/if}
      {#if canExpand && isOpen}
        {#if kids.length}
          <ul class="mt-1 ml-2 border-l border-ink-200 dark:border-night-line pl-2.5 space-y-1">
            {#each kids as child}
              <li class="flex gap-1.5 text-[11.5px] text-ink-600 dark:text-night-dim break-words leading-snug">
                <span class="shrink-0 mt-[6px] w-1 h-1 rounded-full bg-ink-400 dark:bg-night-mute" aria-hidden="true"></span>
                <span class="min-w-0 break-words">{#if child.ref}<span class="font-mono text-[10.5px] text-ink-400 dark:text-night-mute mr-1">{child.ref}</span>{/if}{#if child.url}<a href={child.url} target="_blank" rel="noopener noreferrer" class="hover:underline">{humanizeReportTitle(child.title)}</a>{:else}{humanizeReportTitle(child.title)}{/if}</span>
              </li>
            {/each}
          </ul>
        {:else if kidsLoading}
          <p class="mt-1 ml-2 text-[11px] text-ink-400 dark:text-night-mute">Loading annotation details…</p>
        {:else}
          <p class="mt-1 ml-2 text-[11px] text-ink-400 dark:text-night-mute">No annotation details found for this day.</p>
        {/if}
      {/if}
    </div>
    <div class="shrink-0 mt-0.5 flex items-center gap-0.5">
      <!-- Technical details (commit sha + changed files) — hidden by default,
           toggled open by this ⓘ. Only shown when there's something to reveal. -->
      {#if hasDetails}
        <button
          type="button"
          class="leading-none p-0.5 rounded {detailsOpen
            ? 'text-brand-pink dark:text-brand-pink-light'
            : 'text-ink-300 hover:text-brand-pink dark:text-night-mute dark:hover:text-brand-pink-light'}"
          aria-expanded={detailsOpen}
          onclick={() => (expandedDetails[item.id] = !detailsOpen)}
          aria-label={detailsOpen ? "Hide technical details" : "Show technical details"}
          title="Technical details — commit + changed files"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        </button>
      {/if}
      <!-- Per-entry "proof" screenshot: the /pinta agent opens this entry's
           page, frames the changed element, and captures it. A captured
           entry shows a solid (pink) camera that re-opens the viewer. -->
      <button
        type="button"
        class="leading-none p-0.5 rounded transition-opacity disabled:cursor-wait {hasShot
          ? 'text-brand-pink dark:text-brand-pink-light opacity-100'
          : 'text-ink-300 hover:text-brand-pink dark:text-night-mute dark:hover:text-brand-pink-light opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}"
        onclick={() => cameraClick(item, date)}
        disabled={!!app.report.shotPending && !capturing}
        aria-label={hasShot
          ? "View this entry's screenshot"
          : "Capture a screenshot of this entry"}
        title={hasShot
          ? "View screenshot (re-capture inside)"
          : "Capture a screenshot of this entry — the agent opens the page and frames the change"}
      >
        {#if capturing}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="animate-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        {:else}
          <svg width="14" height="14" viewBox="0 0 24 24" fill={hasShot ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" fill={hasShot ? "var(--color-white, #fff)" : "none"} stroke={hasShot ? "#fff" : "currentColor"} />
          </svg>
        {/if}
      </button>
      <!-- Per-entry "How to test": the /pinta agent writes manual QA steps
           to verify this shipped item. A generated entry shows a solid
           (pink) icon that re-opens the steps. -->
      <button
        type="button"
        class="leading-none p-0.5 rounded transition-opacity disabled:cursor-wait {hasHowTo
          ? 'text-brand-pink dark:text-brand-pink-light opacity-100'
          : 'text-ink-300 hover:text-brand-pink dark:text-night-mute dark:hover:text-brand-pink-light opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}"
        onclick={() => howToClick(item, date)}
        disabled={!!app.report.howToPending && !howToBusy}
        aria-label={hasHowTo
          ? "View how to test this entry"
          : "Generate how-to-test steps for this entry"}
        title={hasHowTo
          ? "How to test (regenerate inside)"
          : "How to test — the agent writes step-by-step QA steps for this entry"}
      >
        {#if howToBusy}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="animate-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        {:else}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        {/if}
      </button>
      {#if item.userAdded}
        <button
          type="button"
          class="leading-none px-1 text-ink-300 hover:text-red-500 dark:text-night-mute dark:hover:text-red-400"
          onclick={() => app.removeReportCustomItem(item.id)}
          aria-label="Remove this entry"
          title="Remove this entry"
        >×</button>
      {/if}
    </div>
  </li>
{/snippet}

{#snippet composerFields(onSubmit: () => void)}
  <div class="relative">
    <input
      type="text"
      bind:this={draftTitleEl}
      bind:value={draftTitle}
      onkeydown={(e) => {
        if (e.key === "Enter") onSubmit();
        else if (e.key === "Escape") closeComposers();
      }}
      placeholder="What did you do?"
      class="w-full pr-9 {FIELD_CLS}"
    />
    {#if app.voiceReady}
      <span class="absolute right-1 top-1/2 -translate-y-1/2">
        <MicButton el={draftTitleEl} lang={app.voiceLang} />
      </span>
    {/if}
  </div>
  <div class="flex items-center gap-1.5">
    <select bind:value={draftCategory} class={FIELD_CLS} aria-label="Category">
      {#each CATEGORIES as c (c)}
        <option value={c}>{categoryLabel(c)}</option>
      {/each}
    </select>
    <button
      type="button"
      class={ADD_BTN_CLS}
      onclick={onSubmit}
      disabled={draftTitle.trim() === ""}
    >
      Add
    </button>
    <button
      type="button"
      class="px-2 py-1 text-[11px] text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
      onclick={closeComposers}
    >
      Cancel
    </button>
  </div>
{/snippet}

{#snippet globalAdder()}
  {#if globalAddOpen}
    <div class="rounded-md border border-dashed border-ink-300 dark:border-night-line px-3 py-2 space-y-1.5">
      <input
        type="date"
        bind:value={draftDate}
        class="{FIELD_CLS} dark:[color-scheme:dark]"
        aria-label="Entry date"
      />
      {@render composerFields(submitGlobalItem)}
      <p class="text-[10px] text-ink-400 dark:text-night-mute">
        An entry for a day outside the current range is saved and shown when
        you widen the range.
      </p>
    </div>
  {:else}
    <button
      type="button"
      class="text-[11px] text-ink-500 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light"
      onclick={openGlobalComposer}
    >
      + Add an entry for another day
    </button>
  {/if}
{/snippet}

<section class="space-y-3">
  <!-- Header: title + selected-range label + actions icon group -->
  <div class="flex items-center justify-between gap-2">
    <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">
      Report
    </h2>
    <div class="flex items-center gap-1.5">
      <span class="text-[11px] text-ink-500 dark:text-night-mute mr-0.5">
        {currentRangeName}
      </span>

      <!-- Filter: range dropdown (Today / This week / Sprint / Custom) -->
      <div class="relative" use:clickOutside={() => (filterMenuOpen = false)}>
        <button
          type="button"
          class={ACTION_BTN}
          onclick={() => (filterMenuOpen = !filterMenuOpen)}
          aria-haspopup="menu"
          aria-expanded={filterMenuOpen}
          title="Filter — {currentRangeName}"
          aria-label="Filter range"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
        </button>
        {#if filterMenuOpen}
          <div class="absolute right-0 top-full mt-1 z-50 w-48 rounded-md border border-ink-200 bg-white shadow-lg dark:border-night-line dark:bg-night-card py-1" role="menu">
            {#each RANGES as r (r.id)}
              <button
                type="button"
                class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] {app.report.range === r.id ? 'text-brand-pink dark:text-brand-pink-light font-medium' : 'text-ink-700 dark:text-night-dim'} hover:bg-ink-50 dark:hover:bg-night-alt"
                role="menuitemradio"
                aria-checked={app.report.range === r.id}
                onclick={() => pickRange(r.id)}
                title={r.hint}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class={app.report.range === r.id ? "" : "opacity-0"} aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
                {r.label}
              </button>
            {/each}
            {#if app.report.range === "custom"}
              <!-- Inline date-range picker, revealed when Custom is active. -->
              <div class="border-t border-ink-100 dark:border-night-line mt-1 px-3 py-2 space-y-1.5">
                <label class="flex items-center justify-between gap-2 text-[11px] text-ink-600 dark:text-night-dim">
                  From
                  <input
                    type="date"
                    value={app.report.customSince}
                    onchange={onCustomSince}
                    class="px-1.5 py-1 rounded border border-ink-200 dark:border-night-line bg-white dark:bg-night-bg text-ink-800 dark:text-night-text text-[11px] focus:outline-none focus:ring-1 focus:ring-brand-pink/40 dark:[color-scheme:dark]"
                  />
                </label>
                <label class="flex items-center justify-between gap-2 text-[11px] text-ink-600 dark:text-night-dim">
                  To
                  <input
                    type="date"
                    value={app.report.customUntil}
                    onchange={onCustomUntil}
                    class="px-1.5 py-1 rounded border border-ink-200 dark:border-night-line bg-white dark:bg-night-bg text-ink-800 dark:text-night-text text-[11px] focus:outline-none focus:ring-1 focus:ring-brand-pink/40 dark:[color-scheme:dark]"
                  />
                </label>
                <p class="text-[10px] text-ink-400 dark:text-night-mute">Same date = a single day.</p>
                <button
                  type="button"
                  class="w-full text-[11px] rounded border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:border-brand-pink hover:text-brand-pink py-1"
                  onclick={() => (filterMenuOpen = false)}
                >
                  Done
                </button>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Projects: opens the repos dialog -->
      <button
        type="button"
        class={ACTION_BTN}
        onclick={() => (projectsDialogOpen = true)}
        title="Projects — combine extra repos"
        aria-label="Projects"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        {#if app.report.projects.length > 0}
          <span class="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 inline-flex items-center justify-center rounded-full bg-brand-pink text-white text-[9px] font-semibold leading-none dark:bg-brand-pink-light dark:text-night-bg">
            {app.report.projects.length}
          </span>
        {/if}
      </button>

      <!-- Regenerate (refresh) -->
      <button
        type="button"
        class={ACTION_BTN}
        onclick={generate}
        disabled={pending || !connected}
        title={connected ? (run ? "Regenerate report" : "Generate report") : "Connect a companion to generate"}
        aria-label={run ? "Regenerate report" : "Generate report"}
      >
        {#if pending}
          <svg class="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
        {:else}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
        {/if}
      </button>

      <!-- Export whole report -->
      {#if run}
        <button
          type="button"
          class={ACTION_BTN}
          onclick={exportAll}
          title="Export the whole report (.md)"
          aria-label="Export report as markdown"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      {/if}
    </div>
  </div>

  {#if !connected}
    <p class="text-[11.5px] text-amber-700 dark:text-amber-400 leading-snug">
      Connect a companion (run <code>pinta-companion .</code> in your project) so the agent can gather your tasks.
    </p>
  {/if}

  {#if app.report.error}
    <div
      class="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[11.5px] text-red-700 dark:text-red-300 leading-snug"
      role="alert"
    >
      <p class="flex-1 min-w-0 break-words">{app.report.error}</p>
      <button
        type="button"
        class="shrink-0 text-red-500 hover:text-red-700 dark:hover:text-red-200 leading-none px-1"
        onclick={() => (app.report.error = null)}
        aria-label="Dismiss"
        title="Dismiss"
      >✕</button>
    </div>
  {/if}

  {#if pending}
    <div class="rounded-md border border-ink-200 dark:border-night-line p-4 text-center space-y-2">
      <p class="text-xs text-ink-600 dark:text-night-dim">
        Gathering your tasks from git, GitHub/GitLab, and Pinta…
      </p>
      <button
        type="button"
        class="text-[11px] text-ink-500 dark:text-night-mute underline hover:text-ink-800 dark:hover:text-night-text"
        onclick={() => app.cancelReport()}
      >
        Cancel
      </button>
    </div>
  {:else if days.length > 0}
    <p class="text-[11px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
      {rangeLabel}
    </p>
    {#each days as day (day.date)}
      <div class="rounded-md border border-ink-200 dark:border-night-line overflow-hidden">
        <div class="flex items-center justify-between gap-2 px-3 py-2 bg-ink-50 dark:bg-night-alt/50 border-b border-ink-200 dark:border-night-line">
          <div class="min-w-0">
            <h3 class="text-[13px] font-semibold text-ink-900 dark:text-night-text">
              {formatDayHeading(day.date)}
            </h3>
            {#if day.foldedFrom && day.foldedFrom.length > 0}
              <p class="text-[10px] text-ink-400 dark:text-night-mute">
                incl. {day.foldedFrom.map(formatShortDay).join(", ")}
              </p>
            {/if}
          </div>
          <div class="shrink-0 flex items-center gap-0.5">
            {#if run}
              <!-- Fetch more commits for this day (uncapped re-gather, merged in) -->
              <button
                type="button"
                class="w-6 h-6 inline-flex items-center justify-center rounded text-ink-400 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light hover:bg-ink-100 dark:hover:bg-night-line disabled:opacity-40 disabled:hover:text-ink-400 dark:disabled:hover:text-night-mute disabled:hover:bg-transparent"
                onclick={() => app.fetchMoreDay(day.date)}
                disabled={!connected || pending || app.report.expandingDate !== null}
                title={connected ? "Fetch more commits for this day" : "Connect a companion to fetch more"}
                aria-label={`Fetch more commits for ${formatDayHeading(day.date)}`}
              >
                {#if app.report.expandingDate === day.date}
                  <svg class="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                {:else}
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
                {/if}
              </button>
            {/if}
            <button
              type="button"
              class="w-6 h-6 inline-flex items-center justify-center rounded text-ink-400 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light hover:bg-ink-100 dark:hover:bg-night-line"
              onclick={() => exportDay(day)}
              title="Export this day (.md)"
              aria-label={`Export ${formatDayHeading(day.date)} as markdown`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>
        </div>
        <ul class="divide-y divide-ink-100 dark:divide-night-line/60">
          {#each day.items as item (item.id)}
            {@render itemRow(item, day.date, day.foldedFrom)}
          {/each}
        </ul>
        <div class="border-t border-ink-100 dark:border-night-line/60 px-3 py-1.5">
          {#if addingForDate === day.date}
            <div class="space-y-1.5">
              {@render composerFields(() => submitDayItem(day.date))}
            </div>
          {:else}
            <button
              type="button"
              class="text-[11px] text-ink-500 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light"
              onclick={() => openDayComposer(day.date)}
            >
              + Add item
            </button>
          {/if}
        </div>
      </div>
    {/each}
    {@render globalAdder()}
  {:else if run}
    <p class="text-xs text-ink-500 dark:text-night-mute italic">
      No tasks found for {rangeLabel}. Try a wider range from the filter.
    </p>
    {@render globalAdder()}
  {:else}
    <p class="text-xs text-ink-500 dark:text-night-mute italic leading-snug">
      No report yet. Pick a range from the filter <span class="font-medium">▾</span>, optionally add
      repos via the projects <span class="font-medium">⚙</span>, then hit the
      refresh icon to generate — the agent gathers your bug fixes, polishes,
      tests, annotations, and merges, grouped by day. Export any day or the
      whole range as clean markdown.
    </p>
    {@render globalAdder()}
  {/if}
</section>

<!-- Projects dialog (modal) — combine extra repos -->
{#if projectsDialogOpen}
  <button
    type="button"
    class="fixed inset-0 z-40 bg-black/40 dark:bg-black/60"
    onclick={() => (projectsDialogOpen = false)}
    aria-label="Close projects dialog"
  ></button>
  <div
    class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[90%] max-w-sm rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card shadow-2xl p-4 space-y-3"
    role="dialog"
    aria-modal="true"
    aria-label="Report projects"
  >
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold text-ink-900 dark:text-night-text">Projects</h3>
      <button
        type="button"
        class="w-7 h-7 inline-flex items-center justify-center rounded-full text-ink-500 dark:text-night-mute hover:text-ink-900 dark:hover:text-night-text hover:bg-ink-100 dark:hover:bg-night-alt"
        onclick={() => (projectsDialogOpen = false)}
        aria-label="Close"
        title="Close"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>
    <p class="text-[11px] text-ink-500 dark:text-night-mute leading-snug">
      Combine extra repos into the report — gathered from git + your issue
      tracker (no Pinta activity). The current project is always included as
      primary.
    </p>
    <div class="flex flex-wrap gap-1.5">
      {#if primaryProject}
        <span
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-ink-100 dark:bg-night-alt text-[11px] text-ink-700 dark:text-night-dim"
          title={app.selectedCompanion?.projectRoot}
        >
          {primaryProject}
          <span class="text-ink-400 dark:text-night-mute">· primary</span>
        </span>
      {/if}
      {#each app.report.projects as p (p)}
        <span
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-pink/10 text-brand-pink dark:text-brand-pink-light text-[11px]"
          title={p}
        >
          {basename(p)}
          <button
            type="button"
            class="leading-none hover:text-brand-magenta dark:hover:text-white"
            onclick={() => app.removeReportProject(p)}
            aria-label={`Remove ${p}`}
            title="Remove"
          >×</button>
        </span>
      {/each}
    </div>
    <div class="flex items-center gap-1.5">
      <input
        type="text"
        bind:value={newPath}
        onkeydown={(e) => {
          if (e.key === "Enter") addProject();
        }}
        placeholder="Add a repo path, e.g. C:\insclix\insclix-awp-2.0"
        class="flex-1 min-w-0 text-[11.5px] px-2 py-1 rounded border border-ink-200 dark:border-night-line bg-white dark:bg-night-bg text-ink-800 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute focus:outline-none focus:ring-1 focus:ring-brand-pink/40"
      />
      <button
        type="button"
        class="px-2.5 py-1 text-[11px] rounded border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:border-brand-pink hover:text-brand-pink disabled:opacity-50"
        onclick={addProject}
        disabled={newPath.trim() === ""}
      >
        Add
      </button>
    </div>
  </div>
{/if}

<!-- Proof-screenshot viewer (modal) — the agent-captured image of the
     element this entry changed, served live by the companion. -->
{#if shotItem}
  <button
    type="button"
    class="fixed inset-0 z-40 bg-black/40 dark:bg-black/60"
    onclick={closeShotViewer}
    aria-label="Close screenshot preview"
  ></button>
  <div
    class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[90%] max-w-md rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card shadow-2xl p-4 space-y-3"
    role="dialog"
    aria-modal="true"
    aria-label="Screenshot preview"
  >
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-sm font-semibold text-ink-900 dark:text-night-text min-w-0">
        Screenshot
        <span class="block text-[11px] font-normal text-ink-500 dark:text-night-mute truncate">
          {humanizeReportTitle(shotItem.title)}
        </span>
      </h3>
      <button
        type="button"
        class="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full text-ink-500 dark:text-night-mute hover:text-ink-900 dark:hover:text-night-text hover:bg-ink-100 dark:hover:bg-night-alt"
        onclick={closeShotViewer}
        aria-label="Close"
        title="Close"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>

    <div class="rounded-md border border-ink-200 dark:border-night-line overflow-hidden bg-ink-50 dark:bg-night-alt/40 relative">
      {#if shotSrc}
        <img src={shotSrc} alt="Captured element from the app" class="block w-full h-auto" />
      {:else}
        <p class="p-6 text-center text-[12px] text-ink-500 dark:text-night-mute">
          Connect to this entry's companion to view the screenshot.
        </p>
      {/if}
      {#if recapturing}
        <div class="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-night-card/70">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="animate-spin text-brand-pink dark:text-brand-pink-light">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        </div>
      {/if}
    </div>

    {#if shotNote}
      <p class="text-[11px] text-ink-500 dark:text-night-dim leading-snug">
        <span class="font-medium text-ink-600 dark:text-night-text">Framed:</span> {shotNote}
      </p>
    {/if}

    <div class="flex items-center justify-between gap-2">
      <button
        type="button"
        class="px-2.5 py-1.5 text-[12px] rounded-md border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:border-brand-pink hover:text-brand-pink dark:hover:text-brand-pink-light inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-wait"
        onclick={() => shotItem && capture(shotItem, shotDate)}
        disabled={recapturing}
        title="Re-run the capture against the current page"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
        Recapture
      </button>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="px-3 py-1.5 text-[12px] rounded-md border border-ink-200 dark:border-night-line text-ink-700 dark:text-night-dim hover:border-brand-pink hover:text-brand-pink dark:hover:text-brand-pink-light inline-flex items-center gap-1.5 disabled:opacity-50"
          onclick={copyShot}
          disabled={!shotSrc}
        >
          {#if copied}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
            Copied
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            Copy
          {/if}
        </button>
        <button
          type="button"
          class="px-3 py-1.5 text-[12px] rounded-md bg-brand-pink text-white hover:bg-brand-magenta dark:bg-brand-pink-light dark:text-night-bg dark:hover:bg-brand-pink inline-flex items-center gap-1.5 disabled:opacity-50"
          onclick={downloadShot}
          disabled={!shotSrc}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- How-to-test viewer (modal) — agent-generated manual QA steps for one
     entry, rendered with the shared step-timeline. -->
{#if howToItem}
  <button
    type="button"
    class="fixed inset-0 z-40 bg-black/40 dark:bg-black/60"
    onclick={closeHowTo}
    aria-label="Close how-to-test"
  ></button>
  <div
    class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[90%] max-w-md max-h-[85vh] flex flex-col rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card shadow-2xl"
    role="dialog"
    aria-modal="true"
    aria-label="How to test"
  >
    <div class="flex items-center justify-between gap-2 p-4 pb-3 border-b border-ink-100 dark:border-night-line">
      <h3 class="text-sm font-semibold text-ink-900 dark:text-night-text min-w-0">
        How to test
        <span class="block text-[11px] font-normal text-ink-500 dark:text-night-mute truncate">
          {humanizeReportTitle(howToItem.title)}
        </span>
      </h3>
      <button
        type="button"
        class="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full text-ink-500 dark:text-night-mute hover:text-ink-900 dark:hover:text-night-text hover:bg-ink-100 dark:hover:bg-night-alt"
        onclick={closeHowTo}
        aria-label="Close"
        title="Close"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-4">
      {#if howToSteps.length}
        <StepList steps={howToSteps} />
      {:else}
        <p class="text-[12px] text-ink-500 dark:text-night-mute italic">
          No steps yet.
        </p>
      {/if}
    </div>

    <div class="flex items-center justify-end gap-2 p-4 pt-3 border-t border-ink-100 dark:border-night-line">
      <button
        type="button"
        class="px-2.5 py-1.5 text-[12px] rounded-md border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:border-brand-pink hover:text-brand-pink dark:hover:text-brand-pink-light inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-wait"
        onclick={() => howToItem && generateHowTo(howToItem, howToDate)}
        disabled={howToGenerating}
        title="Re-generate the test steps"
      >
        {#if howToGenerating}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
          Generating…
        {:else}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
          Regenerate
        {/if}
      </button>
    </div>
  </div>
{/if}
