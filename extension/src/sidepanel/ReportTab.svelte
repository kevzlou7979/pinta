<script lang="ts">
  // Phase 16 — Report module. View what you shipped (git + gh/glab +
  // Pinta activity, gathered by the /pinta agent) as Read-Mode day
  // cards, and export a clean markdown summary. Phase 16d — actions are
  // standardized into an icon group (Filter range dropdown / Projects
  // dialog / Regenerate / Export) to match the Annotate actions area;
  // the range pills, inline date inputs, and inline Projects panel moved
  // behind the Filter dropdown + Projects modal.

  import { app } from "../lib/state.svelte.js";
  import {
    categoryLabel,
    foldWeekends,
    formatDayHeading,
    formatRangeLabel,
    formatShortDay,
    humanizeReportTitle,
    rangeWindow,
    renderDayMarkdown,
    reportProjects,
    type ReportCategory,
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
  // Fold weekends for display; the stored run keeps true-dated days.
  const days = $derived(run ? foldWeekends(run.days, run.range) : []);
  const rangeLabel = $derived(
    run
      ? run.since && run.until
        ? formatRangeLabel(run.since, run.until)
        : rangeWindow(run.range, run.anchorDate).label
      : "",
  );
  const pending = $derived(app.report.pending !== null);
  const connected = $derived(app.connectionStatus === "connected");
  const multiProject = $derived(run ? reportProjects(run).length > 1 : false);
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

  function download(filename: string, md: string) {
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportAll() {
    if (!run) return;
    download(
      `pinta-report-${run.range}-${run.anchorDate}.md`,
      app.exportReportMarkdown(),
    );
  }

  function exportDay(date: string, items: ReportItem[]) {
    download(
      `pinta-report-${date}.md`,
      renderDayMarkdown({ date, items }, multiProject),
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

{#snippet itemRow(item: ReportItem)}
  <li class="flex items-start gap-2 px-3 py-2">
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
    <div class="min-w-0 flex-1 text-[12.5px] text-ink-800 dark:text-night-text leading-snug">
      {#if item.ref}
        {#if item.url}
          <a href={item.url} target="_blank" rel="noopener noreferrer" class="font-mono text-[11.5px] text-brand-pink dark:text-brand-pink-light hover:underline">{item.ref}</a>
        {:else}
          <span class="font-mono text-[11.5px] text-ink-500 dark:text-night-mute">{item.ref}</span>
        {/if}
        <span class="text-ink-400 dark:text-night-mute"> — </span>
      {/if}<span class="break-words">{humanizeReportTitle(item.title)}</span>
      {#if item.detail}
        <p class="text-[11px] text-ink-500 dark:text-night-dim mt-0.5 break-words">{item.detail}</p>
      {/if}
    </div>
  </li>
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
                    class="px-1.5 py-1 rounded border border-ink-200 dark:border-night-line bg-white dark:bg-night-bg text-ink-800 dark:text-night-text text-[11px] focus:outline-none focus:ring-1 focus:ring-brand-pink/40"
                  />
                </label>
                <label class="flex items-center justify-between gap-2 text-[11px] text-ink-600 dark:text-night-dim">
                  To
                  <input
                    type="date"
                    value={app.report.customUntil}
                    onchange={onCustomUntil}
                    class="px-1.5 py-1 rounded border border-ink-200 dark:border-night-line bg-white dark:bg-night-bg text-ink-800 dark:text-night-text text-[11px] focus:outline-none focus:ring-1 focus:ring-brand-pink/40"
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
  {:else if run && days.length > 0}
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
          <button
            type="button"
            class="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded text-ink-400 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light hover:bg-ink-100 dark:hover:bg-night-line"
            onclick={() => exportDay(day.date, day.items)}
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
        <ul class="divide-y divide-ink-100 dark:divide-night-line/60">
          {#each day.items as item (item.id)}
            {@render itemRow(item)}
          {/each}
        </ul>
      </div>
    {/each}
  {:else if run}
    <p class="text-xs text-ink-500 dark:text-night-mute italic">
      No tasks found for {rangeLabel}. Try a wider range from the filter.
    </p>
  {:else}
    <p class="text-xs text-ink-500 dark:text-night-mute italic leading-snug">
      No report yet. Pick a range from the filter <span class="font-medium">▾</span>, optionally add
      repos via the projects <span class="font-medium">⚙</span>, then hit the
      refresh icon to generate — the agent gathers your bug fixes, polishes,
      tests, annotations, and merges, grouped by day. Export any day or the
      whole range as clean markdown.
    </p>
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
