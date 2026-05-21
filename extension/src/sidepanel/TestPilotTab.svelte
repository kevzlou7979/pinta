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

  import { onMount, tick } from "svelte";
  import { app, type TestPilotTest, type TestPilotStatus, type TestPilotSection } from "../lib/state.svelte.js";
  import { parseStep } from "../lib/step-md.js";
  import { highlight } from "../lib/prism-setup.js";

  let fileInput = $state<HTMLInputElement | null>(null);
  let viewing = $state<{ testId: string } | null>(null);
  // The currently "selected" test row in the catalog. Set when the user
  // clicks a row body or opens its detail view; used to (a) tint the row
  // as a bookmark cursor and (b) scroll-restore back to it when the user
  // returns from the detail view via "Back to catalog".
  let activeTestId = $state<string | null>(null);
  // Section-level "Ask all" — keyed by section.title, true while the
  // sequential bulk fetch is running OR queued. We fire one query,
  // wait for its pendingDetails entry to clear (response, error, or
  // timeout), then fire the next. Going parallel would blow the per-row
  // 120s timer since the agent processes Claude sessions one-at-a-time
  // anyway.
  let bulkFetchingSections = $state<Record<string, boolean>>({});
  // Cross-section serialization. If the user clicks "Ask all" on
  // multiple sections, each one chains onto this promise so loops run
  // back-to-back instead of fighting for the agent's queue (which would
  // pin per-row 120s timers on rows still waiting their turn AND cause
  // one section's error to cascade-cancel the others via the shared
  // `app.testPilot.error` field). Non-reactive — plain Promise chain.
  let bulkQueue: Promise<void> = Promise.resolve();
  // Per-section completion ledger. Used by the auto-collapse $effect
  // below to fire exactly on the <100% → 100% transition rather than
  // every time `collapsedSections` is read while a section is already
  // complete (which would re-collapse manual expand-to-review).
  let prevSectionComplete = $state<Record<string, boolean>>({});

  $effect(() => {
    const catalog = app.testPilot.catalog;
    if (!catalog) return;
    for (const section of catalog.sections) {
      const total = section.tests.length;
      if (total === 0) continue;
      let marked = 0;
      for (const t of section.tests) {
        if (t.status === "pass" || t.status === "fail") marked++;
      }
      const isComplete = marked === total;
      const was = prevSectionComplete[section.title] === true;
      // Fire on the transition only — leaves manual re-expand alone.
      if (isComplete && !was) {
        collapsedSections[section.title] = true;
      }
      prevSectionComplete[section.title] = isComplete;
    }
  });
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
  // Phase 14 — chat sheet for the open detail view. The static Notes
  // textarea was replaced by an interactive per-row chat with the
  // agent. `chatOpen` toggles the bottom-sheet panel; `chatDraft` is
  // the typed-but-unsent message. Both are local to this component —
  // persisted state (thread itself) lives on `TestPilotTest.chat[]`.
  let chatOpen = $state(false);
  let chatDraft = $state("");
  // True when the Chat module is enabled in Settings. Phase 14 made
  // chat its own module ("id: chat") with one master toggle that gates
  // all three chat surfaces (Test Pilot FAB, Annotate Just Ask, global
  // header icon). Off by default — users opt in.
  const chatEnabled = $derived(app.moduleReady("chat"));
  // True while the currently-viewed row has a chat ask in flight.
  // Drives the send-button spinner.
  const chatPending = $derived(
    viewing ? !!app.testPilot.pendingChats[viewing.testId] : false,
  );
  // Bound to the message-list div so we can keep the most recent
  // bubble in view as the conversation grows.
  let chatScrollEl = $state<HTMLDivElement | null>(null);

  /** Send the typed prompt for the currently-viewed row. Optimistic
   *  append + WS send happens inside `app.sendChatMessage`; we just
   *  clear the textarea on submit so the next prompt starts fresh. */
  function sendChat() {
    if (!viewing) return;
    const text = chatDraft.trim();
    if (!text) return;
    void app.sendChatMessage(viewing.testId, text);
    chatDraft = "";
  }

  /** Cmd/Ctrl+Enter sends. Enter (plain) inserts a newline so testers
   *  can ask multi-line questions without sending half a thought. */
  function onChatKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendChat();
    }
  }

  // Auto-scroll the message list to the bottom whenever the
  // currently-viewed row's chat length changes (new message landed)
  // or while the pending spinner is showing (so it stays in view).
  $effect(() => {
    if (!chatScrollEl) return;
    const test = viewing ? findViewingTest() : null;
    // Touch the reactive deps so Svelte 5 re-runs this effect on
    // chat-thread updates and on pending-state flips.
    void test?.chat?.length;
    void chatPending;
    // Defer to next tick so the new bubble's height is laid out
    // before we measure scrollHeight.
    tick().then(() => {
      if (chatScrollEl) chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
    });
  });
  // Inline edit state. `null` means nothing's being edited; otherwise
  // it's a keyed field name + in-flight draft. We commit on Enter/blur
  // and revert on Escape. Supported keys:
  //   "title" / "author" / "description"     — catalog metadata
  //   "section:OLD_TITLE"                    — section rename
  //   "test-title:ID"                        — test row title
  //   "test-expected:ID"                     — test row expected text
  let editingField = $state<string | null>(null);
  let editingDraft = $state("");
  // Kebab menus — keyed by section title (sections) or test id (rows).
  // Outside-click handler nulls them. Mutually exclusive — opening any
  // kebab closes the others.
  let sectionKebabOpen = $state<string | null>(null);
  let testKebabOpen = $state<string | null>(null);

  function startEditing(field: string) {
    const c = app.testPilot.catalog;
    if (!c) return;
    editingField = field;
    // Hydrate the draft from whatever source the key points at.
    if (field === "title") editingDraft = c.title ?? "";
    else if (field === "author") editingDraft = c.author ?? "";
    else if (field === "description") editingDraft = c.description ?? "";
    else if (field.startsWith("section:")) {
      editingDraft = field.slice("section:".length);
    } else if (field.startsWith("test-title:")) {
      const id = field.slice("test-title:".length);
      editingDraft = findTestById(id)?.test ?? "";
    } else if (field.startsWith("test-expected:")) {
      const id = field.slice("test-expected:".length);
      editingDraft = findTestById(id)?.expected ?? "";
    }
    // Lock the catalog-rehydration path so a mid-edit Generate result
    // doesn't clobber the in-progress draft.
    app.setTestPilotEditingActive(true);
  }
  function commitEdit() {
    if (!editingField) return;
    const field = editingField;
    const draft = editingDraft;
    editingField = null;
    app.setTestPilotEditingActive(false);
    if (
      field === "title" ||
      field === "author" ||
      field === "description"
    ) {
      app.setTestPilotMeta({ [field]: draft });
    } else if (field.startsWith("section:")) {
      const oldTitle = field.slice("section:".length);
      if (oldTitle === "") {
        // Adding a new section with empty title — replace its title.
        // We added a "" placeholder during addTestPilotSection; rename
        // the LAST section (the one just appended) to the typed value.
        const c = app.testPilot.catalog;
        if (c && c.sections.length > 0 && draft.trim() !== "") {
          const last = c.sections[c.sections.length - 1]!;
          app.renameTestPilotSection(last.title, draft);
        } else if (c && c.sections.length > 0 && draft.trim() === "") {
          // User left it blank — drop the placeholder.
          const last = c.sections[c.sections.length - 1]!;
          if (last.title === "" && last.tests.length === 0) {
            app.removeTestPilotSection("");
          }
        }
      } else {
        app.renameTestPilotSection(oldTitle, draft);
      }
    } else if (field.startsWith("test-title:")) {
      const id = field.slice("test-title:".length);
      app.updateTestPilotTest(id, { test: draft });
    } else if (field.startsWith("test-expected:")) {
      const id = field.slice("test-expected:".length);
      app.updateTestPilotTest(id, { expected: draft });
    }
  }
  function cancelEdit() {
    // If the user just clicked "+ Add section" then immediately
    // pressed Escape, drop the empty placeholder so the catalog
    // doesn't accumulate blank section headers.
    if (editingField === "section:") {
      const c = app.testPilot.catalog;
      if (c && c.sections.length > 0) {
        const last = c.sections[c.sections.length - 1]!;
        if (last.title === "" && last.tests.length === 0) {
          app.removeTestPilotSection("");
        }
      }
    }
    editingField = null;
    app.setTestPilotEditingActive(false);
  }
  function onEditKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    } else if (
      e.key === "Enter" &&
      // Allow newlines in multi-line fields with Shift+Enter; bare
      // Enter commits.
      !(
        (editingField === "description" ||
          editingField?.startsWith("test-expected:")) &&
        e.shiftKey
      )
    ) {
      e.preventDefault();
      commitEdit();
    }
  }

  function findTestById(id: string): TestPilotTest | null {
    const c = app.testPilot.catalog;
    if (!c) return null;
    for (const s of c.sections) {
      for (const t of s.tests) {
        if (t.id === id) return t;
      }
    }
    return null;
  }

  // Kebab actions — section
  function onSectionRename(title: string) {
    sectionKebabOpen = null;
    startEditing(`section:${title}`);
  }
  function onSectionDelete(title: string) {
    sectionKebabOpen = null;
    if (
      !confirm(
        `Delete section "${title}" and all its tests? This can't be undone.`,
      )
    )
      return;
    app.removeTestPilotSection(title);
  }
  function onSectionMove(title: string, direction: "up" | "down") {
    sectionKebabOpen = null;
    app.moveTestPilotSection(title, direction);
  }
  function onSectionAddTest(title: string) {
    sectionKebabOpen = null;
    const newId = app.addTestPilotTest(title, { test: "", expected: "" });
    if (newId) {
      // Drop the user into inline-edit on the new row's title.
      startEditing(`test-title:${newId}`);
      // Make sure the section is expanded so the user can see the
      // input they're about to type into.
      collapsedSections[title] = false;
    }
  }
  function onAddSection() {
    // Append empty section + immediately focus the inline input.
    app.addTestPilotSection("");
    startEditing("section:");
  }

  // Kebab actions — test row
  function onTestEdit(id: string) {
    testKebabOpen = null;
    startEditing(`test-title:${id}`);
  }
  function onTestEditExpected(id: string) {
    testKebabOpen = null;
    startEditing(`test-expected:${id}`);
  }
  function onTestDelete(id: string) {
    testKebabOpen = null;
    app.removeTestPilotTest(id);
  }
  function onTestMove(id: string, direction: "up" | "down") {
    testKebabOpen = null;
    app.moveTestPilotTest(id, direction);
  }

  function toggleSectionKebab(title: string) {
    sectionKebabOpen = sectionKebabOpen === title ? null : title;
    testKebabOpen = null;
  }
  function toggleTestKebab(id: string) {
    testKebabOpen = testKebabOpen === id ? null : id;
    sectionKebabOpen = null;
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

  // Close the dropdown + kebab menus on any outside click. Bound once
  // per mount.
  onMount(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const inStatus =
        target.closest("[data-pinta-status-trigger]") ||
        target.closest("[data-pinta-status-menu]");
      const inKebab =
        target.closest("[data-pinta-kebab-trigger]") ||
        target.closest("[data-pinta-kebab-menu]");
      if (!inStatus) dropdownTestId = null;
      if (!inKebab) {
        sectionKebabOpen = null;
        testKebabOpen = null;
      }
    }
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
  });

  function onPickFile() {
    fileInput?.click();
  }

  function clearMarks() {
    const c = app.testPilot.catalog;
    if (!c) return;
    const marked = c.sections.reduce(
      (n, s) => n + s.tests.filter((t) => t.status !== "untested").length,
      0,
    );
    if (marked === 0) return;
    const msg =
      `Reset ${marked} marked test${marked === 1 ? "" : "s"} back to untested? ` +
      `Cached step instructions will be cleared too. The spec itself isn't touched.`;
    if (!confirm(msg)) return;
    app.clearTestPilotMarks();
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

  function setActive(testId: string) {
    activeTestId = testId;
  }

  async function askAllInSection(section: TestPilotSection) {
    if (bulkFetchingSections[section.title]) return; // already running/queued
    bulkFetchingSections[section.title] = true;
    // Auto-expand so the per-row spinners are actually visible while
    // the queue chews through the section.
    collapsedSections[section.title] = false;
    // Chain onto the global queue — guarantees only one section's loop
    // is actively firing requests at a time. The spinner shown while
    // we await `prev` is "queued, your turn is coming."
    const prev = bulkQueue;
    bulkQueue = (async () => {
      try {
        await prev;
      } catch {
        // Defensive — `prev` shouldn't reject (the inner try/finally
        // swallows everything), but if it ever does, don't take this
        // section's loop down with it.
      }
      try {
        for (const test of section.tests) {
          if (test.detail) continue; // already answered
          // If another caller has it in flight already (per-row Ask),
          // just wait for that one to clear before moving on.
          if (!app.testPilot.pendingDetails[test.id]) {
            void app.fetchDetailSteps(test.id);
          }
          // Poll until this row's pending entry clears (success, error,
          // or timeout — handleDetailSync / armDetailTimeout / cancel
          // all delete the entry). Cheap polling beats wiring a per-row
          // promise channel through state.svelte.ts for this UI
          // affordance.
          while (app.testPilot.pendingDetails[test.id]) {
            await new Promise((r) => setTimeout(r, 250));
          }
          // Stop the queue if the last fetch errored or timed out — no
          // sense piling more onto a wedged agent. The user can retry.
          // The next queued section will still get a chance: its first
          // `fetchDetailSteps` call clears `error` in state.svelte.ts.
          if (app.testPilot.error) break;
        }
      } finally {
        delete bulkFetchingSections[section.title];
      }
    })();
    await bulkQueue;
  }

  function openDetail(test: TestPilotTest) {
    activeTestId = test.id;
    viewing = { testId: test.id };
    copiedBlock = null;
    // Seed the inline checkbox from the module's saved preference so
    // the default matches whatever the user picked globally in Settings.
    detailedOverride =
      app.modules["test-pilot"]?.settings?.detailed_steps === true;
    // Reset chat draft + sheet on row open so the new context isn't
    // pre-filled with whatever was typed for the previous row.
    chatDraft = "";
    chatOpen = false;
    if (!test.detail) {
      void app.fetchDetailSteps(test.id);
    }
  }

  function closeDetail() {
    viewing = null;
    copiedBlock = null;
    chatOpen = false;
    chatDraft = "";
    // Scroll-restore so the tester doesn't lose their place. If the
    // active row's section happens to be collapsed (e.g. the user
    // collapsed it before opening detail), force-expand it so the row
    // is actually in the DOM by the time we look it up.
    if (activeTestId) {
      const id = activeTestId;
      const catalog = app.testPilot.catalog;
      if (catalog) {
        for (const section of catalog.sections) {
          if (section.tests.some((t) => t.id === id)) {
            collapsedSections[section.title] = false;
            break;
          }
        }
      }
      void tick().then(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-test-row="${CSS.escape(id)}"]`,
        );
        if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
  }

  function setStatusAndClose(status: TestPilotStatus) {
    if (!viewing) return;
    // Setting status first means the catalog tally reflects
    // the new state before the view tears down.
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
{:else if !app.testPilot.catalog && app.appMode === "standalone"}
  <!-- STANDALONE empty state — Test Pilot catalogs are scoped per
       project, so there's nothing to show until the user picks one. -->
  <section class="space-y-3 p-3">
    <div class="flex items-center gap-2">
      <span class="text-base">🛫</span>
      <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">Test Pilot</h2>
    </div>
    <div class="rounded-md border border-ink-200 dark:border-night-line bg-ink-50 dark:bg-night-alt p-3 text-[12px] text-ink-700 dark:text-night-dim leading-snug space-y-2">
      <p>Test Pilot catalogs are scoped per project. Connect to one above to view its catalog or start a new one.</p>
      <p class="text-ink-500 dark:text-night-mute">
        If you're a tester, ask the developer for their project's
        <code class="font-mono text-[10px] bg-ink-100 dark:bg-night-alt px-1 rounded">pinta-companion</code>
        command.
      </p>
    </div>
  </section>
{:else if !app.testPilot.catalog}
  <!-- EMPTY state (connected) ---------------------------------------- -->
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

  <!-- Phase 14 — Chat FAB (Test Pilot detail view only).
       Bottom-right of the panel, fixed-positioned so it floats over
       the scrolling content. Hidden when the chat sheet is already
       open (the sheet's send button replaces it as the primary
       affordance) or when the chat module setting is off. -->
  {#if chatEnabled && !chatOpen && viewing}
    {@const viewingTest = findViewingTest()}
    {@const chatCount = viewingTest?.chat?.length ?? 0}
    <button
      type="button"
      class="fixed bottom-4 right-4 z-30 w-12 h-12 rounded-full bg-brand-pink text-white shadow-lg hover:bg-brand-magenta dark:hover:bg-brand-pink-light inline-flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
      onclick={() => { chatOpen = true; }}
      title={chatCount > 0
        ? `Resume chat (${chatCount} message${chatCount === 1 ? "" : "s"})`
        : "Ask the agent about this test"}
      aria-label="Open chat with agent"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {#if chatCount > 0}
        <span class="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-white text-brand-pink text-[10px] font-bold inline-flex items-center justify-center border border-brand-pink leading-none">
          {chatCount}
        </span>
      {/if}
    </button>
  {/if}

  <!-- Phase 14 — Chat bottom sheet (Test Pilot detail view only).
       Slides up from the bottom of the side panel with a backdrop
       overlay. Renders the row's chat thread through the same
       `parseStep` + Prism pipeline used for detail steps so inline
       code, fenced blocks, and `> Note:` callouts work identically
       in chat bubbles. -->
  {#if chatOpen && viewing}
    {@const viewingTest = findViewingTest()}
    {@const viewingSection = findViewingSectionTitle()}
    {@const messages = viewingTest?.chat ?? []}
    <!-- Backdrop -->
    <button
      type="button"
      class="fixed inset-0 z-40 bg-black/30 dark:bg-black/50"
      onclick={() => { chatOpen = false; chatDraft = ""; }}
      aria-label="Close chat"
    ></button>
    <!-- Sheet panel -->
    <div
      class="fixed left-0 right-0 bottom-0 z-50 bg-white dark:bg-night-card border-t border-ink-200 dark:border-night-line rounded-t-xl shadow-2xl flex flex-col"
      style="height: 70vh; max-height: 600px; animation: pinta-sheet-slide-up 250ms ease-out;"
      role="dialog"
      aria-label="Chat with agent"
    >
      <!-- Sheet header: drag-handle visual + context chip + close X -->
      <div class="shrink-0 border-b border-ink-200 dark:border-night-line">
        <div class="pt-2 pb-1 flex justify-center">
          <div class="w-8 h-1 rounded-full bg-ink-300 dark:bg-night-line"></div>
        </div>
        <div class="px-4 pb-3 flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="text-[10px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute">
              Talking about
            </div>
            <div class="text-[12px] text-ink-800 dark:text-night-text leading-snug truncate">
              <span class="font-mono font-bold">{viewingTest?.id ?? ""}</span>
              <span class="text-ink-400 dark:text-night-mute"> · </span>
              <span class="text-ink-600 dark:text-night-dim">{viewingSection ?? ""}</span>
            </div>
          </div>
          <button
            type="button"
            class="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full text-ink-500 dark:text-night-mute hover:text-ink-900 dark:hover:text-night-text hover:bg-ink-100 dark:hover:bg-night-alt"
            onclick={() => { chatOpen = false; chatDraft = ""; }}
            aria-label="Close chat"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <!-- Message list — auto-scrolls to bottom via $effect below.
           Renders agent text through `parseStep` so code blocks and
           callouts render the same way as detail steps. -->
      <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3" bind:this={chatScrollEl}>
        {#if messages.length === 0}
          <p class="text-[12px] text-ink-500 dark:text-night-mute italic leading-snug">
            Ask anything about this test — why a step behaves a certain way, what the agent expects to see, how to reproduce an edge case. The row's context (ID, title, expected result, loaded steps) is auto-attached.
          </p>
        {:else}
          {#each messages as msg (msg.id)}
            {#if msg.role === "user"}
              <div class="flex justify-end">
                <div class="max-w-[85%] rounded-lg rounded-br-sm bg-brand-pink text-white text-[12.5px] leading-snug px-3 py-2 whitespace-pre-wrap break-words">
                  {msg.text}
                </div>
              </div>
            {:else}
              {@const blocks = parseStep(msg.text)}
              <div class="flex justify-start">
                <div class="max-w-[90%] rounded-lg rounded-bl-sm bg-ink-100 dark:bg-night-alt text-ink-800 dark:text-night-text text-[12.5px] leading-snug px-3 py-2 space-y-2">
                  {#each blocks as block, bi (bi)}
                    {#if block.kind === "text"}
                      <p class="leading-relaxed">
                        {#each block.parts as part, pi (pi)}
                          {#if part.kind === "code"}
                            <code class="font-mono text-[11px] bg-white dark:bg-night-card text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                          {:else}
                            <span>{part.value}</span>
                          {/if}
                        {/each}
                      </p>
                    {:else if block.kind === "code"}
                      <div class="rounded-md overflow-hidden border border-ink-200 dark:border-night-line bg-white dark:bg-night-card/60">
                        <div class="px-2.5 py-1 text-[10px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute border-b border-ink-200 dark:border-night-line">
                          {block.lang || "code"}
                        </div>
                        <div class="pinta-code px-2.5 py-1.5 text-[11px] leading-relaxed overflow-x-auto"><pre><code class="font-mono">{@html highlight(block.body, block.lang)}</code></pre></div>
                      </div>
                    {:else if block.kind === "note"}
                      <div class="border-l-2 border-ink-300 dark:border-night-line pl-2.5 py-0.5 text-[11.5px] text-ink-600 dark:text-night-dim leading-relaxed">
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
              </div>
            {/if}
          {/each}
          {#if chatPending}
            <div class="flex justify-start">
              <div class="rounded-lg rounded-bl-sm bg-ink-100 dark:bg-night-alt text-ink-600 dark:text-night-mute text-[12px] px-3 py-2 inline-flex items-center gap-2">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                Agent is thinking…
              </div>
            </div>
          {/if}
        {/if}
        {#if app.testPilot.error}
          <div class="rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[11.5px] text-red-700 dark:text-red-300 leading-snug">
            {app.testPilot.error}
          </div>
        {/if}
      </div>

      <!-- Input bar — textarea + send. Cmd/Ctrl+Enter to send; Enter
           is newline for multi-line questions. -->
      <div class="shrink-0 border-t border-ink-200 dark:border-night-line p-3 bg-white dark:bg-night-card">
        {#if app.connectionStatus !== "connected"}
          <p class="text-[11px] text-red-600 dark:text-red-400 mb-2 leading-snug">
            Companion disconnected. Reconnect to ask the agent.
          </p>
        {/if}
        <div class="flex items-end gap-2">
          <textarea
            rows="2"
            placeholder="Ask the agent about this test…"
            class="flex-1 text-[12.5px] text-ink-800 dark:text-night-text bg-white dark:bg-night-card border border-ink-200 dark:border-night-line rounded-md px-2.5 py-1.5 leading-snug resize-none focus:outline-none focus:ring-2 focus:ring-brand-pink/40 placeholder:text-ink-400 dark:placeholder:text-night-mute"
            bind:value={chatDraft}
            onkeydown={onChatKeyDown}
            disabled={chatPending}
          ></textarea>
          <button
            type="button"
            class="shrink-0 h-10 px-3 rounded-md bg-brand-pink text-white text-[12.5px] font-semibold hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            onclick={sendChat}
            disabled={chatPending || chatDraft.trim() === "" || app.connectionStatus !== "connected"}
            title="Send (Cmd/Ctrl + Enter)"
            aria-label="Send message"
          >
            {#if chatPending}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            {:else}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              Send
            {/if}
          </button>
        </div>
      </div>
    </div>
  {/if}
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
          class="inline-flex items-center gap-1 text-[11px] text-ink-700 dark:text-night-dim hover:text-red-600 dark:hover:text-red-400 px-2 py-1.5 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card disabled:opacity-50 disabled:cursor-not-allowed"
          onclick={clearMarks}
          disabled={t.pass + t.fail === 0}
          title={t.pass + t.fail === 0
            ? "Nothing to clear — no rows are marked yet"
            : "Reset all Pass/Fail marks back to untested (keeps the catalog)"}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          Clear marks
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
        {@const secUnloaded = section.tests.filter((t) => !t.detail).length}
        {@const secBulkFetching = !!bulkFetchingSections[section.title]}
        {@const editingThisSection =
          editingField === `section:${section.title}` ||
          (editingField === "section:" && section.title === "")}
        <div class="rounded-lg border border-ink-200 dark:border-night-line bg-ink-50 dark:bg-night-alt overflow-hidden">
          <div class="pinta-section-trigger flex items-stretch text-[12px] font-medium text-ink-900 dark:text-night-text">
            {#if editingThisSection}
              <!-- Inline-edit: the entire left side becomes an input.
                   Collapse toggle is hidden while editing (the user is
                   typing the title, not browsing). -->
              <div class="flex items-center gap-2 min-w-0 flex-1 px-3 py-2">
                <span class="relative inline-flex shrink-0 text-brand-pink dark:text-brand-pink-light" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 3h6" />
                    <path d="M10 3v6.5L4.4 18.7A1.6 1.6 0 0 0 5.8 21h12.4a1.6 1.6 0 0 0 1.4-2.3L14 9.5V3" />
                    <path d="M7.5 14.5h9" opacity="0.55" />
                  </svg>
                </span>
                <input
                  type="text"
                  class="flex-1 min-w-0 text-[12px] font-bold text-ink-900 dark:text-night-text bg-white dark:bg-night-card border border-brand-pink dark:border-brand-pink-light rounded outline-none px-1.5 py-0.5"
                  bind:value={editingDraft}
                  onkeydown={onEditKey}
                  onblur={commitEdit}
                  placeholder="Section title (e.g. 1.1 Authentication)"
                  autofocus
                />
              </div>
            {:else}
              <button
                type="button"
                class="flex items-center gap-2 min-w-0 flex-1 px-3 py-2.5 text-left hover:bg-ink-100 dark:hover:bg-night-line"
                onclick={() => (collapsedSections[section.title] = !collapsed)}
                aria-expanded={!collapsed}
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
                <span class="truncate font-bold">{section.title || "Untitled section"}</span>
              </span>
              </button>
            {/if}
            <!-- Right edge: tally chip + section-wide "Ask all" button +
                 kebab menu. Separate from the collapse toggle so we can
                 have multiple click targets without nesting buttons. -->
            <div class="relative flex items-center gap-1.5 shrink-0 pr-2">
              <!-- Per-section tally: pass · fail · % complete. Pass and
                   fail are color-coded; pct is dim. Separators are thin
                   vertical bars so the trio reads as one badge. Falls
                   back to a single count chip if nothing has been tested
                   yet (zero pass + zero fail) to keep the header tidy. -->
              <span class="inline-flex items-center gap-1.5 text-[11px] font-semibold tabular-nums bg-white/70 dark:bg-night-card/70 rounded px-2 py-0.5">
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
              <!-- Section-wide Ask. Hidden once every test in the section
                   has a cached detail (nothing left to ask). Disabled +
                   spinning while the queue is chewing through the
                   section. -->
              {#if secUnloaded > 0}
                <button
                  type="button"
                  class="shrink-0 w-8 h-9 inline-flex items-center justify-center rounded-full hover:bg-ink-100 dark:hover:bg-night-line disabled:opacity-60 disabled:cursor-not-allowed"
                  class:text-brand-pink={secBulkFetching}
                  class:dark:text-brand-pink-light={secBulkFetching}
                  class:text-ink-500={!secBulkFetching}
                  class:dark:text-night-dim={!secBulkFetching}
                  class:hover:text-brand-pink={!secBulkFetching}
                  class:dark:hover:text-brand-pink-light={!secBulkFetching}
                  onclick={() => askAllInSection(section)}
                  disabled={secBulkFetching}
                  title={secBulkFetching
                    ? `Asking the agent for steps on every test in this section…`
                    : `Ask for steps on all ${secUnloaded} unanswered test${secUnloaded === 1 ? "" : "s"} in this section`}
                  aria-label={`Ask for steps on every test in ${section.title}`}
                >
                  {#if secBulkFetching}
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  {:else}
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  {/if}
                </button>
              {/if}

              <!-- Kebab — section actions (rename / delete / move /
                   add test below). Hidden while inline-editing this
                   section's title. -->
              {#if !editingThisSection}
                {@const sIdx = app.testPilot.catalog.sections.findIndex((s) => s.title === section.title)}
                {@const isFirstSection = sIdx === 0}
                {@const isLastSection = sIdx === app.testPilot.catalog.sections.length - 1}
                <button
                  type="button"
                  data-pinta-kebab-trigger
                  class="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full text-ink-500 dark:text-night-dim hover:text-ink-900 dark:hover:text-night-text hover:bg-ink-100 dark:hover:bg-night-line"
                  onclick={() => toggleSectionKebab(section.title)}
                  aria-haspopup="menu"
                  aria-expanded={sectionKebabOpen === section.title}
                  aria-label="Section actions"
                  title="Section actions"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="12" cy="5" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="12" cy="19" r="1.6" />
                  </svg>
                </button>
                {#if sectionKebabOpen === section.title}
                  <div
                    data-pinta-kebab-menu
                    class="absolute z-30 right-2 top-9 bg-white dark:bg-night-card border border-ink-200 dark:border-night-line rounded-md shadow-lg py-1 min-w-[160px]"
                    role="menu"
                  >
                    <button
                      type="button"
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text"
                      onclick={() => onSectionRename(section.title)}
                      role="menuitem"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                      Rename
                    </button>
                    <button
                      type="button"
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text"
                      onclick={() => onSectionAddTest(section.title)}
                      role="menuitem"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                      Add test below
                    </button>
                    <div class="my-1 border-t border-ink-100 dark:border-night-line"></div>
                    <button
                      type="button"
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-700 dark:disabled:hover:text-night-dim"
                      onclick={() => onSectionMove(section.title, "up")}
                      disabled={isFirstSection}
                      role="menuitem"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
                      Move up
                    </button>
                    <button
                      type="button"
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-700 dark:disabled:hover:text-night-dim"
                      onclick={() => onSectionMove(section.title, "down")}
                      disabled={isLastSection}
                      role="menuitem"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
                      Move down
                    </button>
                    <div class="my-1 border-t border-ink-100 dark:border-night-line"></div>
                    <button
                      type="button"
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                      onclick={() => onSectionDelete(section.title)}
                      role="menuitem"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
                      Delete section
                    </button>
                  </div>
                {/if}
              {/if}
            </div>
          </div>
          {#if !collapsed}
            <ul class="border-t border-ink-200 dark:border-night-line">
              {#each section.tests as test (test.id)}
                {@const detailLoading = !!app.testPilot.pendingDetails[test.id]}
                {@const detailLoaded = !!test.detail}
                {@const isActive = activeTestId === test.id}
                {@const editingTitle = editingField === `test-title:${test.id}`}
                {@const editingExpected = editingField === `test-expected:${test.id}`}
                <li
                  class="relative border-b border-ink-200 dark:border-night-line last:border-b-0"
                  data-test-row={test.id}
                >
                  <div
                    class="flex items-start gap-3 px-3 py-3 transition-colors {isActive
                      ? 'bg-ink-100 dark:bg-night-alt'
                      : 'bg-white dark:bg-night-card'}"
                  >
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

                    <!-- ID + title + expected (stacked). Inline-editable
                         when the user picks Edit from the row kebab —
                         title and expected each become their own input
                         keyed by `test-title:ID` / `test-expected:ID`
                         (consts hoisted up to the {#each} block). -->
                    {#if editingTitle || editingExpected}
                      <div class="flex-1 min-w-0 space-y-1">
                        <div class="font-mono text-[10px] font-bold tracking-wide text-ink-500 dark:text-night-mute">{test.id}</div>
                        {#if editingTitle}
                          <input
                            type="text"
                            class="w-full text-[12px] font-semibold text-ink-900 dark:text-night-text bg-white dark:bg-night-card border border-brand-pink dark:border-brand-pink-light rounded outline-none px-1.5 py-0.5 leading-snug"
                            bind:value={editingDraft}
                            onkeydown={onEditKey}
                            onblur={commitEdit}
                            placeholder="What does this test verify?"
                            autofocus
                          />
                          <p class="text-[11px] text-ink-500 dark:text-night-mute leading-snug">{test.expected}</p>
                        {:else}
                          <div class="text-[12px] font-semibold text-ink-900 dark:text-night-text leading-snug">{test.test || "(no title)"}</div>
                          <textarea
                            rows="2"
                            class="w-full text-[11px] text-ink-700 dark:text-night-dim bg-white dark:bg-night-card border border-brand-pink/60 dark:border-brand-pink-light/60 rounded outline-none px-1.5 py-0.5 leading-snug resize-y"
                            bind:value={editingDraft}
                            onkeydown={onEditKey}
                            onblur={commitEdit}
                            placeholder="Expected result (Shift+Enter for newline)"
                            autofocus
                          ></textarea>
                        {/if}
                      </div>
                    {:else}
                      <div
                        role="button"
                        tabindex="0"
                        class="flex-1 min-w-0 cursor-pointer rounded -mx-0.5 px-0.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-pink/40"
                        onclick={() => setActive(test.id)}
                        onkeydown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setActive(test.id);
                          }
                        }}
                        aria-pressed={isActive}
                        aria-label={`Select ${test.id}`}
                      >
                        <div class="font-mono text-[10px] font-bold tracking-wide text-ink-500 dark:text-night-mute">{test.id}</div>
                        <div class="text-[12px] font-semibold text-ink-900 dark:text-night-text leading-snug mt-1">{test.test || "(no title — click the kebab menu to add one)"}</div>
                        <p class="text-[11px] text-ink-500 dark:text-night-mute leading-snug mt-1">{test.expected || "(no expected result yet)"}</p>
                      </div>
                    {/if}

                    <!-- Row actions — chat indicator + ask-icon
                         clustered tight (gap-0) so they read as one
                         button group instead of inheriting the row's
                         gap-3 between them. Hit targets stay 36px so
                         tap accuracy is unchanged. -->
                    <div class="flex items-start shrink-0 mt-0.5">
                      <!-- Chat indicator — speech bubble that lights
                           up brand-pink when the row has chat history.
                           Clicking opens the detail view and the chat
                           sheet so the tester can resume the thread.
                           Hidden when chat is disabled via module
                           setting. -->
                      {#if chatEnabled}
                        {@const hasChat = (test.chat?.length ?? 0) > 0}
                        <button
                          type="button"
                          class="shrink-0 w-8 h-9 inline-flex items-center justify-center rounded-full hover:bg-ink-50 dark:hover:bg-night-alt"
                          class:text-brand-pink={hasChat}
                          class:dark:text-brand-pink-light={hasChat}
                          class:text-ink-400={!hasChat}
                          class:dark:text-night-mute={!hasChat}
                          class:hover:text-brand-pink={true}
                          class:dark:hover:text-brand-pink-light={true}
                          onclick={() => { openDetail(test); chatOpen = true; }}
                          title={hasChat
                            ? `${test.chat!.length} chat message${test.chat!.length === 1 ? "" : "s"} with the agent`
                            : "Ask the agent a question about this row"}
                          aria-label={hasChat
                            ? `View chat for ${test.id}`
                            : `Open chat for ${test.id}`}
                        >
                          <svg width="17" height="17" viewBox="0 0 24 24" fill={hasChat ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </svg>
                        </button>
                      {/if}

                      <!-- Ask icon — spinner while fetching, pink once
                           the agent has answered, gray otherwise -->
                      <button
                        type="button"
                        class="shrink-0 w-8 h-9 inline-flex items-center justify-center rounded-full hover:bg-ink-50 dark:hover:bg-night-alt"
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
                          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin text-brand-pink dark:text-brand-pink-light" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                        {:else}
                          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                        {/if}
                      </button>

                      <!-- Row kebab — edit / delete / move. Hidden
                           while inline-editing to keep the focused
                           input the only target. -->
                      {#if !editingTitle && !editingExpected}
                        {@const sIdx2 = app.testPilot.catalog.sections.findIndex((s) => s.title === section.title)}
                        {@const tIdx = sIdx2 >= 0 ? app.testPilot.catalog.sections[sIdx2].tests.findIndex((t) => t.id === test.id) : -1}
                        {@const isFirstTest = tIdx === 0}
                        {@const isLastTest = sIdx2 >= 0 && tIdx === app.testPilot.catalog.sections[sIdx2].tests.length - 1}
                        <button
                          type="button"
                          data-pinta-kebab-trigger
                          class="shrink-0 w-7 h-9 inline-flex items-center justify-center rounded-full text-ink-400 dark:text-night-mute hover:text-ink-900 dark:hover:text-night-text hover:bg-ink-50 dark:hover:bg-night-alt"
                          onclick={() => toggleTestKebab(test.id)}
                          aria-haspopup="menu"
                          aria-expanded={testKebabOpen === test.id}
                          aria-label="Row actions for {test.id}"
                          title="Row actions"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <circle cx="12" cy="5" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="12" cy="19" r="1.5" />
                          </svg>
                        </button>
                        {#if testKebabOpen === test.id}
                          <div
                            data-pinta-kebab-menu
                            class="absolute z-30 right-2 top-10 bg-white dark:bg-night-card border border-ink-200 dark:border-night-line rounded-md shadow-lg py-1 min-w-[170px]"
                            role="menu"
                          >
                            <button
                              type="button"
                              class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text"
                              onclick={() => onTestEdit(test.id)}
                              role="menuitem"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                              Edit title
                            </button>
                            <button
                              type="button"
                              class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text"
                              onclick={() => onTestEditExpected(test.id)}
                              role="menuitem"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                              Edit expected
                            </button>
                            <div class="my-1 border-t border-ink-100 dark:border-night-line"></div>
                            <button
                              type="button"
                              class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-700 dark:disabled:hover:text-night-dim"
                              onclick={() => onTestMove(test.id, "up")}
                              disabled={isFirstTest}
                              role="menuitem"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
                              Move up
                            </button>
                            <button
                              type="button"
                              class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-700 dark:disabled:hover:text-night-dim"
                              onclick={() => onTestMove(test.id, "down")}
                              disabled={isLastTest}
                              role="menuitem"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
                              Move down
                            </button>
                            <div class="my-1 border-t border-ink-100 dark:border-night-line"></div>
                            <button
                              type="button"
                              class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                              onclick={() => onTestDelete(test.id)}
                              role="menuitem"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                              Delete
                            </button>
                          </div>
                        {/if}
                      {/if}
                    </div>
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

      <!-- Add-section affordance — appends an empty section + drops
           the user into inline-edit on its title. Mirrors the
           "+ Add author / + Add description" pattern in the header. -->
      <button
        type="button"
        class="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink-300 dark:border-night-line bg-transparent text-[12px] font-medium text-ink-500 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light hover:border-brand-pink dark:hover:border-brand-pink-light py-2.5 transition-colors"
        onclick={onAddSection}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add section
      </button>
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