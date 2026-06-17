<script lang="ts">
  // Phase 16 — Report module. View what you shipped (git + gh/glab +
  // Pinta activity, gathered by the /pinta agent) as Read-Mode day
  // cards, and export a clean markdown summary by icon. Range = Today /
  // This week / 10-day Sprint; weekend work folds into the lighter
  // adjacent weekday (done in report.ts, applied here at render).

  import { app } from "../lib/state.svelte.js";
  import {
    categoryLabel,
    foldWeekends,
    formatDayHeading,
    formatShortDay,
    rangeWindow,
    type ReportCategory,
    type ReportItem,
    type ReportRange,
  } from "../lib/report.js";

  const RANGES: { id: ReportRange; label: string; hint: string }[] = [
    { id: "daily", label: "Today", hint: "Just today's work" },
    { id: "weekly", label: "This week", hint: "Monday → today" },
    { id: "sprint", label: "Sprint", hint: "Last 10 working days" },
  ];

  const run = $derived(app.report.currentRun);
  // Fold weekends for display; the stored run keeps true-dated days.
  const days = $derived(run ? foldWeekends(run.days, run.range) : []);
  const rangeLabel = $derived(
    run ? rangeWindow(run.range, run.anchorDate).label : "",
  );
  const pending = $derived(app.report.pending !== null);
  const connected = $derived(app.connectionStatus === "connected");

  function pickRange(r: ReportRange) {
    app.setReportRange(r);
  }

  function generate() {
    void app.generateReport();
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
    const lines = [`## ${formatDayHeading(date)}`];
    for (const it of items) {
      lines.push(it.ref ? `- ${it.ref} — ${it.title}` : `- ${it.title}`);
    }
    download(`pinta-report-${date}.md`, lines.join("\n") + "\n");
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

<section class="space-y-3">
  <!-- Header: range selector + Generate + global export -->
  <div class="flex items-center justify-between gap-2">
    <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">
      Report
    </h2>
    {#if run}
      <button
        type="button"
        class="w-7 h-7 inline-flex items-center justify-center rounded-md text-ink-500 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light hover:bg-ink-100 dark:hover:bg-night-alt"
        onclick={exportAll}
        title="Export the whole report as markdown (.md)"
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

  <div class="flex items-center gap-1.5">
    {#each RANGES as r (r.id)}
      <button
        type="button"
        class="px-2.5 py-1 text-[11.5px] rounded-md border transition-colors"
        class:border-brand-pink={app.report.range === r.id}
        class:text-brand-pink={app.report.range === r.id}
        class:dark:text-brand-pink-light={app.report.range === r.id}
        class:border-ink-200={app.report.range !== r.id}
        class:dark:border-night-line={app.report.range !== r.id}
        class:text-ink-600={app.report.range !== r.id}
        class:dark:text-night-dim={app.report.range !== r.id}
        onclick={() => pickRange(r.id)}
        disabled={pending}
        title={r.hint}
      >
        {r.label}
      </button>
    {/each}
    <button
      type="button"
      class="ml-auto inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md bg-brand-pink text-white hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50"
      onclick={generate}
      disabled={pending || !connected}
      title={connected ? "Generate the report" : "Connect a companion to generate a report"}
    >
      {#if pending}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
        Generating…
      {:else}
        {run ? "Regenerate" : "Generate"}
      {/if}
    </button>
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
            aria-label="Export {formatDayHeading(day.date)} as markdown"
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
            <li class="flex items-start gap-2 px-3 py-2">
              <span class="shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium {chipClass(item.category)}">
                {categoryLabel(item.category)}
              </span>
              <div class="min-w-0 flex-1 text-[12.5px] text-ink-800 dark:text-night-text leading-snug">
                {#if item.ref}
                  {#if item.url}
                    <a href={item.url} target="_blank" rel="noopener noreferrer" class="font-mono text-[11.5px] text-brand-pink dark:text-brand-pink-light hover:underline">{item.ref}</a>
                  {:else}
                    <span class="font-mono text-[11.5px] text-ink-500 dark:text-night-mute">{item.ref}</span>
                  {/if}
                  <span class="text-ink-400 dark:text-night-mute"> — </span>
                {/if}<span class="break-words">{item.title}</span>
                {#if item.detail}
                  <p class="text-[11px] text-ink-500 dark:text-night-dim mt-0.5 break-words">{item.detail}</p>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  {:else if run}
    <p class="text-xs text-ink-500 dark:text-night-mute italic">
      No tasks found for {rangeLabel}. Try a wider range.
    </p>
  {:else}
    <p class="text-xs text-ink-500 dark:text-night-mute italic leading-snug">
      No report yet. Pick a range and hit Generate — the agent gathers your
      bug fixes, polishes, tests, annotations, and merges from git + your
      issue tracker + Pinta activity, grouped by day. Export any day or the
      whole range as clean markdown.
    </p>
  {/if}
</section>
