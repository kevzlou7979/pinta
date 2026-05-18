<script lang="ts">
  // Test Pilot tab — interactive module surface.
  //
  // Four states the user moves between:
  //  1. EMPTY      — no doc imported yet. CTA to pick a .md file.
  //  2. PARSING    — agent extracting the catalog. Loading state.
  //  3. CATALOG    — sections + test rows with P/F + Ask buttons.
  //  4. DETAIL     — one test row expanded; steps + Pass/Fail.
  //
  // Lives at `extension/src/sidepanel/TestPilotTab.svelte`. Rendered
  // from `App.svelte` whenever `tab === "test-pilot"` is active.

  import { onMount } from "svelte";
  import { app, type TestPilotTest, type TestPilotStatus } from "../lib/state.svelte.js";
  import { parseStep } from "../lib/step-md.js";
  import { highlight } from "../lib/prism-setup.js";

  let fileInput = $state<HTMLInputElement | null>(null);
  let viewing = $state<{ testId: string } | null>(null);
  // Section-collapse state (id-keyed by section title).
  let collapsedSections = $state<Record<string, boolean>>({});
  // Status dropdown — when the user clicks a row's checkbox we open a
  // small menu with Pass / Fail / Clear instead of cycling silently.
  let dropdownTestId = $state<string | null>(null);
  // Per-codeblock "Copied!" flash. Key = block index within the current
  // detail view; resets on close.
  let copiedBlock = $state<number | null>(null);
  // Inline "Details" override for Re-ask. Initialized from the module's
  // `detailed_steps` setting when a detail view opens so the checkbox
  // reflects the user's global preference by default. Toggling it
  // affects only the next Re-ask on this row, not the module setting.
  let detailedOverride = $state<boolean>(false);
  // Inline metadata edit state. `null` means nothing's being edited;
  // otherwise it's the field name and the in-flight draft value. We
  // commit on Enter/blur and revert on Escape.
  let editingField = $state<"title" | "author" | "description" | null>(null);
  let editingDraft = $state("");

  function startEditing(field: "title" | "author" | "description") {
    const c = app.testPilot.catalog;
    if (!c) return;
    editingField = field;
    editingDraft =
      field === "title"
        ? (c.title ?? "")
        : field === "author"
          ? (c.author ?? "")
          : (c.description ?? "");
  }
  function commitEdit() {
    if (!editingField) return;
    app.setTestPilotMeta({ [editingField]: editingDraft });
    editingField = null;
  }
  function cancelEdit() {
    editingField = null;
  }
  function onEditKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    } else if (
      e.key === "Enter" &&
      // Allow newlines in description with Shift+Enter; bare Enter commits.
      !(editingField === "description" && e.shiftKey)
    ) {
      e.preventDefault();
      commitEdit();
    }
  }

  function formatImportedDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  async function copyCode(idx: number, body: string) {
    try {
      await navigator.clipboard.writeText(body);
      copiedBlock = idx;
      setTimeout(() => {
        if (copiedBlock === idx) copiedBlock = null;
      }, 1500);
    } catch {
      // ignore — clipboard may be blocked
    }
  }

  // Close the dropdown on any outside click. Bound once per mount.
  onMount(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-pinta-status-trigger]") || target.closest("[data-pinta-status-menu]")) {
        return;
      }
      dropdownTestId = null;
    }
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
  });

  function onPickFile() {
    fileInput?.click();
  }
  async function onFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // reset so the same file can be re-picked
    if (!file) return;
    const text = await file.text();
    await app.importTestDoc(file.name, text);
    // After import, collapse all sections except the first so the
    // catalog isn't an overwhelming wall of tests on first view.
    const catalog = app.testPilot.catalog;
    if (catalog) {
      const next: Record<string, boolean> = {};
      catalog.sections.forEach((s, i) => {
        next[s.title] = i !== 0;
      });
      collapsedSections = next;
    }
  }

  function toggleStatusMenu(testId: string) {
    dropdownTestId = dropdownTestId === testId ? null : testId;
  }

  function setStatusFromMenu(testId: string, status: TestPilotStatus) {
    app.setTestStatus(testId, status);
    dropdownTestId = null;
  }

  function openDetail(test: TestPilotTest) {
    viewing = { testId: test.id };
    copiedBlock = null;
    // Seed the inline checkbox from the module's saved preference so
    // the default matches whatever the user picked globally in Settings.
    detailedOverride =
      app.modules["test-pilot"]?.settings?.detailed_steps === true;
    if (!test.detail) {
      void app.fetchDetailSteps(test.id);
    }
  }

  function closeDetail() {
    viewing = null;
    copiedBlock = null;
  }

  function setStatusAndClose(status: TestPilotStatus) {
    if (!viewing) return;
    app.setTestStatus(viewing.testId, status);
    closeDetail();
  }

  function reAsk() {
    if (!viewing) return;
    // Force a fresh fetch by clearing the cached detail.
    const catalog = app.testPilot.catalog;
    if (!catalog) return;
    for (const section of catalog.sections) {
      for (const t of section.tests) {
        if (t.id === viewing.testId) {
          delete t.detail;
          break;
        }
      }
    }
    void app.fetchDetailSteps(viewing.testId, {
      overrideDetailedSteps: detailedOverride,
    });
  }

  function tally() {
    const catalog = app.testPilot.catalog;
    if (!catalog) return { pass: 0, fail: 0, untested: 0, total: 0 };
    let pass = 0,
      fail = 0,
      untested = 0;
    for (const s of catalog.sections) {
      for (const t of s.tests) {
        if (t.status === "pass") pass++;
        else if (t.status === "fail") fail++;
        else untested++;
      }
    }
    return { pass, fail, untested, total: pass + fail + untested };
  }

  function downloadExport() {
    const md = app.exportResults();
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().slice(0, 10);
    const stem = (app.testPilot.catalog?.filename ?? "test-spec").replace(
      /\.md$/i,
      "",
    );
    a.download = `${stem}-results-${ts}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function clearCatalog() {
    if (
      !confirm(
        "Clear the current test catalog and all Pass/Fail results? This can't be undone.",
      )
    )
      return;
    app.clearTestPilot();
    viewing = null;
  }

  function findViewingTest(): TestPilotTest | null {
    if (!viewing) return null;
    const catalog = app.testPilot.catalog;
    if (!catalog) return null;
    for (const section of catalog.sections) {
      for (const t of section.tests) {
        if (t.id === viewing.testId) return t;
      }
    }
    return null;
  }

  function findViewingSectionTitle(): string {
    if (!viewing) return "";
    const catalog = app.testPilot.catalog;
    if (!catalog) return "";
    for (const section of catalog.sections) {
      if (section.tests.some((t) => t.id === viewing!.testId)) {
        return section.title;
      }
    }
    return "";
  }
</script>

<input
  bind:this={fileInput}
  type="file"
  accept=".md,text/markdown"
  class="hidden"
  onchange={onFileChange}
/>

{#if app.testPilot.pending?.kind === "doc-parse"}
  <!-- PARSING state ------------------------------------------------- -->
  <section class="space-y-3 p-3">
    <div class="flex items-center gap-2 text-sm text-ink-700 dark:text-night-dim">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin text-brand-pink dark:text-brand-pink-light"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      <span>Parsing {app.testPilot.pending.filename}…</span>
    </div>
    <p class="text-[11px] text-ink-500 dark:text-night-mute leading-snug">
      The agent is extracting the test catalog from your markdown spec.
      This needs <code class="font-mono text-[10px] bg-ink-100 dark:bg-night-alt px-1 rounded">/pinta</code>
      running in a Claude Code terminal for this project.
    </p>
    <button
      type="button"
      class="text-[11px] text-ink-600 dark:text-night-dim hover:text-red-600 dark:hover:text-red-400 underline"
      onclick={() => app.cancelTestPilotPending()}
    >
      Cancel
    </button>
  </section>
{:else if app.testPilot.error && !app.testPilot.catalog}
  <!-- ERROR state (no catalog yet) ---------------------------------- -->
  <section class="space-y-3 p-3">
    <div class="rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-3 text-[12px] text-red-700 dark:text-red-300 leading-snug">
      {app.testPilot.error}
    </div>
    <button
      type="button"
      class="w-full rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-card text-sm font-medium px-3 py-2 hover:bg-ink-50 dark:hover:bg-night-alt"
      onclick={onPickFile}
    >
      Try another file
    </button>
  </section>
{:else if app.testPilot.pending?.kind === "doc-generate"}
  <!-- GENERATING state ----------------------------------------------- -->
  <section class="space-y-3 p-3">
    <div class="flex items-center gap-2 text-sm text-ink-700 dark:text-night-dim">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin text-brand-pink dark:text-brand-pink-light"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      <span>Generating tests for your app…</span>
    </div>
    <p class="text-[11px] text-ink-500 dark:text-night-mute leading-snug">
      The agent is scanning your project (routes, components, auth flow) and writing a UAT-style markdown spec.
      This usually takes a few minutes — needs
      <code class="font-mono text-[10px] bg-ink-100 dark:bg-night-alt px-1 rounded">/pinta</code>
      running in a Claude Code terminal for this project.
    </p>
    <button
      type="button"
      class="text-[11px] text-ink-600 dark:text-night-dim hover:text-red-600 dark:hover:text-red-400 underline"
      onclick={() => app.cancelTestPilotPending()}
    >
      Cancel
    </button>
  </section>
{:else if !app.testPilot.catalog}
  <!-- EMPTY state ---------------------------------------------------- -->
  <section class="space-y-3 p-3">
    <div class="flex items-center gap-2">
      <span class="text-base">🛫</span>
      <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">Test Pilot</h2>
    </div>
    <p class="text-[12px] text-ink-700 dark:text-night-dim leading-snug">
      Get a UAT-style test catalog for your app. Let the agent generate one from project context,
      or import a hand-written markdown spec.
    </p>
    <button
      type="button"
      class="w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-pink text-white text-sm font-medium px-3 py-2.5 hover:bg-brand-magenta dark:hover:bg-brand-pink-light"
      onclick={() => app.generateTestDoc()}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/></svg>
      Generate Test Script
    </button>
    <button
      type="button"
      class="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-ink-300 dark:border-night-line bg-transparent text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt text-[13px] font-medium px-3 py-2"
      onclick={onPickFile}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      Import Test Script
    </button>
    <div class="rounded-md border border-amber-300/50 dark:border-amber-700/40 bg-amber-50 dark:bg-amber-950/20 p-2.5 text-[11px] text-amber-900 dark:text-amber-200 leading-snug">
      <strong class="font-semibold">Heads up:</strong> the spec is written to
      <code class="font-mono text-[10px] bg-amber-100 dark:bg-amber-900/40 px-1 rounded">.pinta/test-docs/</code>
      and read by Claude Code (sent to Anthropic's API). Don't include real passwords
      or production secrets in any spec you import — use placeholders or test-tenant credentials.
    </div>
    <p class="text-[11px] text-ink-500 dark:text-night-mute italic leading-snug">
      Tip: run the exported results through <code>pandoc results.md -o results.pdf</code> if you need a PDF version.
    </p>
  </section>
{:else if viewing}
  <!-- DETAIL state --------------------------------------------------- -->
  {@const test = findViewingTest()}
  {@const sectionTitle = findViewingSectionTitle()}
  <section class="space-y-3 p-3">
    <button
      type="button"
      class="text-[11px] text-ink-600 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light flex items-center gap-1"
      onclick={closeDetail}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      Back to catalog
    </button>

    {#if test}
      <!-- Header: ID › section · title -->
      <div class="space-y-1.5">
        <div class="flex items-baseline gap-1.5 text-[11px] min-w-0">
          <span class="font-mono font-bold tracking-wide text-ink-700 dark:text-night-dim shrink-0">{test.id}</span>
          <span class="text-ink-400 dark:text-night-mute">›</span>
          <span class="text-ink-500 dark:text-night-mute truncate">{sectionTitle}</span>
        </div>
        <h3 class="text-base font-bold text-ink-900 dark:text-night-text leading-snug">
          {test.test}
        </h3>
      </div>

      <!-- Combined card: Expected + Steps + actions -->
      <div class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-4 space-y-3">
      <!-- Expected (top of card, divider below) -->
      <div class="pb-3 border-b border-ink-200 dark:border-night-line">
        <div class="text-[10px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute mb-1.5">Expected result</div>
        <p class="text-[13px] font-semibold text-ink-900 dark:text-night-text leading-snug">{test.expected}</p>
      </div>

      <!-- Steps header: STEPS · N total · Re-ask -->
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-baseline gap-2">
          <span class="text-[10px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute">Steps</span>
          {#if test.detail}
            <span class="text-[11px] text-ink-500 dark:text-night-mute">{test.detail.steps.length} total</span>
          {/if}
        </div>
        {#if test.detail}
          <div class="flex items-center gap-2">
            <label
              class="inline-flex items-center gap-1.5 text-[11px] text-ink-700 dark:text-night-dim cursor-pointer select-none"
              title="When checked, Re-ask returns deeper technical steps (curl, payloads, env vars). When unchecked, short tester-friendly steps."
            >
              <input
                type="checkbox"
                class="w-3.5 h-3.5 rounded border-ink-300 dark:border-night-line text-brand-pink focus:ring-1 focus:ring-brand-pink/40 cursor-pointer"
                bind:checked={detailedOverride}
              />
              Details
            </label>
            <button
              type="button"
              class="inline-flex items-center gap-1 text-[11px] text-ink-700 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light px-2 py-1 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card"
              onclick={reAsk}
              title={detailedOverride
                ? "Re-ask the agent for deeper technical steps"
                : "Re-ask the agent for short tester-friendly steps"}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
              Re-ask
            </button>
          </div>
        {/if}
      </div>

      <!-- Steps body -->
      {#if app.testPilot.pendingDetails[test.id]}
        <div class="space-y-2">
          <div class="flex items-center gap-2 text-[12px] text-ink-700 dark:text-night-dim">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin text-brand-pink dark:text-brand-pink-light"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            <span>Asking the agent…</span>
          </div>
          <p class="text-[11px] text-ink-500 dark:text-night-mute leading-snug">
            Needs <code class="font-mono text-[10px] bg-ink-100 dark:bg-night-alt px-1 rounded">/pinta</code>
            running in a Claude Code terminal. If it's been more than a few seconds, the agent may not be listening.
          </p>
          <button
            type="button"
            class="text-[11px] text-ink-600 dark:text-night-dim hover:text-red-600 dark:hover:text-red-400 underline"
            onclick={() => app.cancelDetailFetch(test.id)}
          >
            Cancel
          </button>
        </div>
      {:else if app.testPilot.error}
        <div class="rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[12px] text-red-700 dark:text-red-300 leading-snug">
          {app.testPilot.error}
        </div>
      {:else if test.detail}
        <!-- Timeline of steps -->
        <ol class="relative">
          {#each test.detail.steps as step, i}
            {@const blocks = parseStep(step)}
            <li class="relative flex gap-3 pb-5 last:pb-0">
              <!-- Numbered circle + connecting line -->
              <div class="relative shrink-0 flex flex-col items-center">
                <div class="w-6 h-6 rounded-full border border-ink-300 dark:border-night-line bg-white dark:bg-night-card text-ink-500 dark:text-night-dim text-[11px] font-semibold inline-flex items-center justify-center z-10">
                  {i + 1}
                </div>
                {#if i < test.detail.steps.length - 1}
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
                        {:else}
                          <span>{part.value}</span>
                        {/if}
                      {/each}
                    </div>
                  {/if}
                {/each}
              </div>
            </li>
          {/each}
        </ol>
      {:else}
        <p class="text-[11px] text-ink-500 dark:text-night-mute italic">
          No steps yet. Click Re-ask above.
        </p>
      {/if}

      <!-- Pass (green filled) / Fail (ghost) -->
      <div class="flex items-center gap-2 pt-1">
        <button
          type="button"
          class="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white text-[13px] font-semibold py-2.5 disabled:opacity-50"
          onclick={() => setStatusAndClose("pass")}
          disabled={app.testPilot.pending !== null}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Pass
        </button>
        <button
          type="button"
          class="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-ink-300 dark:border-night-line bg-transparent text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt text-[13px] font-semibold py-2.5 disabled:opacity-50"
          onclick={() => setStatusAndClose("fail")}
          disabled={app.testPilot.pending !== null}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Fail
        </button>
      </div>
      </div>
    {/if}
  </section>
{:else}
  <!-- CATALOG state -------------------------------------------------- -->
  {@const t = tally()}
  {@const progress = t.total > 0 ? Math.round(((t.pass + t.fail) / t.total) * 100) : 0}
  {@const passPct = t.total > 0 ? (t.pass / t.total) * 100 : 0}
  {@const failPct = t.total > 0 ? (t.fail / t.total) * 100 : 0}
  {@const meta = app.testPilot.catalog}
  <section class="space-y-4 p-4">
    <!-- HEADER — title + author/date + actions on one row. On wide
         panels (≥ ~480px) buttons sit top-right; on narrow viewports
         the wrapper flex-wraps and buttons drop below the title block.
         Title is bold sans, allowed to wrap, never truncated. -->
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div class="min-w-0 flex-1 basis-[200px]">
        <div class="min-w-0 flex-1 space-y-1">
        <!-- Title (or filename fallback) — click to edit -->
        {#if editingField === "title"}
          <input
            type="text"
            class="w-full text-base font-bold text-ink-900 dark:text-night-text bg-transparent border-b border-brand-pink dark:border-brand-pink-light outline-none px-0 py-0 leading-tight"
            bind:value={editingDraft}
            onkeydown={onEditKey}
            onblur={commitEdit}
            placeholder={meta.filename}
            autofocus
          />
        {:else}
          <button
            type="button"
            class="block w-full text-left text-base font-bold leading-tight rounded px-0.5 -mx-0.5 hover:bg-ink-50 dark:hover:bg-night-alt"
            class:text-ink-900={!!meta.title}
            class:dark:text-night-text={!!meta.title}
            class:text-ink-500={!meta.title}
            class:dark:text-night-mute={!meta.title}
            onclick={() => startEditing("title")}
            title={meta.title ? "Edit title" : `Click to set a title (defaults to ${meta.filename})`}
          >
            {meta.title || meta.filename}
          </button>
        {/if}

        <!-- Subline: Author · as of <importedAt>. Author is clickable
             to edit; date is plain text derived from the catalog's
             importedAt timestamp. -->
        <div class="flex items-center flex-wrap gap-x-1 gap-y-0.5 text-[11px] leading-snug">
          {#if editingField === "author"}
            <input
              type="text"
              class="text-[11px] text-ink-700 dark:text-night-dim bg-transparent border-b border-brand-pink dark:border-brand-pink-light outline-none px-0 py-0 min-w-0 flex-1"
              bind:value={editingDraft}
              onkeydown={onEditKey}
              onblur={commitEdit}
              placeholder="Author name"
              autofocus
            />
          {:else if meta.author}
            <button
              type="button"
              class="text-ink-700 dark:text-night-dim font-medium rounded px-0.5 -mx-0.5 hover:bg-ink-50 dark:hover:bg-night-alt"
              onclick={() => startEditing("author")}
              title="Edit author"
            >
              {meta.author}
            </button>
            <span class="text-ink-400 dark:text-night-mute" aria-hidden="true">·</span>
          {:else}
            <button
              type="button"
              class="text-ink-400 dark:text-night-mute italic rounded px-0.5 -mx-0.5 hover:bg-ink-50 dark:hover:bg-night-alt"
              onclick={() => startEditing("author")}
            >
              + Add author
            </button>
            <span class="text-ink-400 dark:text-night-mute" aria-hidden="true">·</span>
          {/if}
          <span class="text-ink-500 dark:text-night-mute">
            as of {formatImportedDate(meta.importedAt)}
          </span>
        </div>

        <!-- Description — multiline, only renders when present or
             being edited (otherwise a small "+ Add description"
             affordance below the subline). -->
        {#if editingField === "description"}
          <textarea
            rows="2"
            class="w-full text-[11px] text-ink-600 dark:text-night-dim bg-transparent border border-brand-pink/40 dark:border-brand-pink-light/40 rounded outline-none px-1 py-0.5 resize-y"
            bind:value={editingDraft}
            onkeydown={onEditKey}
            onblur={commitEdit}
            placeholder="Short description (Shift+Enter for newline)"
            autofocus
          ></textarea>
        {:else if meta.description}
          <button
            type="button"
            class="block w-full text-left text-[11px] leading-snug text-ink-600 dark:text-night-dim rounded px-0.5 -mx-0.5 hover:bg-ink-50 dark:hover:bg-night-alt whitespace-pre-wrap"
            onclick={() => startEditing("description")}
            title="Edit description"
          >
            {meta.description}
          </button>
        {:else}
          <button
            type="button"
            class="text-[11px] text-ink-400 dark:text-night-mute italic rounded px-0.5 -mx-0.5 hover:bg-ink-50 dark:hover:bg-night-alt"
            onclick={() => startEditing("description")}
          >
            + Add description
          </button>
        {/if}
        </div>
      </div>
      <!-- Action buttons — inline with title on wide panels, wrap to
           next row on narrow viewports thanks to flex-wrap on the
           parent. -->
      <div class="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          class="inline-flex items-center gap-1 text-[11px] text-ink-700 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light px-2 py-1.5 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card"
          onclick={onPickFile}
          title="Replace catalog with a new doc"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
          Re-import
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1 text-[11px] text-ink-700 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light px-2 py-1.5 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card"
          onclick={downloadExport}
          title="Download the current results as a markdown report"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export
        </button>
      </div>
    </div>

    <!-- STATS line — pass/fail/untested on the left, % complete on the
         right (matches the reference design). Progress bar runs the
         full panel width below, with "N of M tests run" tally caption. -->
    <div class="space-y-1.5">
      <div class="flex items-baseline justify-between gap-3 flex-wrap">
        <div class="text-[12px] text-ink-700 dark:text-night-dim flex items-center gap-2 flex-wrap">
          <span><span class="text-emerald-600 dark:text-emerald-400 font-bold tabular-nums">{t.pass}</span> passed</span>
          <span class="text-ink-400 dark:text-night-mute">·</span>
          <span><span class="text-red-600 dark:text-red-400 font-bold tabular-nums">{t.fail}</span> failed</span>
          <span class="text-ink-400 dark:text-night-mute">·</span>
          <span><span class="text-ink-900 dark:text-night-text font-bold tabular-nums">{t.untested}</span> <span class="text-ink-500 dark:text-night-mute">untested</span></span>
        </div>
        <div class="text-ink-900 dark:text-night-text tabular-nums">
          <span class="text-sm font-bold">{progress}%</span>
          <span class="text-[11px] text-ink-500 dark:text-night-mute ml-0.5">complete</span>
        </div>
      </div>
      <div class="h-1.5 rounded-full overflow-hidden bg-ink-100 dark:bg-night-alt flex">
        <div class="h-full bg-emerald-500" style:width="{passPct}%"></div>
        <div class="h-full bg-red-500" style:width="{failPct}%"></div>
      </div>
      <div class="text-[11px] text-ink-500 dark:text-night-mute tabular-nums">
        {t.pass + t.fail} of {t.total} tests run
      </div>
    </div>

    {#if app.testPilot.error}
      <div class="rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2.5 text-[12px] text-red-700 dark:text-red-300 leading-snug">
        {app.testPilot.error}
      </div>
    {/if}

    <!-- SECTIONS -->
    <div class="space-y-3">
      {#each app.testPilot.catalog.sections as section (section.title)}
        {@const collapsed = collapsedSections[section.title] ?? false}
        {@const secPass = section.tests.filter((t) => t.status === "pass").length}
        {@const secFail = section.tests.filter((t) => t.status === "fail").length}
        {@const secTotal = section.tests.length}
        {@const secPct = secTotal > 0 ? Math.round(((secPass + secFail) / secTotal) * 100) : 0}
        <div class="rounded-lg border border-ink-200 dark:border-night-line bg-ink-50 dark:bg-night-alt overflow-hidden">
          <button
            type="button"
            class="pinta-section-trigger w-full flex items-center justify-between gap-2 px-3 py-2.5 text-[12px] font-medium text-ink-900 dark:text-night-text hover:bg-ink-100 dark:hover:bg-night-line"
            onclick={() => (collapsedSections[section.title] = !collapsed)}
          >
            <span class="flex items-center gap-2 min-w-0">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="transition-transform shrink-0" class:rotate-90={!collapsed}><polyline points="9 18 15 12 9 6"/></svg>
              <!-- Flask icon — wiggles on section-trigger hover (see app.css).
                   Subtle "chemistry / UAT lab" cue. The bubble dot above the
                   spout drifts up on hover too. -->
              <span class="relative inline-flex shrink-0 text-brand-pink dark:text-brand-pink-light" aria-hidden="true">
                <svg
                  class="pinta-flask-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M9 3h6" />
                  <path d="M10 3v6.5L4.4 18.7A1.6 1.6 0 0 0 5.8 21h12.4a1.6 1.6 0 0 0 1.4-2.3L14 9.5V3" />
                  <path d="M7.5 14.5h9" opacity="0.55" />
                </svg>
                <span
                  class="pinta-flask-bubble absolute left-1/2 -translate-x-1/2 -top-0.5 w-1 h-1 rounded-full bg-brand-pink dark:bg-brand-pink-light opacity-0"
                ></span>
              </span>
              <span class="truncate font-bold">{section.title}</span>
            </span>
            <!-- Per-section tally: pass · fail · % complete. Pass and
                 fail are color-coded; pct is dim. Separators are thin
                 vertical bars so the trio reads as one badge. Falls
                 back to a single count chip if nothing has been tested
                 yet (zero pass + zero fail) to keep the header tidy. -->
            <span class="inline-flex items-center gap-1.5 text-[11px] font-semibold shrink-0 tabular-nums bg-white/70 dark:bg-night-card/70 rounded px-2 py-0.5">
              {#if secPass + secFail === 0}
                <span class="text-ink-600 dark:text-night-dim">{secTotal}</span>
              {:else}
                <span
                  class="text-emerald-600 dark:text-emerald-400"
                  title="{secPass} passed of {secTotal}"
                >{secPass}</span>
                <span class="w-px h-3 bg-ink-300 dark:bg-night-line" aria-hidden="true"></span>
                <span
                  class="text-red-600 dark:text-red-400"
                  title="{secFail} failed of {secTotal}"
                >{secFail}</span>
                <span class="w-px h-3 bg-ink-300 dark:bg-night-line" aria-hidden="true"></span>
                <span
                  class="text-ink-700 dark:text-night-dim"
                  title="{secPass + secFail} of {secTotal} tests run"
                >{secPct}%</span>
              {/if}
            </span>
          </button>
          {#if !collapsed}
            <ul class="border-t border-ink-200 dark:border-night-line">
              {#each section.tests as test (test.id)}
                {@const detailLoading = !!app.testPilot.pendingDetails[test.id]}
                {@const detailLoaded = !!test.detail}
                <li class="relative border-b border-ink-200 dark:border-night-line last:border-b-0">
                  <div class="flex items-start gap-3 px-3 py-3 bg-white dark:bg-night-card">
                    <!-- Status vertical bar — full row height, transparent for untested -->
                    <div
                      class="absolute left-0 top-0 bottom-0 w-0.5"
                      class:bg-emerald-500={test.status === "pass"}
                      class:bg-red-500={test.status === "fail"}
                      class:bg-transparent={test.status === "untested"}
                      aria-hidden="true"
                    ></div>

                    <!-- Status checkbox with dropdown trigger -->
                    <button
                      type="button"
                      data-pinta-status-trigger
                      class="shrink-0 w-5 h-5 mt-0.5 inline-flex items-center justify-center rounded transition-colors"
                      class:bg-emerald-500={test.status === "pass"}
                      class:text-white={test.status === "pass" || test.status === "fail"}
                      class:bg-red-500={test.status === "fail"}
                      class:border={test.status === "untested"}
                      class:border-ink-300={test.status === "untested"}
                      class:dark:border-night-line={test.status === "untested"}
                      class:bg-white={test.status === "untested"}
                      class:dark:bg-night-alt={test.status === "untested"}
                      onclick={() => toggleStatusMenu(test.id)}
                      aria-label="Set status for {test.id}"
                      aria-haspopup="menu"
                      aria-expanded={dropdownTestId === test.id}
                    >
                      {#if test.status === "pass"}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      {:else if test.status === "fail"}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      {/if}
                    </button>

                    <!-- ID + title + expected (stacked) -->
                    <div class="flex-1 min-w-0">
                      <div class="font-mono text-[10px] font-bold tracking-wide text-ink-500 dark:text-night-mute">{test.id}</div>
                      <div class="text-[12px] font-semibold text-ink-900 dark:text-night-text leading-snug mt-1">{test.test}</div>
                      <p class="text-[11px] text-ink-500 dark:text-night-mute leading-snug mt-1">{test.expected}</p>
                    </div>

                    <!-- Ask icon — spinner while fetching, pink once
                         the agent has answered, gray otherwise -->
                    <button
                      type="button"
                      class="shrink-0 w-9 h-9 mt-0.5 inline-flex items-center justify-center rounded-full hover:bg-ink-50 dark:hover:bg-night-alt"
                      class:text-brand-pink={detailLoaded || detailLoading}
                      class:dark:text-brand-pink-light={detailLoaded || detailLoading}
                      class:text-ink-400={!detailLoaded && !detailLoading}
                      class:dark:text-night-mute={!detailLoaded && !detailLoading}
                      class:hover:text-brand-pink={!detailLoading}
                      class:dark:hover:text-brand-pink-light={!detailLoading}
                      onclick={() => openDetail(test)}
                      title={detailLoading
                        ? "Fetching steps from the agent…"
                        : detailLoaded
                          ? "View loaded steps"
                          : "Ask for step-by-step instructions"}
                      aria-label={detailLoading
                        ? `Fetching steps for ${test.id}`
                        : `Ask for steps for ${test.id}`}
                    >
                      {#if detailLoading}
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin text-brand-pink dark:text-brand-pink-light" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                      {:else}
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      {/if}
                    </button>
                  </div>

                  <!-- Status dropdown menu — anchored beside the checkbox -->
                  {#if dropdownTestId === test.id}
                    <div
                      data-pinta-status-menu
                      class="absolute z-20 left-10 top-2 bg-white dark:bg-night-card border border-ink-200 dark:border-night-line rounded-md shadow-lg py-1 min-w-[120px]"
                      role="menu"
                    >
                      <button
                        type="button"
                        class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-emerald-50 dark:hover:bg-emerald-950/30 hover:text-emerald-700 dark:hover:text-emerald-300"
                        onclick={() => setStatusFromMenu(test.id, "pass")}
                        role="menuitem"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-600 dark:text-emerald-400"><polyline points="20 6 9 17 4 12"/></svg>
                        Pass
                      </button>
                      <button
                        type="button"
                        class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-700 dark:hover:text-red-300"
                        onclick={() => setStatusFromMenu(test.id, "fail")}
                        role="menuitem"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="text-red-600 dark:text-red-400"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        Fail
                      </button>
                      <button
                        type="button"
                        class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt"
                        onclick={() => setStatusFromMenu(test.id, "untested")}
                        role="menuitem"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="text-ink-400 dark:text-night-mute"><circle cx="12" cy="12" r="9"/></svg>
                        Clear
                      </button>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    </div>

    <button
      type="button"
      class="w-full text-[11px] text-ink-500 dark:text-night-mute hover:text-red-600 dark:hover:text-red-400 py-2"
      onclick={clearCatalog}
    >
      Clear catalog
    </button>
  </section>
{/if}