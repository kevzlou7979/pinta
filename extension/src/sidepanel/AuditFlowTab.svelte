<script lang="ts">
  // Phase 15 — AuditFlow tab. Lighthouse-style audit surface for
  // Pinta: pick categories, run audit, get back per-category scores +
  // actionable checks. Each check has a "Fix with agent" action that
  // routes through the existing Annotate pipeline (pre-fills an
  // annotation draft with the check's context; user reviews then
  // submits).
  //
  // Slice 1 — per-finding dispositions + progress bars.
  // Slice 2 — catalog editing (add / edit / delete / rename checks +
  //           categories), layered as a durable overlay over the agent run.
  // Slice 3 — "Suggest checks" AI affordance per category.
  // Slice 4 (this slice) — per-entry STREAMING: a skeleton checklist
  //           appears the moment the agent's `plan` lands, and each row
  //           fills in (loader → result) as its `check` event arrives,
  //           so a failing check is inspectable while the rest compute.
  //           The final mark_session_done AuditRun stays authoritative.

  import { onMount, tick } from "svelte";
  import type {
    AuditCategoryId,
    AuditCheck,
    AuditCheckStatus,
    AuditDisposition,
  } from "@pinta/shared";
  import { app } from "../lib/state.svelte.js";
  import { parseStep } from "../lib/step-md.js";
  import { auditProgress, statusGlyph } from "../lib/audit-flow.js";

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

  // A run is in flight at all (full OR single-category). Gates the run
  // buttons so only one audit runs at a time.
  const auditBusy = $derived(app.audit.pending !== null);
  // The full-screen "Running audit…" panel only shows for a FULL run —
  // a single-category re-run (`partial`) keeps the results visible and
  // shows a per-card spinner instead.
  const running = $derived(auditBusy && !app.audit.pending?.partial);
  // Id of the category being re-run on its own (⋮ → Re-run category),
  // or null. Drives the per-card spinner.
  const reRunningCategory = $derived(
    app.audit.pending?.partial ? (app.audit.pending?.categoryId ?? null) : null,
  );
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

  // An "actionable" check (fail / warn) carries a remediation
  // disposition the user works through. pass / info don't.
  function isActionable(check: AuditCheck): boolean {
    return check.status === "fail" || check.status === "warn";
  }

  // Effective disposition for a check — absent from the map means the
  // user hasn't touched it yet, which reads as "open". Only meaningful
  // for actionable checks.
  function dispositionOf(check: AuditCheck): AuditDisposition {
    return app.audit.dispositions[check.id] ?? "open";
  }

  // The segmented-control options, in display order.
  const DISPOSITIONS: { value: AuditDisposition; label: string }[] = [
    { value: "open", label: "Open" },
    { value: "fixing", label: "Fixing" },
    { value: "resolved", label: "Resolved" },
    { value: "wont-fix", label: "Won't-fix" },
  ];

  function dispositionLabel(d: AuditDisposition): string {
    return DISPOSITIONS.find((o) => o.value === d)?.label ?? "Open";
  }

  // Collapsed-row dot tint per disposition so progress is visible at a
  // glance without expanding the check.
  function dispositionDotClass(d: AuditDisposition): string {
    switch (d) {
      case "fixing":
        return "bg-amber-500";
      case "resolved":
        return "bg-emerald-500";
      case "wont-fix":
        return "bg-ink-400 dark:bg-night-mute";
      case "open":
      default:
        return "bg-ink-300 dark:bg-night-line";
    }
  }

  // USER- checks (overlay additions) get an "added" chip; custom
  // categories carry an `audit-flow-custom:` id prefix.
  function isUserCheck(id: string): boolean {
    return id.startsWith("USER-");
  }
  function isCustomCategory(id: string): boolean {
    return id.startsWith("audit-flow-custom:");
  }

  // ─── Category picker (empty state) ──────────────────────────────────
  // Five categories. Security is live; the rest are wired but flagged
  // "Soon" until their SKILL.md handlers land.
  type PickerCategory = {
    id: AuditCategoryId;
    label: string;
    keywords: string;
    blurb: string;
    soon?: boolean;
  };
  const PICKER_CATEGORIES: PickerCategory[] = [
    {
      id: "security",
      label: "Security",
      keywords: "XSS · secrets · injection · CSP",
      blurb:
        "Scans for unsafe DOM sinks, hardcoded secrets, injection paths, and missing hardening.",
    },
    {
      id: "performance",
      label: "Performance",
      keywords: "bundle size · render · network",
      blurb:
        "Bundle weight, render-blocking work, and network waterfalls. Coming in a later patch.",
      soon: true,
    },
    {
      id: "accessibility",
      label: "Accessibility",
      keywords: "ARIA · contrast · keyboard",
      blurb:
        "ARIA, color contrast, and keyboard navigation. Coming in a later patch.",
      soon: true,
    },
    {
      id: "mobile",
      label: "Mobile",
      keywords: "viewport · touch targets · responsive",
      blurb:
        "Viewport config, touch-target sizing, and responsive breakpoints. Coming in a later patch.",
      soon: true,
    },
    {
      id: "cross-browser",
      label: "Cross Browser",
      keywords: "caniuse · browserslist · polyfills",
      blurb:
        "CSS / JS features unsupported in target browsers via caniuse + browserslist. Coming in a later patch — needs the browser-target picker UI.",
      soon: true,
    },
  ];

  function isCategorySelected(id: AuditCategoryId): boolean {
    return app.audit.selectedCategories.includes(id);
  }

  function toggleCategoryPick(id: AuditCategoryId, on: boolean): void {
    const current = new Set(app.audit.selectedCategories);
    if (on) current.add(id);
    else current.delete(id);
    // Preserve the picker order rather than append — UX reads more
    // predictably when toggles don't reorder.
    const next = PICKER_CATEGORIES.map((c) => c.id).filter((cid) =>
      current.has(cid),
    );
    if (next.length === 0) return; // never allow zero
    app.setAuditSelectedCategories(next);
  }

  function runAudit(): void {
    void app.runAudit();
  }
  function cancelAudit(): void {
    app.cancelAudit();
  }
  function clearAudit(): void {
    if (
      confirm(
        "Clear this audit run? Your dispositions and custom checks for it will be removed.",
      )
    ) {
      app.clearAuditRun();
    }
  }

  function toggleCategory(id: string): void {
    expanded[id] = !(expanded[id] ?? false);
  }
  function toggleCheck(id: string): void {
    openCheckId = openCheckId === id ? null : id;
  }

  // ─── Fix-with-agent handoff ─────────────────────────────────────────
  async function handoffToAnnotate(check: AuditCheck): Promise<void> {
    const id = await app.handoffAuditCheckToAnnotate(check);
    if (id) {
      handedOff[check.id] = true;
      onSwitchToAnnotate();
    }
  }

  // ─── Category kebab (Add check · Suggest checks · Rename · Delete) ───
  let categoryKebabOpen = $state<string | null>(null);
  function toggleCategoryKebab(id: string): void {
    categoryKebabOpen = categoryKebabOpen === id ? null : id;
  }

  // ─── Inline check editor ────────────────────────────────────────────
  let editingCheckId = $state<string | null>(null);
  let editCheckLabel = $state("");
  let editCheckDescription = $state("");
  function startEditCheck(check: AuditCheck): void {
    editingCheckId = check.id;
    editCheckLabel = check.label;
    editCheckDescription = check.description ?? "";
    openCheckId = check.id; // keep the body open
    void focusEditCheck(check.id);
  }
  async function focusEditCheck(id: string): Promise<void> {
    await tick();
    const el = document.querySelector<HTMLInputElement>(
      `[data-audit-edit-check="${id}"]`,
    );
    el?.focus();
    el?.select();
  }
  function commitEditCheck(checkId: string): void {
    const label = editCheckLabel.trim();
    if (!label) return;
    app.editAuditCheck(checkId, {
      label,
      description: editCheckDescription.trim(),
    });
    editingCheckId = null;
  }
  function cancelEditCheck(): void {
    editingCheckId = null;
  }
  function onDeleteCheck(checkId: string): void {
    if (confirm("Delete this check?")) {
      if (openCheckId === checkId) openCheckId = null;
      app.deleteAuditCheck(checkId);
    }
  }

  // ─── Add check (per-category, via kebab) ────────────────────────────
  let addingCheckCategory = $state<string | null>(null);
  let newCheckLabel = $state("");
  let newCheckDescription = $state("");
  function openAddCheck(categoryId: string): void {
    addingCheckCategory = categoryId;
    newCheckLabel = "";
    newCheckDescription = "";
    categoryKebabOpen = null;
    expanded[categoryId] = true;
    void focusAddCheck();
  }
  async function focusAddCheck(): Promise<void> {
    await tick();
    const el = document.querySelector<HTMLInputElement>("[data-audit-add-check]");
    el?.focus();
  }
  function commitAddCheck(): void {
    const label = newCheckLabel.trim();
    if (!label || !addingCheckCategory) return;
    app.addAuditCheck(addingCheckCategory, {
      label,
      description: newCheckDescription.trim() || undefined,
    });
    addingCheckCategory = null;
  }
  function cancelAddCheck(): void {
    addingCheckCategory = null;
  }

  // ─── Add / rename / delete category ─────────────────────────────────
  let addingCategory = $state(false);
  let newCategoryName = $state("");
  function startAddCategory(): void {
    addingCategory = true;
    newCategoryName = "";
    void focusAddCategory();
  }
  async function focusAddCategory(): Promise<void> {
    await tick();
    const el = document.querySelector<HTMLInputElement>(
      "[data-audit-add-category]",
    );
    el?.focus();
  }
  function commitAddCategory(): void {
    const name = newCategoryName.trim();
    if (!name) return;
    app.addAuditCategory(name);
    addingCategory = false;
  }

  let renamingCategory = $state<string | null>(null);
  let renameCategoryName = $state("");
  function startRenameCategory(categoryId: string, current: string): void {
    renamingCategory = categoryId;
    renameCategoryName = current;
    categoryKebabOpen = null;
    void focusRenameCategory(categoryId);
  }
  async function focusRenameCategory(id: string): Promise<void> {
    await tick();
    const el = document.querySelector<HTMLInputElement>(
      `[data-audit-rename-category="${id}"]`,
    );
    el?.focus();
    el?.select();
  }
  function commitRenameCategory(categoryId: string): void {
    const name = renameCategoryName.trim();
    if (!name) return;
    app.renameAuditCategory(categoryId, name);
    renamingCategory = null;
  }
  function cancelRenameCategory(): void {
    renamingCategory = null;
  }
  function onDeleteCategory(categoryId: string): void {
    categoryKebabOpen = null;
    if (confirm("Delete this category and its checks from the run?")) {
      app.deleteAuditCategory(categoryId);
    }
  }

  // ─── "Suggest checks" inline checklist (Slice 3) ────────────────────
  // The agent's returned suggestions live in `app.audit.suggestions`
  // (label/description/status only). The per-suggestion "ticked" state
  // is a local UI concern, tracked here keyed by `${categoryId}:${index}`
  // and defaulting to true (everything pre-ticked) until the user
  // unticks. Cleared when the suggestion set is added or dismissed.
  let suggestionUnchecked = $state<Record<string, boolean>>({});
  function suggestionKey(categoryId: string, index: number): string {
    return `${categoryId}:${index}`;
  }
  function isSuggestionChecked(categoryId: string, index: number): boolean {
    return !suggestionUnchecked[suggestionKey(categoryId, index)];
  }
  function toggleSuggestion(categoryId: string, index: number, on: boolean): void {
    const key = suggestionKey(categoryId, index);
    if (on) delete suggestionUnchecked[key];
    else suggestionUnchecked[key] = true;
  }
  function suggestionPickedCount(categoryId: string): number {
    const list = app.audit.suggestions[categoryId] ?? [];
    return list.filter((_, i) => isSuggestionChecked(categoryId, i)).length;
  }
  function clearSuggestionChecks(categoryId: string): void {
    const prefix = `${categoryId}:`;
    for (const key of Object.keys(suggestionUnchecked)) {
      if (key.startsWith(prefix)) delete suggestionUnchecked[key];
    }
  }
  function addSuggestions(categoryId: string): void {
    const suggestions = app.audit.suggestions[categoryId] ?? [];
    const picked = suggestions.filter((_, i) =>
      isSuggestionChecked(categoryId, i),
    );
    if (picked.length === 0) return;
    app.addAuditCheckedSuggestions(
      categoryId,
      picked.map((p) => ({
        label: p.label,
        description: p.description,
        status: p.status,
      })),
    );
    clearSuggestionChecks(categoryId);
  }
  function dismissSuggestions(categoryId: string): void {
    app.dismissAuditSuggestions(categoryId);
    clearSuggestionChecks(categoryId);
  }

  // Close the kebab menu on any outside click.
  onMount(() => {
    function onDocClick(e: MouseEvent): void {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const inKebab =
        target.closest("[data-audit-kebab-trigger]") ||
        target.closest("[data-audit-kebab-menu]");
      if (!inKebab) categoryKebabOpen = null;
    }
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
  });
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

  <!-- ─────────────────────────────────────────────────────────────────
       Per-check row snippet. Defined at the top level of <section> so the
       final results view can render it — an inspectable row (expandable
       body, disposition control, Fix-with-agent, Edit/Delete) instead of
       duplicating ~200 lines inline. Closes over the module-scope helpers
       (openCheckId, toggleCheck, handoffToAnnotate, dispositionOf,
       statusBadgeClass, statusGlyph, parseStep, editingCheckId, …).
       ──────────────────────────────────────────────────────────────── -->
  {#snippet checkRow(check: AuditCheck)}
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
          <div class="flex items-start gap-1.5">
            <div class="text-[12.5px] font-semibold text-ink-900 dark:text-night-text leading-snug">{check.label}</div>
            {#if isUserCheck(check.id)}
              <span class="shrink-0 mt-px inline-flex items-center rounded-sm bg-brand-pink/10 text-brand-pink dark:text-brand-pink-light text-[9px] font-semibold uppercase tracking-wide px-1 py-px" title="Check you added">added</span>
            {/if}
          </div>
          {#if check.value}
            <div class="text-[11px] text-ink-600 dark:text-night-dim mt-0.5 tabular-nums">{check.value}</div>
          {/if}
          {#if check.where?.file}
            <div class="text-[10.5px] text-ink-500 dark:text-night-mute mt-0.5 font-mono truncate" title={check.where.file}>
              {check.where.file}{check.where.line ? `:${check.where.line}` : ""}
            </div>
          {/if}
        </div>
        <!-- Disposition hint — tiny dot + 1-word chip so progress is
             visible without expanding. Only for actionable findings. -->
        {#if isActionable(check)}
          {@const d = dispositionOf(check)}
          <span class="shrink-0 mt-0.5 inline-flex items-center gap-1 text-[10px] text-ink-500 dark:text-night-mute tabular-nums" title={`Disposition: ${dispositionLabel(d)}`}>
            <span class="w-1.5 h-1.5 rounded-full {dispositionDotClass(d)}" aria-hidden="true"></span>
            {dispositionLabel(d)}
          </span>
        {/if}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="transition-transform shrink-0 text-ink-400 dark:text-night-mute mt-1" class:rotate-90={checkOpen} aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
      </button>

      {#if checkOpen}
        <div class="px-3 pb-3 pt-1 space-y-2 bg-ink-50/50 dark:bg-night-alt/30">
          {#if editingCheckId === check.id}
            <!-- Inline check editor (label + description). -->
            <div class="space-y-2">
              <input
                data-audit-edit-check={check.id}
                type="text"
                bind:value={editCheckLabel}
                class="w-full rounded-md border border-brand-pink/50 bg-white dark:bg-night-card px-2 py-1.5 text-[12.5px] text-ink-900 dark:text-night-text focus:outline-none focus:ring-1 focus:ring-brand-pink"
                placeholder="Check label (required)"
                onkeydown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitEditCheck(check.id); }
                  else if (e.key === "Escape") { e.preventDefault(); cancelEditCheck(); }
                }}
              />
              <textarea
                bind:value={editCheckDescription}
                rows="3"
                class="w-full rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-card px-2 py-1.5 text-[12px] text-ink-700 dark:text-night-dim focus:outline-none focus:ring-1 focus:ring-brand-pink resize-y"
                placeholder="Description (optional)"
              ></textarea>
              <div class="flex items-center justify-end gap-2">
                <button
                  type="button"
                  class="rounded-md text-[11.5px] font-medium px-2.5 py-1 text-ink-600 dark:text-night-dim hover:bg-ink-100 dark:hover:bg-night-line"
                  onclick={cancelEditCheck}
                >Cancel</button>
                <button
                  type="button"
                  class="rounded-md bg-brand-pink hover:bg-brand-magenta dark:hover:bg-brand-pink-light text-white text-[11.5px] font-semibold px-2.5 py-1 disabled:opacity-50"
                  onclick={() => commitEditCheck(check.id)}
                  disabled={!editCheckLabel.trim()}
                >Save</button>
              </div>
            </div>
          {:else}
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
              <!-- Primary action — Fix with agent. Composes a prefilled
                   annotation, switches to Annotate tab. After click the
                   button confirms + disables so the user can't
                   accidentally double-handoff (which would duplicate the
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
              <!-- Future handoffs (15e) — stubbed disabled so the surface
                   area is visible but not actionable until those phases
                   land. -->
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
          <!-- Per-check disposition — segmented pill row. Only actionable
               (fail/warn) findings get one; pass/info aren't part of
               remediation progress. Active pill fills brand-pink; the
               rest are muted outlines. -->
          {#if isActionable(check)}
            {@const active = dispositionOf(check)}
            <div class="flex flex-wrap items-center gap-1.5 pt-1.5">
              <span class="text-[10.5px] uppercase tracking-wide font-semibold text-ink-500 dark:text-night-mute mr-0.5">Status</span>
              <div class="inline-flex rounded-md border border-ink-300 dark:border-night-line overflow-hidden">
                {#each DISPOSITIONS as opt, oi (opt.value)}
                  <button
                    type="button"
                    class="text-[11px] font-medium px-2 py-1 transition-colors {oi > 0 ? 'border-l border-ink-300 dark:border-night-line' : ''} {active === opt.value
                      ? 'bg-brand-pink text-white font-semibold'
                      : 'bg-white dark:bg-night-card text-ink-600 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt'}"
                    aria-pressed={active === opt.value}
                    onclick={() => app.setAuditDisposition(check.id, opt.value)}
                    title={`Mark this finding ${opt.label}`}
                  >
                    {opt.label}
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Edit / Delete — agent + user checks are both editable; the
               overlay stores edits so they survive re-runs. -->
          <div class="flex items-center gap-1.5 pt-1.5">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-card text-ink-600 dark:text-night-dim text-[11px] font-medium px-2 py-1 hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text"
              onclick={() => startEditCheck(check)}
              title="Edit this check's label + description"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
              Edit
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-card text-red-600 dark:text-red-400 text-[11px] font-medium px-2 py-1 hover:bg-red-50 dark:hover:bg-red-950/30"
              onclick={() => onDeleteCheck(check.id)}
              title="Delete this check"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
              Delete
            </button>
          </div>
          {/if}
        </div>
      {/if}
    </li>
  {/snippet}

  <!-- RUN CONTROLS / IN-FLIGHT -->
  {#if running}
    <!-- Single "Starting audit…" loader while the agent works. The full
         results land at once via the final mark_session_done. -->
    <div class="rounded-lg border border-brand-pink/30 bg-brand-pink/5 dark:bg-brand-pink/10 p-4 space-y-2">
      <div class="flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin text-brand-pink dark:text-brand-pink-light" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        <span class="text-[12.5px] font-semibold text-ink-900 dark:text-night-text">Starting audit…</span>
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
      {#snippet catIcon(id: AuditCategoryId)}
        {#if id === "security"}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        {:else if id === "performance"}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        {:else if id === "accessibility"}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="4" r="1.6"/><path d="M5 8h14"/><path d="M12 8v6"/><path d="m9 21 3-7 3 7"/></svg>
        {:else if id === "mobile"}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        {/if}
      {/snippet}
      <div class="divide-y divide-ink-100 dark:divide-night-line -mx-1">
        {#each PICKER_CATEGORIES as cat (cat.id)}
          {@const picked = isCategorySelected(cat.id) && !cat.soon}
          <div class="flex items-center gap-3 px-1 py-2.5" class:opacity-60={cat.soon} title={cat.blurb}>
            <span
              class="shrink-0"
              class:text-brand-pink={!cat.soon}
              class:dark:text-brand-pink-light={!cat.soon}
              class:text-ink-400={cat.soon}
              class:dark:text-night-mute={cat.soon}
            >
              {@render catIcon(cat.id)}
            </span>
            <span class="flex-1 min-w-0">
              <span class="font-bold text-[13px] text-ink-900 dark:text-night-text inline-flex items-center gap-1.5">
                {cat.label}
                {#if cat.soon}
                  <span class="inline-flex items-center text-[9px] uppercase tracking-wider font-bold text-ink-500 dark:text-night-mute bg-ink-100 dark:bg-night-alt border border-ink-300 dark:border-night-line rounded-full px-1.5 py-0.5">
                    Soon
                  </span>
                {/if}
              </span>
              <span class="block text-[11px] text-ink-500 dark:text-night-mute mt-0.5 truncate">
                {cat.keywords}
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={picked}
              aria-label={`Toggle ${cat.label}`}
              disabled={cat.soon}
              onclick={() => toggleCategoryPick(cat.id, !picked)}
              class="relative shrink-0 w-10 h-6 rounded-full transition-colors disabled:cursor-not-allowed"
              class:bg-brand-pink={picked}
              class:bg-ink-200={!picked}
              class:dark:bg-night-line={!picked}
            >
              <span
                class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
                class:translate-x-4={picked}
              ></span>
            </button>
          </div>
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
    <div class="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[12px] text-red-700 dark:text-red-300 leading-snug">
      <p class="flex-1 min-w-0 break-words">{app.audit.error}</p>
      <button
        type="button"
        class="shrink-0 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200 leading-none px-1"
        onclick={() => (app.audit.error = null)}
        aria-label="Dismiss error"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  {/if}

  <!-- RESULTS -->
  {#if hasRun && !running}
    {@const run = app.audit.currentRun}
    {#if run}
      <!-- Overall score card — circular ring + rating + run actions -->
      <div class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-4 flex items-center gap-4">
        <div class="relative shrink-0">
          <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
            <circle
              cx="32"
              cy="32"
              r="27"
              fill="none"
              class="stroke-ink-200 dark:stroke-night-line"
              stroke-width="6"
            />
            <circle
              cx="32"
              cy="32"
              r="27"
              fill="none"
              stroke-width="6"
              stroke-linecap="round"
              class={scoreRingColor(run.overall)}
              stroke-dasharray={`${(run.overall / 100) * 169.6} 169.6`}
              transform="rotate(-90 32 32)"
            />
          </svg>
          <div class="absolute inset-0 inline-flex items-center justify-center">
            <span class="text-[18px] font-bold tabular-nums {scoreColor(run.overall)}">{Math.round(run.overall)}</span>
          </div>
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-[14px] font-bold text-ink-900 dark:text-night-text">{run.rating}</div>
          <div class="text-[11.5px] text-ink-500 dark:text-night-mute mt-0.5">
            {run.categories.length} categor{run.categories.length === 1 ? "y" : "ies"} audited
          </div>
          <div class="flex items-center gap-3 mt-2">
            <button
              type="button"
              class="text-[11.5px] font-medium text-brand-pink dark:text-brand-pink-light hover:underline disabled:opacity-50"
              onclick={runAudit}
              disabled={app.connectionStatus !== "connected"}
              title={app.connectionStatus !== "connected"
                ? "Connect a companion to re-run"
                : "Re-run the audit"}
            >Re-run</button>
            <button
              type="button"
              class="text-[11.5px] font-medium text-ink-500 dark:text-night-mute hover:text-red-600 dark:hover:text-red-400"
              onclick={clearAudit}
            >Clear results</button>
          </div>
        </div>
      </div>

      <!-- Overall remediation progress — mirrors Test Pilot's overall
           bar. Only counts actionable (fail/warn) findings. -->
      {@const overallProgress = auditProgress(
        run.categories.flatMap((c) => c.checks),
        app.audit.dispositions,
      )}
      {#if overallProgress.actionable > 0}
        <div class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-3 space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-[11.5px] font-semibold text-ink-700 dark:text-night-dim">Remediation progress</span>
            <span class="text-[11px] text-ink-500 dark:text-night-mute tabular-nums">{overallProgress.done}/{overallProgress.actionable} addressed</span>
          </div>
          <div class="h-1.5 rounded-full overflow-hidden bg-ink-100 dark:bg-night-alt">
            <div class="h-full bg-emerald-500 transition-all" style:width="{overallProgress.percent}%"></div>
          </div>
        </div>
      {/if}

      <!-- Per-category cards -->
      {#each run.categories as category (category.id)}
        {@const tally = categoryTally(category.checks)}
        {@const isOpen = expanded[category.id] ?? false}
        {@const catProgress = auditProgress(
          category.checks,
          app.audit.dispositions,
        )}
        {@const isCustom = isCustomCategory(category.id)}
        {@const suggesting = !!app.audit.pendingAuditSuggest[category.id]}
        {@const reRunning = reRunningCategory === category.id}
        {@const kebabBusy = suggesting || reRunning}
        {@const pickedSuggestions = app.audit.suggestions[category.id]}
        <div class="relative rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card overflow-visible">
          {#if renamingCategory === category.id}
            <div class="flex items-center gap-2 p-3">
              <input
                data-audit-rename-category={category.id}
                type="text"
                bind:value={renameCategoryName}
                class="flex-1 rounded-md border border-brand-pink/50 bg-white dark:bg-night-card px-2 py-1.5 text-[12.5px] text-ink-900 dark:text-night-text focus:outline-none focus:ring-1 focus:ring-brand-pink"
                onkeydown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitRenameCategory(category.id); }
                  else if (e.key === "Escape") { e.preventDefault(); cancelRenameCategory(); }
                }}
              />
              <button
                type="button"
                class="rounded-md text-[11.5px] font-medium px-2.5 py-1 text-ink-600 dark:text-night-dim hover:bg-ink-100 dark:hover:bg-night-line"
                onclick={cancelRenameCategory}
              >Cancel</button>
              <button
                type="button"
                class="rounded-md bg-brand-pink hover:bg-brand-magenta dark:hover:bg-brand-pink-light text-white text-[11.5px] font-semibold px-2.5 py-1 disabled:opacity-50"
                onclick={() => commitRenameCategory(category.id)}
                disabled={!renameCategoryName.trim()}
              >Save</button>
            </div>
          {:else}
          <button
            type="button"
            class="w-full flex items-center gap-3 pl-3 pr-12 py-2.5 text-left hover:bg-ink-50 dark:hover:bg-night-alt transition-colors"
            onclick={() => toggleCategory(category.id)}
            aria-expanded={isOpen}
          >
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
              <div class="flex items-center gap-1.5">
                <div class="text-[12.5px] font-bold text-ink-900 dark:text-night-text leading-tight truncate">{category.name}</div>
                {#if isCustom}
                  <span class="shrink-0 inline-flex items-center rounded-sm bg-brand-pink/10 text-brand-pink dark:text-brand-pink-light text-[9px] font-semibold uppercase tracking-wide px-1 py-px" title="Custom category you added">added</span>
                {/if}
              </div>
              <div class="text-[11px] text-ink-500 dark:text-night-mute mt-0.5 tabular-nums">
                {#if tally.fail > 0}<span class="text-red-600 dark:text-red-400 font-semibold">{tally.fail} fail</span> · {/if}
                {#if tally.warn > 0}<span class="text-amber-600 dark:text-amber-400 font-semibold">{tally.warn} warn</span> · {/if}
                <span class="text-emerald-600 dark:text-emerald-400">{tally.pass} pass</span>
                {#if tally.info > 0} · <span>{tally.info} info</span>{/if}
              </div>
              {#if catProgress.actionable > 0}
                <div class="mt-1.5 space-y-0.5">
                  <div class="h-1 rounded-full overflow-hidden bg-ink-100 dark:bg-night-alt">
                    <div class="h-full bg-emerald-500" style:width="{catProgress.percent}%"></div>
                  </div>
                  <div class="text-[10px] text-ink-500 dark:text-night-mute tabular-nums">
                    {catProgress.done}/{catProgress.actionable} addressed · {catProgress.percent}%
                  </div>
                </div>
              {/if}
            </div>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="transition-transform shrink-0 text-ink-500 dark:text-night-mute" class:rotate-90={isOpen} aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
          </button>

          <!-- Category-header kebab. Built-ins → Add check · Suggest
               checks. Custom → also Rename · Delete. Absolutely
               positioned so the full-width toggle button still works. -->
          <button
            type="button"
            data-audit-kebab-trigger
            class="absolute top-2 right-2 w-7 h-7 inline-flex items-center justify-center rounded-full hover:bg-ink-100 dark:hover:bg-night-line"
            class:text-brand-pink={kebabBusy}
            class:dark:text-brand-pink-light={kebabBusy}
            class:text-ink-500={!kebabBusy}
            class:dark:text-night-dim={!kebabBusy}
            class:hover:text-ink-900={!kebabBusy}
            class:dark:hover:text-night-text={!kebabBusy}
            onclick={() => toggleCategoryKebab(category.id)}
            aria-haspopup="menu"
            aria-expanded={categoryKebabOpen === category.id}
            aria-label="Category actions"
            title={reRunning
              ? "Re-running this category…"
              : suggesting
                ? "Suggesting checks…"
                : "Category actions"}
          >
            {#if kebabBusy}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            {:else}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="12" cy="5" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="19" r="1.6" />
              </svg>
            {/if}
          </button>
          {#if categoryKebabOpen === category.id}
            <div
              data-audit-kebab-menu
              class="absolute z-30 right-2 top-9 bg-white dark:bg-night-card border border-ink-200 dark:border-night-line rounded-md shadow-lg py-1 min-w-[150px]"
              role="menu"
            >
              <button
                type="button"
                class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text"
                onclick={() => openAddCheck(category.id)}
                role="menuitem"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add check
              </button>
              <button
                type="button"
                class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-700 dark:disabled:hover:text-night-dim"
                onclick={() => { app.requestAuditSuggestions(category.id, category.name); categoryKebabOpen = null; }}
                disabled={!!app.audit.pendingAuditSuggest[category.id]}
                role="menuitem"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/></svg>
                {app.audit.pendingAuditSuggest[category.id] ? "Suggesting…" : "Suggest checks"}
              </button>
              <button
                type="button"
                class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-700 dark:disabled:hover:text-night-dim"
                onclick={() => { app.runAuditCategory(category.id); categoryKebabOpen = null; }}
                disabled={auditBusy || app.connectionStatus !== "connected"}
                role="menuitem"
                title={app.connectionStatus !== "connected"
                  ? "Connect a companion to re-run"
                  : auditBusy
                    ? "An audit is already running"
                    : "Re-run just this category"}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
                {reRunning ? "Re-running…" : "Re-run category"}
              </button>
              {#if isCustom}
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text"
                  onclick={() => startRenameCategory(category.id, category.name)}
                  role="menuitem"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                  Rename
                </button>
              {/if}
              <button
                type="button"
                class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                onclick={() => onDeleteCategory(category.id)}
                role="menuitem"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5L5 6"/></svg>
                Delete category
              </button>
            </div>
          {/if}
          {/if}

          <!-- Inline "Suggest checks" picker (Slice 3) — agent-returned
               scenarios as a tickable checklist under the header. -->
          {#if pickedSuggestions && pickedSuggestions.length > 0}
            {@const pickedCount = suggestionPickedCount(category.id)}
            <div class="border-t border-brand-pink/30 bg-brand-pink/5 dark:bg-brand-pink/10 px-3 py-2.5 space-y-2">
              <div class="text-[11.5px] font-semibold text-brand-pink dark:text-brand-pink-light">Suggested checks</div>
              <ul class="space-y-1.5">
                {#each pickedSuggestions as sug, si (si)}
                  <li class="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={isSuggestionChecked(category.id, si)}
                      onchange={(e) => toggleSuggestion(category.id, si, e.currentTarget.checked)}
                      class="mt-0.5 shrink-0 accent-brand-pink"
                      aria-label={`Include ${sug.label}`}
                    />
                    <div class="min-w-0 flex-1">
                      <div class="text-[12px] font-medium text-ink-900 dark:text-night-text leading-snug">{sug.label}</div>
                      {#if sug.description}
                        <div class="text-[11px] text-ink-500 dark:text-night-mute leading-snug mt-0.5">{sug.description}</div>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
              <div class="flex items-center justify-end gap-2 pt-0.5">
                <button
                  type="button"
                  class="text-[11.5px] font-medium px-2.5 py-1 text-ink-600 dark:text-night-dim hover:text-ink-900 dark:hover:text-night-text"
                  onclick={() => dismissSuggestions(category.id)}
                >Dismiss</button>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-md bg-brand-pink dark:bg-brand-pink-light text-white dark:text-night-bg text-[11px] font-semibold px-2.5 py-1 disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
                  onclick={() => addSuggestions(category.id)}
                  disabled={pickedCount === 0}
                >
                  Add {pickedCount} to {category.name}
                </button>
              </div>
            </div>
          {/if}

          <!-- Inline "Add check" form (from the kebab). -->
          {#if addingCheckCategory === category.id}
            <div class="border-t border-brand-pink/30 bg-white dark:bg-night-card px-3 py-2.5 space-y-2">
              <input
                data-audit-add-check
                type="text"
                bind:value={newCheckLabel}
                class="w-full rounded-md border border-brand-pink/50 bg-white dark:bg-night-card px-2 py-1.5 text-[12.5px] text-ink-900 dark:text-night-text focus:outline-none focus:ring-1 focus:ring-brand-pink"
                placeholder="Check label (required)"
                onkeydown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitAddCheck(); }
                  else if (e.key === "Escape") { e.preventDefault(); cancelAddCheck(); }
                }}
              />
              <textarea
                bind:value={newCheckDescription}
                rows="2"
                class="w-full rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-card px-2 py-1.5 text-[12px] text-ink-700 dark:text-night-dim focus:outline-none focus:ring-1 focus:ring-brand-pink resize-y"
                placeholder="Description (optional)"
              ></textarea>
              <div class="flex items-center justify-end gap-2">
                <button
                  type="button"
                  class="rounded-md text-[11.5px] font-medium px-2.5 py-1 text-ink-600 dark:text-night-dim hover:bg-ink-100 dark:hover:bg-night-line"
                  onclick={cancelAddCheck}
                >Cancel</button>
                <button
                  type="button"
                  class="rounded-md bg-brand-pink hover:bg-brand-magenta dark:hover:bg-brand-pink-light text-white text-[11.5px] font-semibold px-2.5 py-1 disabled:opacity-50"
                  onclick={commitAddCheck}
                  disabled={!newCheckLabel.trim()}
                >Add check</button>
              </div>
            </div>
          {/if}

          {#if isOpen}
            <ul class="border-t border-ink-200 dark:border-night-line divide-y divide-ink-100 dark:divide-night-line/60">
              {#each category.checks as check (check.id)}
                {@render checkRow(check)}
              {/each}
            </ul>
          {/if}
        </div>
      {/each}

      <!-- Add category — appends a custom category to the list. -->
      {#if addingCategory}
        <div class="rounded-lg border border-brand-pink/40 dark:border-brand-pink/40 bg-white dark:bg-night-card p-3 flex items-center gap-2">
          <input
            data-audit-add-category
            type="text"
            bind:value={newCategoryName}
            class="flex-1 rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-alt px-2 py-1.5 text-[12.5px] text-ink-900 dark:text-night-text focus:outline-none focus:ring-1 focus:ring-brand-pink"
            placeholder="New category name"
            onkeydown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitAddCategory(); }
              else if (e.key === "Escape") { e.preventDefault(); addingCategory = false; }
            }}
          />
          <button
            type="button"
            class="rounded-md text-[11.5px] font-medium px-2.5 py-1 text-ink-600 dark:text-night-dim hover:bg-ink-100 dark:hover:bg-night-line"
            onclick={() => (addingCategory = false)}
          >Cancel</button>
          <button
            type="button"
            class="rounded-md bg-brand-pink hover:bg-brand-magenta dark:hover:bg-brand-pink-light text-white text-[11.5px] font-semibold px-2.5 py-1 disabled:opacity-50"
            onclick={commitAddCategory}
            disabled={!newCategoryName.trim()}
          >Add</button>
        </div>
      {:else}
        <button
          type="button"
          class="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink-300 dark:border-night-line text-ink-600 dark:text-night-dim text-[12px] font-medium px-3 py-2.5 hover:border-brand-pink/50 hover:text-brand-pink dark:hover:text-brand-pink-light transition-colors"
          onclick={startAddCategory}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add category
        </button>
      {/if}
    {/if}
  {/if}
</section>
