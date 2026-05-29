<script lang="ts">
  // Phase 15a — AuditFlow tab. Lighthouse-style audit surface for
  // Pinta: pick categories, run audit, get back per-category scores +
  // actionable checks. Each check has a "Fix with agent" action that
  // routes through the existing Annotate pipeline (pre-fills an
  // annotation draft with the check's context; user reviews then
  // submits).
  //
  // 15a scope: Security only, card view, single-check Fix-with-agent.
  // Performance / Accessibility / Mobile / Cross-Browser land in 15b
  // (categories array is already general so adding them is a SKILL.md
  // + checkbox change, not a code rewrite). Discuss / File-issue
  // handoffs land in 15e. Cross-run fingerprint persistence + Ignore
  // / Snooze land in 15d.

  import type { AuditCategoryId, AuditCheck } from "@pinta/shared";
  import { app } from "../lib/state.svelte.js";
  import { parseStep } from "../lib/step-md.js";
  import { statusGlyph } from "../lib/audit-flow.js";

  // Active tab switch is passed down so Fix-with-agent can flip to
  // Annotate after composing the draft. Parent (App.svelte) owns the
  // tab state.
  type Props = {
    onSwitchToAnnotate: () => void;
  };
  let { onSwitchToAnnotate }: Props = $props();

  // Card expansion — keyed by category id. Default collapsed when a
  // category has only passing checks; expanded otherwise so the user
  // sees fail/warn rows immediately. Recomputed when the run changes.
  let expanded = $state<Record<string, boolean>>({});
  // Track per-check "handoff fired" state so the Fix button visibly
  // confirms after click + disables briefly (prevents double-tap
  // duplicates). Keyed by check id. Reset when a new run lands.
  let handedOff = $state<Record<string, true>>({});
  // Per-check expanded body — clicking the row toggles the
  // description / where / fix-hint detail.
  let openCheckId = $state<string | null>(null);

  // Compute default-expanded state when a new run lands so the user
  // sees failures + warnings without manual expansion. Re-runs only
  // when the run id changes so manual collapses stick.
  let lastRunId = $state<string | null>(null);
  $effect(() => {
    const run = app.audit.currentRun;
    if (!run) return;
    if (run.runId === lastRunId) return;
    lastRunId = run.runId;
    const next: Record<string, boolean> = {};
    for (const cat of run.categories) {
      const hasIssue = cat.checks.some(
        (c) => c.status === "fail" || c.status === "warn",
      );
      next[cat.id] = hasIssue;
    }
    expanded = next;
    handedOff = {};
    openCheckId = null;
  });

  const running = $derived(app.audit.pending !== null);
  const hasRun = $derived(app.audit.currentRun !== null);

  // Score color tiers — locked thresholds per the parked spec:
  // 90+ green (excellent), 50-89 amber (needs work), <50 red (poor).
  function scoreColor(score: number): string {
    if (score >= 90) return "text-emerald-600 dark:text-emerald-400";
    if (score >= 50) return "text-amber-600 dark:text-amber-400";
    return "text-red-600 dark:text-red-400";
  }
  function scoreRingColor(score: number): string {
    if (score >= 90) return "stroke-emerald-500";
    if (score >= 50) return "stroke-amber-500";
    return "stroke-red-500";
  }

  function statusBadgeClass(status: AuditCheck["status"]): string {
    switch (status) {
      case "pass":
        return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800/50";
      case "warn":
        return "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300 border-amber-300 dark:border-amber-800/50";
      case "fail":
        return "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300 border-red-300 dark:border-red-800/50";
      case "info":
      default:
        return "bg-ink-100 text-ink-700 dark:bg-night-alt dark:text-night-dim border-ink-300 dark:border-night-line";
    }
  }

  function categoryTally(checks: AuditCheck[]): {
    pass: number;
    warn: number;
    fail: number;
    info: number;
  } {
    let pass = 0,
      warn = 0,
      fail = 0,
      info = 0;
    for (const c of checks) {
      if (c.status === "pass") pass++;
      else if (c.status === "warn") warn++;
      else if (c.status === "fail") fail++;
      else if (c.status === "info") info++;
    }
    return { pass, warn, fail, info };
  }

  async function runAudit() {
    await app.runAudit();
  }

  // 15b — category picker. Five categories total per the parked
  // spec; Cross-Browser stays disabled until we ship the
  // browser-target picker + supportMatrix renderer (deferred).
  // Each entry has an icon character (rendered as text in the chip)
  // + display label + the wire id sent to the agent.
  type PickerCategory = {
    id: AuditCategoryId;
    label: string;
    /** When true, the row is greyed out + un-tickable. Used for
     *  Cross-Browser pre-implementation so the user can see it's
     *  on the roadmap without picking it. */
    soon?: boolean;
    /** Short tooltip describing what the category checks. */
    blurb: string;
  };
  const PICKER_CATEGORIES: PickerCategory[] = [
    {
      id: "security",
      label: "Security",
      blurb:
        "XSS, CSRF, secret leakage, eval / {@html} misuse, dependency advisories.",
    },
    {
      id: "performance",
      label: "Performance",
      blurb:
        "Bundle size, runtime hotspots, lazy-load opportunities, render-blocking resources.",
    },
    {
      id: "accessibility",
      label: "Accessibility",
      blurb:
        "ARIA misuse, missing alt text, focus order, label associations, color contrast.",
    },
    {
      id: "mobile",
      label: "Mobile",
      blurb:
        "Viewport meta, touch-target sizing, horizontal-scroll regressions, modal overlap on small viewports.",
    },
    {
      id: "cross-browser",
      label: "Cross-Browser",
      soon: true,
      blurb:
        "CSS / JS features unsupported in target browsers via caniuse + browserslist. Coming in a later patch — needs the browser-target picker UI.",
    },
  ];

  function isCategorySelected(id: AuditCategoryId): boolean {
    return app.audit.selectedCategories.includes(id);
  }

  function toggleCategoryPick(id: AuditCategoryId, on: boolean) {
    const current = app.audit.selectedCategories;
    let next: AuditCategoryId[];
    if (on && !current.includes(id)) {
      // Preserve the picker order rather than append — UX reads more
      // naturally if "all five ticked" matches the visible list order.
      next = PICKER_CATEGORIES.filter(
        (c) => !c.soon && (c.id === id || current.includes(c.id)),
      ).map((c) => c.id);
    } else if (!on) {
      next = current.filter((c) => c !== id);
    } else {
      return;
    }
    if (next.length === 0) return; // need at least one
    app.setAuditSelectedCategories(next);
  }

  function cancelAudit() {
    app.cancelAudit();
  }

  function clearRun() {
    if (running) return;
    app.clearAuditRun();
  }

  async function handoffToAnnotate(check: AuditCheck) {
    const id = await app.handoffAuditCheckToAnnotate(check);
    if (id) {
      handedOff[check.id] = true;
      onSwitchToAnnotate();
    }
  }

  function toggleCategory(id: string) {
    expanded[id] = !expanded[id];
  }

  function toggleCheck(id: string) {
    openCheckId = openCheckId === id ? null : id;
  }

  // Run duration in seconds, computed from the run's timing fields.
  function runDurationLabel(): string {
    const run = app.audit.currentRun;
    if (!run?.completedAt) return "";
    const secs = Math.round((run.completedAt - run.startedAt) / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    return `${mins}m ${secs % 60}s`;
  }
</script>

<section class="space-y-4 p-4">
  <!-- HEADER -->
  <div class="flex items-start justify-between gap-3 flex-wrap">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-brand-pink dark:text-brand-pink-light shrink-0" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/>
          <path d="M9 12l2 2 4-4"/>
        </svg>
        <h2 class="text-base font-bold text-ink-900 dark:text-night-text">AuditFlow</h2>
      </div>
      <p class="text-[12px] text-ink-600 dark:text-night-dim leading-snug mt-1">
        Lighthouse-style audits on your project. Each finding is one click from
        being fixed — <strong>Fix with agent</strong> opens the Annotate tab
        with a draft pre-filled with the check details.
      </p>
    </div>
  </div>

  <!-- RUN CONTROLS / IN-FLIGHT -->
  {#if running}
    <div class="rounded-lg border border-brand-pink/30 bg-brand-pink/5 dark:bg-brand-pink/10 p-4 space-y-2">
      <div class="flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin text-brand-pink dark:text-brand-pink-light" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        <span class="text-[12.5px] font-semibold text-ink-900 dark:text-night-text">Running audit…</span>
      </div>
      <p class="text-[11.5px] text-ink-600 dark:text-night-dim leading-snug">
        The agent is inspecting your project. This typically takes 30s-2min for the Security category.
      </p>
      <button
        type="button"
        class="text-[11px] text-ink-600 dark:text-night-dim hover:text-red-600 dark:hover:text-red-400 underline"
        onclick={cancelAudit}
      >
        Cancel
      </button>
    </div>
  {:else if !hasRun}
    {@const pickedCount = app.audit.selectedCategories.length}
    <div class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-4 space-y-3">
      <div>
        <h3 class="text-[13px] font-bold text-ink-900 dark:text-night-text">
          Run your first audit
        </h3>
        <p class="text-[12px] text-ink-600 dark:text-night-dim leading-snug mt-1">
          Pick the categories you want the agent to inspect. Each one runs
          independently — turn on what's relevant to skip the rest.
        </p>
      </div>
      <div class="space-y-1.5">
        {#each PICKER_CATEGORIES as cat (cat.id)}
          {@const picked = isCategorySelected(cat.id) && !cat.soon}
          <label
            class="flex items-start gap-2 text-[12px] leading-snug select-none rounded-md px-2 py-1.5 transition-colors"
            class:cursor-pointer={!cat.soon}
            class:cursor-not-allowed={cat.soon}
            class:opacity-60={cat.soon}
            class:hover:bg-ink-50={!cat.soon}
            class:dark:hover:bg-night-alt={!cat.soon}
          >
            <input
              type="checkbox"
              class="mt-0.5 accent-brand-pink shrink-0"
              checked={picked}
              disabled={cat.soon}
              onchange={(e) =>
                toggleCategoryPick(
                  cat.id,
                  (e.currentTarget as HTMLInputElement).checked,
                )}
            />
            <span class="flex-1">
              <span class="font-semibold text-ink-900 dark:text-night-text inline-flex items-center gap-1.5">
                {cat.label}
                {#if cat.soon}
                  <span class="inline-flex items-center text-[9px] uppercase tracking-wider font-bold text-ink-500 dark:text-night-mute bg-ink-100 dark:bg-night-alt border border-ink-300 dark:border-night-line rounded-full px-1.5 py-0.5">
                    Soon
                  </span>
                {/if}
              </span>
              <span class="block text-[11px] text-ink-600 dark:text-night-dim mt-0.5">
                {cat.blurb}
              </span>
            </span>
          </label>
        {/each}
      </div>
      <button
        type="button"
        class="w-full rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50 inline-flex items-center justify-center gap-2"
        onclick={runAudit}
        disabled={app.connectionStatus !== "connected" || pickedCount === 0}
        title={app.connectionStatus !== "connected"
          ? "Connect a companion (run `pinta-companion .` in your project) to use AuditFlow"
          : pickedCount === 0
            ? "Pick at least one category before running"
            : `Run audit across ${pickedCount} categor${pickedCount === 1 ? "y" : "ies"}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Run audit
        {#if pickedCount > 0}
          <span class="text-[11px] font-normal opacity-80">· {pickedCount} categor{pickedCount === 1 ? "y" : "ies"}</span>
        {/if}
      </button>
      {#if app.connectionStatus !== "connected"}
        <p class="text-[11px] text-red-600 dark:text-red-400 leading-snug">
          Companion disconnected. Run <code class="font-mono text-[10.5px] bg-red-100 dark:bg-red-950/40 px-1 rounded">pinta-companion .</code> in your project root and reconnect.
        </p>
      {/if}
    </div>
  {/if}

  {#if app.audit.error}
    <div class="rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[12px] text-red-700 dark:text-red-300 leading-snug">
      {app.audit.error}
    </div>
  {/if}

  <!-- RESULTS -->
  {#if hasRun && !running}
    {@const run = app.audit.currentRun}
    {#if run}
      <!-- Overall score card — circular ring + rating + run actions -->
      <div class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-4 flex items-center gap-4">
        <!-- SVG circular score ring.
             fill="none" set as an explicit SVG attribute (not via the
             Tailwind `fill-none` class) so the circle stays
             transparent regardless of whether Tailwind picked up the
             utility for this file. Default <circle> fill is black,
             which previously painted both rings as solid discs and
             obscured the score number. Stroke colors stay on classes
             — those are present in TestPilotTab so Tailwind already
             generates them. -->
        <div class="relative shrink-0">
          <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
            <circle
              cx="32"
              cy="32"
              r="28"
              fill="none"
              class="stroke-ink-200 dark:stroke-night-line"
              stroke-width="6"
            />
            <circle
              cx="32"
              cy="32"
              r="28"
              fill="none"
              stroke-width="6"
              stroke-linecap="round"
              class={scoreRingColor(run.overall)}
              stroke-dasharray={`${(run.overall / 100) * 175.93} 175.93`}
              transform="rotate(-90 32 32)"
            />
          </svg>
          <div class="absolute inset-0 inline-flex items-center justify-center">
            <span class="text-[15px] font-bold tabular-nums {scoreColor(run.overall)}">{run.overall}</span>
          </div>
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-[10px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute">Overall</div>
          <div class="text-[14px] font-bold text-ink-900 dark:text-night-text leading-snug">{run.rating}</div>
          <div class="text-[11px] text-ink-500 dark:text-night-mute mt-0.5">
            Ran {runDurationLabel() || "just now"} · {run.categories.length} categor{run.categories.length === 1 ? "y" : "ies"}
          </div>
        </div>
        <div class="shrink-0 flex flex-col gap-1.5">
          <button
            type="button"
            class="rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-alt text-ink-700 dark:text-night-dim text-[11.5px] font-semibold px-2.5 py-1 hover:bg-ink-50 dark:hover:bg-night-line disabled:opacity-50"
            onclick={runAudit}
            disabled={app.connectionStatus !== "connected"}
            title="Re-run the audit with the same scope + categories"
          >
            Re-run
          </button>
          <button
            type="button"
            class="rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-alt text-ink-700 dark:text-night-dim text-[11px] font-medium px-2.5 py-1 hover:bg-ink-50 dark:hover:bg-night-line"
            onclick={clearRun}
            title="Clear the saved results"
          >
            Clear
          </button>
        </div>
      </div>

      <!-- Per-category cards -->
      {#each run.categories as category (category.id)}
        {@const tally = categoryTally(category.checks)}
        {@const isOpen = expanded[category.id] ?? false}
        <div class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card overflow-hidden">
          <button
            type="button"
            class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-ink-50 dark:hover:bg-night-alt transition-colors"
            onclick={() => toggleCategory(category.id)}
            aria-expanded={isOpen}
          >
            <!-- Small category ring. Same fill="none" attribute fix
                 as the overall score ring above — avoids the default
                 black circle fill obscuring the ring. -->
            <div class="relative shrink-0">
              <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
                <circle
                  cx="18"
                  cy="18"
                  r="15"
                  fill="none"
                  class="stroke-ink-200 dark:stroke-night-line"
                  stroke-width="3.5"
                />
                <circle
                  cx="18"
                  cy="18"
                  r="15"
                  fill="none"
                  stroke-width="3.5"
                  stroke-linecap="round"
                  class={scoreRingColor(category.score)}
                  stroke-dasharray={`${(category.score / 100) * 94.25} 94.25`}
                  transform="rotate(-90 18 18)"
                />
              </svg>
              <div class="absolute inset-0 inline-flex items-center justify-center">
                <span class="text-[10px] font-bold tabular-nums {scoreColor(category.score)}">{Math.round(category.score)}</span>
              </div>
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-[12.5px] font-bold text-ink-900 dark:text-night-text leading-tight">{category.name}</div>
              <div class="text-[11px] text-ink-500 dark:text-night-mute mt-0.5 tabular-nums">
                {#if tally.fail > 0}<span class="text-red-600 dark:text-red-400 font-semibold">{tally.fail} fail</span> · {/if}
                {#if tally.warn > 0}<span class="text-amber-600 dark:text-amber-400 font-semibold">{tally.warn} warn</span> · {/if}
                <span class="text-emerald-600 dark:text-emerald-400">{tally.pass} pass</span>
                {#if tally.info > 0} · <span>{tally.info} info</span>{/if}
              </div>
            </div>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="transition-transform shrink-0 text-ink-500 dark:text-night-mute" class:rotate-90={isOpen} aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
          </button>

          {#if isOpen}
            <ul class="border-t border-ink-200 dark:border-night-line divide-y divide-ink-100 dark:divide-night-line/60">
              {#each category.checks as check (check.id)}
                {@const checkOpen = openCheckId === check.id}
                {@const hasActions =
                  check.status !== "pass" &&
                  (check.fixHint != null ||
                    check.suggestedAnnotation != null ||
                    check.where?.file != null)}
                <li>
                  <button
                    type="button"
                    class="w-full text-left flex items-start gap-2.5 px-3 py-2.5 hover:bg-ink-50 dark:hover:bg-night-alt transition-colors"
                    onclick={() => toggleCheck(check.id)}
                    aria-expanded={checkOpen}
                  >
                    <span class="shrink-0 mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded border text-[10px] font-bold {statusBadgeClass(check.status)}" aria-label={check.status}>
                      {statusGlyph(check.status)}
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="text-[12.5px] font-semibold text-ink-900 dark:text-night-text leading-snug">{check.label}</div>
                      {#if check.value}
                        <div class="text-[11px] text-ink-600 dark:text-night-dim mt-0.5 tabular-nums">{check.value}</div>
                      {/if}
                      {#if check.where?.file}
                        <div class="text-[10.5px] text-ink-500 dark:text-night-mute mt-0.5 font-mono truncate" title={check.where.file}>
                          {check.where.file}{check.where.line ? `:${check.where.line}` : ""}
                        </div>
                      {/if}
                    </div>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="transition-transform shrink-0 text-ink-400 dark:text-night-mute mt-1" class:rotate-90={checkOpen} aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
                  </button>

                  {#if checkOpen}
                    <div class="px-3 pb-3 pt-1 space-y-2 bg-ink-50/50 dark:bg-night-alt/30">
                      {#if check.description}
                        {@const blocks = parseStep(check.description)}
                        <div class="text-[12px] text-ink-700 dark:text-night-dim leading-relaxed space-y-2">
                          {#each blocks as block, bi (bi)}
                            {#if block.kind === "text"}
                              <p>
                                {#each block.parts as part, pi (pi)}
                                  {#if part.kind === "code"}
                                    <code class="font-mono text-[11px] bg-white dark:bg-night-card text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                                  {:else if part.kind === "bold"}
                                    <strong class="font-semibold text-ink-900 dark:text-night-text">{part.value}</strong>
                                  {:else}
                                    <span>{part.value}</span>
                                  {/if}
                                {/each}
                              </p>
                            {:else if block.kind === "code"}
                              <pre class="rounded border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-2 py-1.5 text-[11px] font-mono overflow-x-auto">{block.body}</pre>
                            {:else if block.kind === "note"}
                              <div class="border-l-2 border-ink-300 dark:border-night-line pl-2 py-0.5 text-[11.5px] text-ink-600 dark:text-night-dim">
                                <span class="font-semibold text-ink-800 dark:text-night-text">Note:</span>
                                {#each block.parts as part, pi (pi)}
                                  {#if part.kind === "code"}
                                    <code class="font-mono text-[11px] bg-white dark:bg-night-card text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                                  {:else}
                                    <span>{part.value}</span>
                                  {/if}
                                {/each}
                              </div>
                            {/if}
                          {/each}
                        </div>
                      {/if}
                      {#if check.fixHint}
                        <div class="rounded border border-brand-pink/30 bg-brand-pink/5 dark:bg-brand-pink/10 px-2.5 py-1.5 text-[11.5px] text-ink-800 dark:text-night-text leading-snug">
                          <span class="font-semibold text-brand-pink dark:text-brand-pink-light">Fix hint:</span> {check.fixHint}
                        </div>
                      {/if}
                      {#if hasActions}
                        <div class="flex flex-wrap gap-1.5 pt-1">
                          <!-- Primary action — Fix with agent. Composes a
                               prefilled annotation, switches to Annotate
                               tab. After click, the button confirms +
                               disables so the user can't accidentally
                               double-handoff (which would duplicate the
                               draft annotation). -->
                          <button
                            type="button"
                            class="inline-flex items-center gap-1.5 rounded-md bg-brand-pink hover:bg-brand-magenta dark:hover:bg-brand-pink-light text-white text-[11px] font-semibold px-2.5 py-1 disabled:opacity-60 disabled:cursor-default"
                            onclick={() => handoffToAnnotate(check)}
                            disabled={handedOff[check.id]}
                            title={handedOff[check.id]
                              ? "Already handed off — switch to Annotate to review the draft"
                              : "Compose a Pinta annotation pre-filled with this check's details, open Annotate tab"}
                          >
                            {#if handedOff[check.id]}
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                              Drafted in Annotate
                            {:else}
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8 19 13"/><path d="M15 9h.01"/><path d="M17.8 6.2 19 5"/><path d="m3 21 9-9"/><path d="M12.2 6.2 11 5"/></svg>
                              Fix with agent
                            {/if}
                          </button>
                          <!-- Future handoffs (15e) — stubbed disabled
                               so the surface area is visible but not
                               actionable until those phases land. -->
                          <button
                            type="button"
                            class="inline-flex items-center gap-1.5 rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-card text-ink-500 dark:text-night-mute text-[11px] font-medium px-2.5 py-1 cursor-not-allowed opacity-60"
                            disabled
                            title="Discuss — routes to Chat (Phase 15e)"
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                            Discuss
                          </button>
                          <button
                            type="button"
                            class="inline-flex items-center gap-1.5 rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-card text-ink-500 dark:text-night-mute text-[11px] font-medium px-2.5 py-1 cursor-not-allowed opacity-60"
                            disabled
                            title="File as GitLab issue — Phase 15e"
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                            File issue
                          </button>
                        </div>
                      {/if}
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    {/if}
  {/if}
</section>
