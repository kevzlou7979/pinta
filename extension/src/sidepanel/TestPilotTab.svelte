<script module lang="ts">
  // Module-scoped state. App.svelte unmounts this tab whenever another
  // tab is active, so anything that must outlive a tab switch lives
  // here rather than in the instance: a tester-sheet prep that is still
  // generating steps keeps its progress (and its single-run guard) for
  // the instance that mounts next, and the Ask-all bulk queue keeps
  // serializing agent calls across instances.
  export type TesterSheetTarget = "md" | "docx" | "gmail" | "mailto";
  /** Live tester-sheet prep: `cancel` = stop after the in-flight row,
   *  `inFlight` = the row currently asked (for "Stop now"). */
  let stepPrep = $state<{ done: number; total: number; cancel: boolean; inFlight: string | null } | null>(null);
  /** Outcome line when a prep could not complete (standalone, cancelled,
   *  agent error, scope changed) — offers Retry / download anyway. */
  let stepPrepNote = $state<string | null>(null);
  /** Which export asked, so the status lands under the right block and
   *  Retry / anyway re-run the same export. */
  let stepPrepTarget = $state<TesterSheetTarget | null>(null);
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
</script>

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
  import { confirmDialog } from "../lib/confirm.svelte.js";
  import type { TestPilotSignoff } from "../lib/test-pilot-md.js";
  import MicButton from "../lib/voice/MicButton.svelte";
  import { parseStep } from "../lib/step-md.js";
  import { escapeHtml, loadChatSheet, loadPrism } from "../lib/lazy-ui.js";
  import { safeExternalUrl } from "../content/capture.js";
  import { isEmailish, openMailDraftTab, type MailDraft, type MailVia } from "../lib/mail.js";

  // Prism (and ChatSheet, which bundles it) load on demand — code blocks
  // render as escaped plain text until the highlighter arrives.
  let highlighter = $state<((code: string, lang: string) => string) | null>(null);
  let highlighterRequested = false;
  function highlight(code: string, lang: string): string {
    if (highlighter) return highlighter(code, lang);
    if (!highlighterRequested) {
      highlighterRequested = true;
      loadPrism().then(
        (m) => (highlighter = m.highlight),
        () => {}, // keep plain text; a later render doesn't retry
      );
    }
    return escapeHtml(code);
  }

  let fileInput = $state<HTMLInputElement | null>(null);
  let viewing = $state<{ testId: string } | null>(null);
  // Catalog search — filters the CATALOG view by free text matched
  // against test id (e.g. "AUTH-1"), section title (category), and test
  // title / expected-result content. Empty string = no filter. While a
  // query is active, sections render expanded regardless of their saved
  // collapse state so matches are never hidden behind a collapsed header.
  let searchQuery = $state("");
  let searchEl: HTMLInputElement | undefined = $state();
  const searchActive = $derived(searchQuery.trim().length > 0);
  // Export dropdown — three options (results MD, tester MD, tester DOCX)
  // surfaced as a small menu off the Export button. Closes on outside
  // click via the existing onDocClick handler below.
  let exportMenuOpen = $state(false);
  /** Export trigger — Escape inside the popover hands focus back here. */
  let exportBtnEl = $state<HTMLButtonElement | null>(null);
  /** Email section: in-flight flag + the "it downloaded" confirmation,
   *  so the popover isn't a black hole while the draft opens. */
  let emailBusy = $state(false);
  let emailedNote = $state<string | null>(null);
  const emailReady = $derived(isEmailish(app.testerInfo.recipient));
  /** The last `mailto:` draft we handed to the OS. After a long step
   *  prep the click gesture is gone, so a popup blocker may have eaten
   *  it — the confirmation line offers to open it again from a fresh
   *  click. (Gmail goes through the tabs API and needs no gesture.) */
  let lastMailDraft = $state<{ draft: MailDraft; via: MailVia } | null>(null);
  // Phase 21 — "Work on" scope. A pure view filter: rows stay in the
  // catalog, keep their marks, and still ride the .pinta bundle.
  const scopeActive = $derived(app.testPilot.scope.kind !== "all");
  const catalogRev = $derived(app.testPilot.catalog?.rev ?? 1);
  const revisionLog = $derived(app.testPilot.catalog?.revisions ?? []);
  /** Base revisions worth offering: newest first, latest capped at a
   *  handful so the dropdown stays readable on a long-lived catalog. */
  const scopeBaseRevs = $derived(
    revisionLog
      .map((r) => r.rev - 1)
      .filter((r) => r >= 1)
      .filter((r, i, arr) => arr.indexOf(r) === i)
      .sort((a, b) => b - a)
      .slice(0, 5),
  );
  /** True once the catalog has been regenerated at least once — before
   *  that there is no "what's new" to offer, and the selector says so
   *  instead of silently omitting the option. */
  const hasRevisionHistory = $derived(scopeBaseRevs.length > 0);
  let planNameOpen = $state(false);
  let planName = $state("");
  let planNameEl = $state<HTMLInputElement | null>(null);
  /** Inline blocker for the plan row — the shared error banner renders
   *  below the stats block, which is off-screen on a 288px panel. */
  let planError = $state<string | null>(null);

  /** The dropdown's value is a token so one <select> can carry every
   *  scope shape; these two translate. */
  function scopeToToken(scope: typeof app.testPilot.scope): string {
    if (scope.kind === "since") return `since:${scope.rev}`;
    if (scope.kind === "plan") {
      // A plan that no longer exists filters nothing, so the control
      // shows "Everything" rather than rendering blank.
      return app.testPilot.plans.some((p) => p.id === scope.id)
        ? `plan:${scope.id}`
        : "all";
    }
    return scope.kind;
  }

  function applyScopeToken(token: string): void {
    if (token.startsWith("since:")) {
      app.setTestPilotScope({ kind: "since", rev: Number(token.slice(6)) });
    } else if (token.startsWith("plan:")) {
      app.setTestPilotScope({ kind: "plan", id: token.slice(5) });
    } else if (token === "failed" || token === "untested" || token === "all") {
      app.setTestPilotScope({ kind: token });
    }
  }

  function saveScopeAsPlan(): void {
    if (!planName.trim()) {
      planError = "Give the plan a name first.";
      return;
    }
    const plan = app.saveCurrentScopeAsPlan(planName);
    if (!plan) {
      // saveCurrentScopeAsPlan sets the shared error for a duplicate
      // name; an empty scope is the only other way it returns null.
      planError =
        app.testPilot.error ?? "Nothing in scope to save as a plan.";
      app.testPilot.error = null;
      return;
    }
    planError = null;
    planName = "";
    planNameOpen = false;
  }

  /** Open the name row and put the cursor in it — one click, not two. */
  async function openPlanNameRow(): Promise<void> {
    planNameOpen = !planNameOpen;
    planError = null;
    if (!planNameOpen) return;
    await tick();
    planNameEl?.focus();
  }

  async function removePlan(id: string): Promise<void> {
    const plan = app.testPilot.plans.find((p) => p.id === id);
    const ok = await confirmDialog({
      title: "Delete this plan?",
      message: `“${plan?.name ?? "This plan"}” will be removed from the Work-on list. The tests themselves stay in the catalog.`,
      confirmLabel: "Delete plan",
      danger: true,
    });
    if (!ok) return;
    app.deleteTestPlan(id);
  }
  /** Anchor the Export popover's left edge to the button when a
   *  right-anchored w-72 (288px) popover would spill off the panel's left. */
  let exportMenuAlignLeft = $state(false);
  // The currently "selected" test row in the catalog. Set when the user
  // clicks a row body or opens its detail view; used to (a) tint the row
  // as a bookmark cursor and (b) scroll-restore back to it when the user
  // returns from the detail view via "Back to catalog".
  let activeTestId = $state<string | null>(null);
  // `bulkFetchingSections` / `bulkQueue` live in the module script above.
  // Per-section completion ledger. Plain Map (NOT `$state`) so the
  // auto-collapse $effect can read+write it without forming a tracked
  // read-write loop on its own dependency graph. The effect reads
  // catalog (reactive), writes `collapsedSections` (reactive, user-
  // visible), and uses this Map as a non-reactive transition gate to
  // fire exactly once on the <100% → 100% boundary.
  const prevSectionComplete = new Map<string, boolean>();

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
      const was = prevSectionComplete.get(section.title) === true;
      // Fire on the transition only — leaves manual re-expand alone.
      if (isComplete && !was) {
        collapsedSections[section.title] = true;
      }
      prevSectionComplete.set(section.title, isComplete);
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
  // Which test row the chat sheet is bound to. Tracked separately from
  // `viewing` so the catalog-row chat icon can open the sheet without
  // entering the steps DETAIL view (and without firing a fetchDetailSteps
  // round-trip the tester didn't ask for). In DETAIL view this mirrors
  // `viewing.testId`; over the catalog it's set on its own.
  let chatTestId = $state<string | null>(null);
  // True when the Chat module is enabled in Settings. Phase 14 made
  // chat its own module ("id: chat") with one master toggle that gates
  // all three chat surfaces (Test Pilot FAB, Annotate Just Ask, global
  // header icon). Off by default — users opt in.
  const chatEnabled = $derived(app.moduleReady("chat"));
  const gitlabReady = $derived(app.moduleReady("gitlab-issues"));
  // WS2 — an imported tester run is overlaid: every mark-editing surface
  // (row status trigger, detail Pass/Fail, Clear marks) is read-only
  // until the run is cleared. One shared title so the reason is visible
  // at each disabled control, not just in the banner.
  const readOnlyRun = $derived(!!app.testPilot.importedRun);
  /** Denominator for the imported-run banner — every test in the
   *  catalog, scope ignored (the run's marks landed on the whole thing). */
  const catalogTotal = $derived(
    (app.testPilot.catalog?.sections ?? []).reduce((n, s) => n + s.tests.length, 0),
  );
  const READ_ONLY_TITLE = "Read-only — Clear the imported run to edit";
  /** Smoke vs Thorough generation depth — the `thorough_tests` module
   *  setting, toggleable inline so the choice sits next to Generate. */
  const thoroughOn = $derived(
    app.modules["test-pilot"]?.settings?.thorough_tests === true,
  );
  function setThorough(on: boolean): void {
    app.setModuleSetting("test-pilot", "thorough_tests", on);
  }
  // True while the chat-bound row has a chat ask in flight.
  // Drives the send-button spinner.
  const chatPending = $derived(
    chatTestId ? !!app.testPilot.pendingChats[chatTestId] : false,
  );

  // ── WS4 — failed-test selection sheet ─────────────────────────────
  // The "File failed tests" icon opens a small inline checkbox sheet
  // (all rows pre-checked) instead of filing everything blind.
  let fileIssuesOpen = $state(false);
  let fileIssuesSelected = $state<Record<string, boolean>>({});
  /** Failed rows that don't have an issue filed yet — the sheet's list
   *  and the universe `fileFailedTestsToGitLab(selectedIds)` filters. */
  const failedUnfiled = $derived.by(() => {
    // Read the getter once — it rebuilds a Set on every access.
    const scoped = app.scopedTestIds;
    return (app.testPilot.catalog?.sections ?? []).flatMap((s) =>
      s.tests
        .filter(
          (t) =>
            t.status === "fail" &&
            !app.testPilot.filedIssues[t.id] &&
            // Follow the active scope — the button's count comes from
            // the scoped tally, so its universe has to match or the
            // sheet opens pre-checked with rows the tester can't see.
            (!scoped || scoped.has(t.id)),
        )
        .map((t) => ({ id: t.id, section: s.title, test: t.test })),
    );
  });
  const fileIssuesCheckedCount = $derived(
    failedUnfiled.filter((r) => fileIssuesSelected[r.id]).length,
  );
  function openFileIssuesSheet(): void {
    if (failedUnfiled.length === 0) {
      // Nothing left to pick — let the state method surface the
      // "already filed" / "no failures" message (no agent run).
      void app.fileFailedTestsToGitLab();
      return;
    }
    const sel: Record<string, boolean> = {};
    for (const r of failedUnfiled) sel[r.id] = true;
    fileIssuesSelected = sel;
    fileIssuesOpen = true;
  }
  function confirmFileIssues(): void {
    const ids = failedUnfiled
      .filter((r) => fileIssuesSelected[r.id])
      .map((r) => r.id);
    fileIssuesOpen = false;
    if (ids.length > 0) void app.fileFailedTestsToGitLab(ids);
  }
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
  // When a row is freshly added via "Add test", we drop the user into
  // the title editor first; on commit we chain straight into the
  // expected editor for the same row so adding an entry is a single
  // title-then-expected flow (rather than forcing them to hunt for the
  // kebab → "Edit expected"). Holds the new row's id while that chain
  // is pending; cleared once expected opens (or the add is cancelled).
  let chainExpectedId = $state<string | null>(null);
  // Kebab menus — keyed by section title (sections) or test id (rows).
  // Outside-click handler nulls them. Mutually exclusive — opening any
  // kebab closes the others.
  let sectionKebabOpen = $state<string | null>(null);
  let testKebabOpen = $state<string | null>(null);

  // Phase 14.4 — drag-and-drop reorder state. Grip handles on each
  // section card + test row drive native HTML5 drag; we track the
  // currently-dragged item plus the per-target insertion hint
  // ("above" / "below" the row at hand) so we can render a thin pink
  // bar at the precise drop point. Within-section only for v1 — a
  // test dragged over a different section's rows is silently
  // rejected (drop hint never sets). Move-up/down kebab arrows stay
  // wired to the old `moveTestPilotSection/Test` calls; drag goes
  // through the new index-based `reorderTestPilotSection/Test`.
  type DragKind = "section" | "test";
  type DragItem = { kind: DragKind; sectionTitle: string; testId?: string };
  type DropHint = { key: string; position: "above" | "below" };
  let dragging = $state<DragItem | null>(null);
  let dropHint = $state<DropHint | null>(null);

  function dragKey(item: DragItem): string {
    return item.testId
      ? `test:${item.testId}`
      : `section:${item.sectionTitle}`;
  }

  function onItemDragStart(e: DragEvent, item: DragItem) {
    // Block drag during inline edit so the user's typing isn't
    // hijacked by a stray drag start.
    if (editingField != null) {
      e.preventDefault();
      return;
    }
    dragging = item;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Stash a key so a hypothetical external drop target could
      // identify what was dragged. Not load-bearing — internal drop
      // reads `dragging` directly.
      e.dataTransfer.setData("text/plain", dragKey(item));
    }
  }

  function onItemDragOver(e: DragEvent, target: DragItem) {
    if (!dragging) return;
    if (dragging.kind !== target.kind) return;
    // Within-section only: a test dragged over a row in a different
    // section gets no drop hint, so the drop is silently rejected.
    if (
      target.kind === "test" &&
      dragging.sectionTitle !== target.sectionTitle
    ) {
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    const position: "above" | "below" = e.clientY < mid ? "above" : "below";
    const key = dragKey(target);
    // Only re-assign when something actually changed — keeps Svelte's
    // dirty checks cheap while the user holds + moves over a row.
    if (
      !dropHint ||
      dropHint.key !== key ||
      dropHint.position !== position
    ) {
      dropHint = { key, position };
    }
  }

  function onItemDrop(e: DragEvent, _target: DragItem) {
    // `_target` is the leaf element the drop event landed on, but we
    // route by `dropHint` instead. Without that distinction, a drop
    // of a section onto an inner test row would route to the
    // test-row handler (target.kind === "test") and skip the reorder
    // even though dropHint correctly identifies the destination
    // section. dropHint is set by whichever dragover most recently
    // matched the dragged kind — that's the right anchor for where
    // to insert.
    e.preventDefault();
    e.stopPropagation();
    if (!dragging || !dropHint) {
      dragging = null;
      dropHint = null;
      return;
    }
    // Snapshot into a const so the narrowing above survives into the
    // findIndex/find callbacks (TS can't keep it on a mutable let).
    const drag = dragging;
    // Drop onto self → no-op.
    if (dropHint.key === dragKey(drag)) {
      dragging = null;
      dropHint = null;
      return;
    }
    const catalog = app.testPilot.catalog;
    if (!catalog) {
      dragging = null;
      dropHint = null;
      return;
    }
    if (drag.kind === "section" && dropHint.key.startsWith("section:")) {
      const targetTitle = dropHint.key.slice("section:".length);
      let toIdx = catalog.sections.findIndex(
        (s) => s.title === targetTitle,
      );
      if (toIdx >= 0) {
        if (dropHint.position === "below") toIdx += 1;
        const fromIdx = catalog.sections.findIndex(
          (s) => s.title === drag.sectionTitle,
        );
        // Adjust for the splice-out that happens before splice-in:
        // when the source is before the destination, every index
        // ≥ source shifts down by 1 after the removal.
        if (fromIdx >= 0 && fromIdx < toIdx) toIdx -= 1;
        app.reorderTestPilotSection(drag.sectionTitle, toIdx);
      }
    } else if (
      drag.kind === "test" &&
      drag.testId &&
      dropHint.key.startsWith("test:")
    ) {
      const targetTestId = dropHint.key.slice("test:".length);
      const section = catalog.sections.find(
        (s) => s.title === drag.sectionTitle,
      );
      if (section) {
        let toIdx = section.tests.findIndex((t) => t.id === targetTestId);
        if (toIdx >= 0) {
          if (dropHint.position === "below") toIdx += 1;
          const fromIdx = section.tests.findIndex(
            (t) => t.id === drag.testId,
          );
          if (fromIdx >= 0 && fromIdx < toIdx) toIdx -= 1;
          app.reorderTestPilotTest(drag.testId, toIdx);
        }
      }
    }
    dragging = null;
    dropHint = null;
  }

  function onItemDragEnd() {
    dragging = null;
    dropHint = null;
  }

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
      // Freshly-added row: chain into its expected editor so the user
      // fills both fields in one pass instead of leaving "(no expected
      // result yet)" behind.
      if (chainExpectedId === id) {
        chainExpectedId = null;
        startEditing(`test-expected:${id}`);
        return;
      }
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
    // Bailing out of a brand-new row's title — drop the pending
    // title→expected chain so we don't yank the user into the expected
    // editor of a row they just abandoned.
    chainExpectedId = null;
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
  async function onSectionDelete(title: string) {
    sectionKebabOpen = null;
    if (
      !(await confirmDialog({
        message: `Delete section "${title}" and all its tests? This can't be undone.`,
        confirmLabel: "Delete",
        danger: true,
      }))
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
      // Drop the user into inline-edit on the new row's title, then
      // chain into the expected editor on commit (see commitEdit).
      chainExpectedId = newId;
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
      // A programmatic <a download> click (downloadBlob) is not the
      // user clicking away — leave every menu as it is.
      if (target.closest("[data-pinta-download]")) return;
      const inStatus =
        target.closest("[data-pinta-status-trigger]") ||
        target.closest("[data-pinta-status-menu]");
      const inKebab =
        target.closest("[data-pinta-kebab-trigger]") ||
        target.closest("[data-pinta-kebab-menu]");
      const inExport = target.closest("[data-pinta-export-menu]");
      if (!inStatus) dropdownTestId = null;
      if (!inKebab) {
        sectionKebabOpen = null;
        testKebabOpen = null;
      }
      if (!inExport && exportMenuOpen) {
        // Closing on an outside click never fires the input's `change`,
        // so the typed recipient would be lost on the next panel load.
        app.saveTesterInfo();
        exportMenuOpen = false;
      }
    }
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
  });

  // Phase 14.4 — auto-scroll the side panel while a drag is in flight
  // and the cursor approaches the top/bottom edge. Without this, long
  // catalogs are unusable for reorder (you'd have to drop, scroll
  // manually, re-pick the row, drop again — defeats the point of
  // drag-and-drop). Standard pattern: window-level dragover handler
  // measures cursor distance to the scroll container's edges and
  // nudges scrollTop proportionally to proximity. No preventDefault
  // here — per-element ondragover still controls where drops are
  // allowed; this listener only scrolls.
  onMount(() => {
    let scrollContainerCache: HTMLElement | null = null;
    function getScrollContainer(): HTMLElement | null {
      if (scrollContainerCache && document.contains(scrollContainerCache)) {
        return scrollContainerCache;
      }
      // The side panel's scrollable region is `<main class="flex-1
      // overflow-y-auto p-4 space-y-4">` in App.svelte. Lookup is
      // cached so we don't query on every dragover tick.
      scrollContainerCache = document.querySelector<HTMLElement>(
        "main.flex-1.overflow-y-auto",
      );
      return scrollContainerCache;
    }
    const SCROLL_EDGE_PX = 80;
    const MAX_SCROLL_SPEED = 14;
    function onWindowDragOver(e: DragEvent) {
      if (!dragging) return;
      const container = getScrollContainer();
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const distFromTop = e.clientY - rect.top;
      const distFromBottom = rect.bottom - e.clientY;
      if (distFromTop >= 0 && distFromTop < SCROLL_EDGE_PX) {
        // Closer to top → faster upward scroll. `t` is 0 at the edge
        // boundary, 1 right at the top.
        const t = (SCROLL_EDGE_PX - distFromTop) / SCROLL_EDGE_PX;
        container.scrollTop -= MAX_SCROLL_SPEED * t;
      } else if (distFromBottom >= 0 && distFromBottom < SCROLL_EDGE_PX) {
        const t = (SCROLL_EDGE_PX - distFromBottom) / SCROLL_EDGE_PX;
        container.scrollTop += MAX_SCROLL_SPEED * t;
      }
    }
    window.addEventListener("dragover", onWindowDragOver);
    return () => window.removeEventListener("dragover", onWindowDragOver);
  });

  function onPickFile() {
    fileInput?.click();
  }

  async function clearMarks() {
    const c = app.testPilot.catalog;
    if (!c) return;
    // Read-only while an imported run is shown (button is disabled too;
    // this mirrors the state-level guard in clearTestPilotMarks).
    if (readOnlyRun) return;
    const marked = c.sections.reduce(
      (n, s) => n + s.tests.filter((t) => t.status !== "untested").length,
      0,
    );
    if (marked === 0) return;
    // The count in the prompt is the catalog-wide one this actually
    // resets — saying "12" while the scoped counters above read "2"
    // would be the lie. The scope note spells that out.
    const ok = await confirmDialog({
      title: "Reset all marks?",
      message:
        `Reset ${marked} marked test${marked === 1 ? "" : "s"} back to untested? ` +
        `Cached step instructions will be cleared too. The spec itself isn't touched.` +
        (scopeActive
          ? ` This covers the whole catalog, not just “${app.scopeLabel}”.`
          : ""),
      confirmLabel: "Reset marks",
      danger: true,
    });
    if (!ok) return;
    app.clearTestPilotMarks();
  }
  async function onFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // reset so the same file can be re-picked
    if (!file) return;
    const text = await file.text();
    await app.importTestDoc(file.name, text);
    // A results file for a DIFFERENT catalog — or an unmarked sheet
    // that would replace a catalog which already has Pass/Fail marks —
    // parks itself in pendingImportConflict. Surface the shared confirm
    // modal instead of silently replacing what's loaded.
    if (app.testPilot.pendingImportConflict) {
      const ok = await confirmDialog({
        title: "Replace test catalog?",
        message:
          "Importing this file will replace the loaded test catalog and its Pass/Fail marks (it's either an unmarked sheet, or results for a different catalog). Replace what's loaded?",
        confirmLabel: "Replace catalog",
        danger: true,
      });
      app.resolveImportConflict(ok);
    }
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

  /** Chain a job onto the cross-section bulk queue so only one loop is
   *  firing agent requests at a time. Shared by the section-level Ask
   *  and the tester-sheet prep. */
  function enqueueBulk(job: () => Promise<void>): Promise<void> {
    const prev = bulkQueue;
    bulkQueue = (async () => {
      try {
        await prev;
      } catch {
        // Defensive — `prev` shouldn't reject (each job's try/finally
        // swallows everything), but if it ever does, don't take this
        // job down with it.
      }
      await job();
    })();
    return bulkQueue;
  }

  /** The sheet composers' notion of "has steps" — a cached detail with
   *  zero steps still renders the "(no steps generated yet)" placeholder,
   *  so it must be asked again, not skipped. */
  function hasSteps(t: TestPilotTest): boolean {
    return !!t.detail && t.detail.steps.length > 0;
  }

  /** Fetch steps for every row in `tests` that has none, strictly one
   *  at a time. Stops early when the agent errors / times out (no sense
   *  piling more onto a wedged agent — the user can retry), when the
   *  catalog disappears (Clear catalog / companion switch), or when
   *  `shouldStop()` turns true (checked between rows, so an in-flight
   *  ask always lands rather than wasting the tokens it already cost). */
  async function fetchStepsSequentially(
    tests: TestPilotTest[],
    opts: {
      shouldStop?: () => boolean;
      /** Rows to pass over without asking (e.g. scoped out mid-run). */
      skip?: (test: TestPilotTest) => boolean;
      onAsk?: (test: TestPilotTest) => void;
      onRow?: (test: TestPilotTest) => void;
    } = {},
  ): Promise<void> {
    for (const test of tests) {
      if (opts.shouldStop?.()) break;
      if (!app.testPilot.catalog) break;
      if (hasSteps(test) || opts.skip?.(test)) {
        // Answered elsewhere (per-row Ask / section Ask) while we were
        // queued, or no longer wanted — still counts toward progress.
        opts.onRow?.(test);
        continue;
      }
      // If another caller has it in flight already (per-row Ask),
      // just wait for that one to clear before moving on.
      if (!app.testPilot.pendingDetails[test.id]) {
        void app.fetchDetailSteps(test.id);
      }
      opts.onAsk?.(test);
      // Poll until this row's pending entry clears (success, error,
      // or timeout — handleDetailSync / armDetailTimeout / cancel
      // all delete the entry). 50ms keeps cumulative idle wait
      // under ~25ms/row average; a promise registry on state.svelte
      // would be tidier but for now the cost of the tight poll is
      // a single reactive object read every frame, which is free.
      while (app.testPilot.pendingDetails[test.id]) {
        await new Promise((r) => setTimeout(r, 50));
      }
      opts.onRow?.(test);
      // The next queued job still gets a chance after an error: its
      // first `fetchDetailSteps` call clears `error` in state.svelte.ts.
      if (app.testPilot.error) break;
    }
  }

  async function askAllInSection(section: TestPilotSection) {
    if (bulkFetchingSections[section.title]) return; // already running/queued
    bulkFetchingSections[section.title] = true;
    // Auto-expand so the per-row spinners are actually visible while
    // the queue chews through the section.
    collapsedSections[section.title] = false;
    // Chain onto the global queue — guarantees only one section's loop
    // is actively firing requests at a time. The spinner shown while
    // we wait for our turn is "queued, your turn is coming."
    await enqueueBulk(async () => {
      try {
        await fetchStepsSequentially(section.tests);
      } finally {
        delete bulkFetchingSections[section.title];
      }
    });
  }

  // ── Tester-sheet prep — auto-generate missing steps ────────────────

  /** Rows in the export scope with no generated steps yet, with the
   *  section each one lives in (for the section-level spinner). */
  function rowsWithoutSteps(): { test: TestPilotTest; section: string }[] {
    const c = app.scopedCatalogView();
    if (!c) return [];
    const out: { test: TestPilotTest; section: string }[] = [];
    for (const s of c.sections) {
      for (const t of s.tests) if (!hasSteps(t)) out.push({ test: t, section: s.title });
    }
    return out;
  }

  function nTests(n: number): string {
    return `${n} test${n === 1 ? "" : "s"}`;
  }

  /** For the popover's "Generate missing steps first" hint. */
  const steplessCount = $derived(rowsWithoutSteps().length);

  /** A tester sheet without steps is just a list of titles, so every
   *  tester-sheet export (.md / .docx / email) runs this first: generate
   *  steps for every scoped row that lacks them — one agent call at a
   *  time on the same queue as the section-level Ask — with progress in
   *  the export popover and the usual per-row / per-section spinners.
   *  Resolves true when the sheet is complete. Resolves false, leaving a
   *  note with a "download anyway" escape hatch, when there is no
   *  companion to ask, the user cancelled, or the agent errored and
   *  rows are still empty. */
  async function ensureStepsForTesterSheet(target: TesterSheetTarget): Promise<boolean> {
    if (stepPrep) return false; // a prep is already running
    stepPrepNote = null;
    // "Generate missing steps first" unticked — export the sheet as it
    // stands (rows without steps keep their placeholder).
    if (!app.testerInfo.generateSteps) return true;
    const missing = rowsWithoutSteps();
    if (missing.length === 0) return true;
    stepPrepTarget = target;
    if (app.connectionStatus !== "connected") {
      stepPrepNote = `${nTests(missing.length)} ${missing.length === 1 ? "has" : "have"} no steps yet and there is no companion to generate them. Start pinta-companion + /pinta, then`;
      return false;
    }
    stepPrep = { done: 0, total: missing.length, cancel: false, inFlight: null };
    // Light the section-level spinner on every section we'll touch that
    // a queued Ask-all isn't already lighting (that job owns its flag),
    // so progress shows on collapsed sections too; clear each of ours
    // as its last empty row lands.
    const mine = [...new Set(missing.map((m) => m.section))].filter((s) => !bulkFetchingSections[s]);
    for (const s of mine) bulkFetchingSections[s] = true;
    let cancelled = false;
    try {
      await enqueueBulk(() =>
        fetchStepsSequentially(
          missing.map((m) => m.test),
          {
            shouldStop: () => stepPrep?.cancel ?? true,
            // Scope narrowed mid-prep — don't spend tokens on rows the
            // sheet will no longer carry.
            skip: (t) => app.scopedTestIds?.has(t.id) === false,
            onAsk: (t) => {
              if (stepPrep) stepPrep.inFlight = t.id;
            },
            onRow: (t) => {
              if (stepPrep) {
                stepPrep.done++;
                stepPrep.inFlight = null;
              }
              const section = missing.find((m) => m.test.id === t.id)?.section;
              if (
                section &&
                mine.includes(section) &&
                !missing.some((m) => m.section === section && !hasSteps(m.test))
              ) {
                delete bulkFetchingSections[section];
              }
            },
          },
        ),
      );
    } finally {
      for (const s of mine) delete bulkFetchingSections[s];
      cancelled = stepPrep?.cancel ?? false;
      stepPrep = null;
    }
    // Catalog gone mid-prep (Clear catalog / companion switch): there is
    // no sheet to write and the empty-state view already says so.
    if (!app.scopedCatalogView()) return false;
    const left = rowsWithoutSteps().length;
    if (left === 0) return true;
    const still = `${nTests(left)} still ${left === 1 ? "has" : "have"} no steps`;
    stepPrepNote = cancelled
      ? `Stopped — ${still}.`
      : app.testPilot.error
        ? `${still} (the agent errored or timed out).`
        : `${still}.`;
    return false;
  }

  /** Stop after the in-flight row — its result still lands (the tokens
   *  are already spent). */
  function cancelStepPrep() {
    if (stepPrep) stepPrep.cancel = true;
  }

  /** Wedged-agent escape: also drop the in-flight ask so the popover
   *  unlocks now instead of after the 120 s + grace give-up. A late
   *  reply for that row is ignored (its pending slot is gone). */
  function stopStepPrepNow() {
    if (!stepPrep) return;
    stepPrep.cancel = true;
    if (stepPrep.inFlight) app.cancelDetailFetch(stepPrep.inFlight);
  }

  /** Re-run the export that asked for the prep. `force` skips the prep
   *  ("download anyway" — empty rows keep the "(no steps generated
   *  yet)" placeholder in the sheet); without it, "Retry" asks again
   *  for whatever is still missing. */
  function rerunTesterSheetExport(force: boolean) {
    const target = stepPrepTarget;
    stepPrepNote = null;
    if (target === "md") void downloadTesterSheetMdPrepared({ force });
    else if (target === "docx") void downloadTesterSheetDocx({ force });
    else if (target) void emailTesterSheet(target, { force });
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
    chatTestId = null;
    if (!test.detail) {
      void app.fetchDetailSteps(test.id);
    }
  }

  function closeDetail() {
    viewing = null;
    copiedBlock = null;
    chatOpen = false;
    chatDraft = "";
    chatTestId = null;
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
    // Counters follow the active scope — "12 of 12 run" has to mean the
    // slice the tester is actually working on, not the whole catalog.
    const scoped = app.scopedTestIds;
    let pass = 0,
      fail = 0,
      untested = 0;
    for (const s of catalog.sections) {
      for (const t of s.tests) {
        if (scoped && !scoped.has(t.id)) continue;
        if (t.status === "pass") pass++;
        else if (t.status === "fail") fail++;
        else untested++;
      }
    }
    return { pass, fail, untested, total: pass + fail + untested };
  }

  /** True when `test` matches the active search query. A query is matched
   *  against the test id, the test title, the expected-result text, and
   *  the owning section title — so searching "AUTH" surfaces the whole
   *  Authentication category, "AUTH-1" jumps to one row, and free text
   *  ("login") matches on content. Case-insensitive substring match. */
  function matchesQuery(test: TestPilotTest, sectionTitle: string): boolean {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    if (sectionTitle.toLowerCase().includes(q)) return true;
    return (
      test.id.toLowerCase().includes(q) ||
      (test.test ?? "").toLowerCase().includes(q) ||
      (test.expected ?? "").toLowerCase().includes(q)
    );
  }

  /** Tests within a section that survive the active query. When the
   *  section title itself matches, every row is kept (the whole category
   *  is a hit); otherwise only content/id matches remain. */
  function visibleTests(section: TestPilotSection): TestPilotTest[] {
    // Scope first, then search — the two compose (AND), and scope is the
    // same chokepoint the search box already flows through.
    const scoped = app.scopedTestIds;
    const rows = scoped
      ? section.tests.filter((t) => scoped.has(t.id))
      : section.tests;
    const q = searchQuery.trim();
    if (!q) return rows;
    if (section.title.toLowerCase().includes(q.toLowerCase())) {
      return rows;
    }
    return rows.filter((t) => matchesQuery(t, section.title));
  }

  /** A section is shown when nothing is filtering, or it has ≥1 visible row. */
  function sectionVisible(section: TestPilotSection): boolean {
    if (!searchActive && !scopeActive) return true;
    return visibleTests(section).length > 0;
  }

  /** Count of rows matching the active query, across all sections —
   *  drives the "N matches" caption under the search box. */
  function matchCount(): number {
    const catalog = app.testPilot.catalog;
    if (!catalog) return 0;
    let n = 0;
    for (const s of catalog.sections) n += visibleTests(s).length;
    return n;
  }

  /** Shared filename stem for any export — strips a trailing `.md` so
   *  re-export doesn't pile up `…-results-results-2026-05-24.md`. */
  function exportStem(): string {
    return (app.testPilot.catalog?.filename ?? "test-spec").replace(/\.md$/i, "");
  }

  /** Trigger a browser download for a Blob, then revoke the object URL.
   *  Shared by all four export variants below. */
  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    // Marker for the outside-click handler: the synthetic click below
    // lands outside the Export popover and used to close it, hiding the
    // email flow's "attach it to the draft" confirmation.
    a.setAttribute("data-pinta-download", "");
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** Wrap a DOCX byte array in a Blob and download it. Slices into a
   *  fresh ArrayBuffer because some browsers refuse Blob construction
   *  from a SharedArrayBuffer-backed Uint8Array; the copy is cheap
   *  relative to the OOXML zip's typical size. Shared by both DOCX
   *  exports below. */
  function downloadDocx(bytes: Uint8Array | null, filename: string): void {
    if (!bytes) return;
    const buf = bytes.slice().buffer;
    downloadBlob(
      new Blob([buf], {
        type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      filename,
    );
    exportMenuOpen = false;
  }

  function downloadResultsMd(signoff?: TestPilotSignoff) {
    const md = app.exportResults(signoff);
    const ts = new Date().toISOString().slice(0, 10);
    downloadBlob(
      new Blob([md], { type: "text/markdown" }),
      `${exportStem()}-results-${ts}.md`,
    );
    exportMenuOpen = false;
  }

  async function downloadResultsDocx(signoff?: TestPilotSignoff) {
    const ts = new Date().toISOString().slice(0, 10);
    try {
      downloadDocx(await app.exportResultsDocx(signoff), `${exportStem()}-results-${ts}.docx`);
    } catch (err) {
      app.testPilot.error = `Word export failed: ${(err as Error).message}`;
      exportMenuOpen = false;
    }
  }

  // ── Sign-off form (results export) ────────────────────────────────
  // Compact inline form that opens when either Results format is
  // clicked. Tester name/email/environment persist in
  // chrome.storage["pinta-tester-info"]; date + notes are per-run.
  let signoffOpen = $state<null | "md" | "docx">(null);
  let signoffDate = $state("");
  let signoffNotes = $state("");
  let signoffRunType = $state("Smoke");

  async function openSignoff(fmt: "md" | "docx") {
    exportMenuOpen = false;
    await app.loadTesterInfo();
    signoffDate = new Date().toISOString().slice(0, 10);
    signoffNotes = "";
    // Default the run type from the catalog's generation depth — a
    // thorough catalog is usually being run thoroughly. Tester can
    // still flip it (e.g. a quick smoke over a thorough catalog).
    signoffRunType = thoroughOn ? "Thorough" : "Smoke";
    signoffOpen = fmt;
  }

  async function exportResultsWithSignoff(signed: boolean) {
    const fmt = signoffOpen;
    if (!fmt) return;
    let signoff: TestPilotSignoff | undefined;
    if (signed) {
      app.saveTesterInfo();
      signoff = {
        tester: app.testerInfo.name.trim(),
        email: app.testerInfo.email.trim() || undefined,
        date: signoffDate,
        environment: app.testerInfo.environment,
        runType: signoffRunType || undefined,
        notes: signoffNotes.trim() || undefined,
      };
    }
    signoffOpen = null;
    if (fmt === "md") downloadResultsMd(signoff);
    else await downloadResultsDocx(signoff);
  }

  /** "Email to tester" — mail clients can't take attachments from a
   *  link, so this downloads the tester sheet and opens a prefilled
   *  draft for the developer to drop the file into.
   *  `via: "gmail"` opens Gmail's web compose (no OS mail handler needed —
   *  a bare `mailto:` on a Chrome-only machine just offers Chrome);
   *  `via: "mailto"` falls back to whatever mail app the OS registered. */
  async function emailTesterSheet(via: MailVia = "gmail", opts: { force?: boolean } = {}) {
    if (!emailReady || emailBusy || stepPrep) return;
    emailBusy = true;
    emailedNote = null;
    lastMailDraft = null;
    try {
      // Generate any missing steps first — a sheet of bare titles is
      // no use to the tester. `force` is the "send anyway" path.
      if (!opts.force && !(await ensureStepsForTesterSheet(via))) return;
      if (!app.scopedCatalogView()) return; // cleared while we waited
      await app.loadTesterInfo();
      const filename = downloadTesterSheetMd({ keepOpen: true });
      const subject = `[Pinta tester sheet] ${exportStem()}`;
      const body =
        "Hi,\n\nAttached is the Pinta tester sheet (.md — it just downloaded on my side, dragging it in now).\n\n" +
        "To run it: open the Pinta side panel → Test Pilot → Import tester sheet (no companion needed), walk through the tests and mark Pass/Fail.\n\n" +
        "When you're done, send ONE file back:\n" +
        "- If you annotated any bugs on the page, use Share session as .pinta with Contents set to \"Annotations + test results\" — that single .pinta bundle carries your annotations AND your Pass/Fail marks + sign-off.\n" +
        "- If you didn't annotate anything, just use Export → Results (.md) with sign-off instead.\n\nThanks!";
      // Tab-API opener: by now the click is long gone (the prep above
      // can take minutes), so a plain window.open would be popup-blocked.
      const draft: MailDraft = { to: app.testerInfo.recipient, subject, body };
      const opened = await openMailDraftTab(draft, via);
      if (!opened) {
        app.testPilot.error =
          "Chrome blocked the draft tab. Allow pop-ups for the side panel, or use your default mail app.";
      } else if (via === "mailto") {
        // A mailto: hand-off is unverifiable — Windows silently does
        // nothing when no mail app is registered, so don't assert a draft.
        emailedNote = `${filename} downloaded — attach it if your mail app opened a draft.`;
        lastMailDraft = { draft, via };
      } else {
        emailedNote = `${filename} downloaded — attach it to the draft that just opened.`;
      }
    } catch (err) {
      app.testPilot.error = `Email draft failed: ${(err as Error).message}`;
    } finally {
      emailBusy = false;
    }
  }

  /** Tester sheet (.md) button — generates missing steps first, then
   *  hands off to the synchronous writer below. `force` skips the prep
   *  ("download anyway"). */
  async function downloadTesterSheetMdPrepared(opts: { force?: boolean } = {}) {
    if (stepPrep) return;
    if (!opts.force && !(await ensureStepsForTesterSheet("md"))) return;
    if (!app.scopedCatalogView()) return; // cleared while we waited
    downloadTesterSheetMd();
  }

  /** Writes the sheet as it stands — callers run the step prep first.
   *  Returns the filename so the email flow can name the attachment.
   *  `keepOpen` leaves the popover up — the email flow still has its
   *  confirmation line to show there. */
  function downloadTesterSheetMd(opts: { keepOpen?: boolean } = {}): string {
    const md = app.exportTesterSheetMarkdown();
    const ts = new Date().toISOString().slice(0, 10);
    const filename = `${exportStem()}-tester-${ts}.md`;
    downloadBlob(new Blob([md], { type: "text/markdown" }), filename);
    if (!opts.keepOpen) exportMenuOpen = false;
    return filename;
  }

  async function downloadTesterSheetDocx(opts: { force?: boolean } = {}) {
    if (stepPrep) return;
    if (!opts.force && !(await ensureStepsForTesterSheet("docx"))) return;
    if (!app.scopedCatalogView()) return; // cleared while we waited
    const ts = new Date().toISOString().slice(0, 10);
    try {
      downloadDocx(await app.exportTesterSheetDocx(), `${exportStem()}-tester-${ts}.docx`);
    } catch (err) {
      app.testPilot.error = `Word export failed: ${(err as Error).message}`;
      exportMenuOpen = false;
    }
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

  /** Test row currently bound to the chat sheet (independent of DETAIL). */
  function findChatTest(): TestPilotTest | null {
    return chatTestId ? findTestById(chatTestId) : null;
  }

  function findChatSectionTitle(): string {
    if (!chatTestId) return "";
    const catalog = app.testPilot.catalog;
    if (!catalog) return "";
    for (const section of catalog.sections) {
      if (section.tests.some((t) => t.id === chatTestId)) {
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
    <div class="rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-3 text-[12px] text-red-700 dark:text-red-300 leading-snug flex items-start gap-2">
      <span class="flex-1 min-w-0">{app.testPilot.error}</span>
      <button
        type="button"
        class="shrink-0 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200 leading-none px-1"
        onclick={() => (app.testPilot.error = null)}
        aria-label="Dismiss error"
        title="Dismiss"
      >
        ✕
      </button>
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
  <!-- STANDALONE empty state — testers without a companion can still
       import a developer-shipped tester sheet (.md) and walk through
       it offline. Pass/Fail starts blank for them to fill in; results
       export back to .md for the developer to re-import. -->
  <section class="space-y-3 p-3">
    <div class="flex items-center gap-2">
      <span class="text-base">🛫</span>
      <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">Test Pilot</h2>
    </div>
    <p class="text-[12px] text-ink-700 dark:text-night-dim leading-snug">
      Got a tester sheet from the developer? Import it and start walking through the tests. Pass/Fail marks save locally; export your results back as markdown when you're done — or, if you also annotate bugs on the page, share one <code class="font-mono text-[10px] bg-ink-100 dark:bg-night-alt px-1 rounded">.pinta</code> bundle with Contents set to “Annotations + test results” so your annotations and marks travel together.
    </p>
    <button
      type="button"
      class="w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-pink text-white text-sm font-medium px-3 py-2.5 hover:bg-brand-magenta dark:hover:bg-brand-pink-light"
      onclick={onPickFile}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      Import tester sheet
    </button>
    <div class="rounded-md border border-ink-200 dark:border-night-line bg-ink-50 dark:bg-night-alt p-3 text-[11px] text-ink-700 dark:text-night-dim leading-snug space-y-1.5">
      <p>Need to generate a new catalog instead? Ask the developer for their project's <code class="font-mono text-[10px] bg-ink-100 dark:bg-night-alt px-1 rounded">pinta-companion</code> command and connect above.</p>
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
    <!-- Depth — Smoke (quick happy paths) vs Thorough (every feature,
         edge + negative cases). Persists as the thorough_tests setting. -->
    <div class="rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-2.5 space-y-1.5">
      <div class="flex rounded-full bg-ink-100 dark:bg-night-alt p-0.5">
        <button
          type="button"
          class="flex-1 py-1 rounded-full text-[11.5px] font-medium transition-colors"
          class:bg-white={!thoroughOn}
          class:dark:bg-night-card={!thoroughOn}
          class:text-brand-pink={!thoroughOn}
          class:dark:text-brand-pink-light={!thoroughOn}
          class:shadow-sm={!thoroughOn}
          class:ring-1={!thoroughOn}
          class:ring-brand-pink={!thoroughOn}
          class:text-ink-500={thoroughOn}
          class:dark:text-night-mute={thoroughOn}
          aria-pressed={!thoroughOn}
          onclick={() => setThorough(false)}
        >
          Smoke test
        </button>
        <button
          type="button"
          class="flex-1 py-1 rounded-full text-[11.5px] font-medium transition-colors"
          class:bg-white={thoroughOn}
          class:dark:bg-night-card={thoroughOn}
          class:text-brand-pink={thoroughOn}
          class:dark:text-brand-pink-light={thoroughOn}
          class:shadow-sm={thoroughOn}
          class:ring-1={thoroughOn}
          class:ring-brand-pink={thoroughOn}
          class:text-ink-500={!thoroughOn}
          class:dark:text-night-mute={!thoroughOn}
          aria-pressed={thoroughOn}
          onclick={() => setThorough(true)}
        >
          Thorough test
        </button>
      </div>
      <p class="text-[10.5px] text-ink-500 dark:text-night-mute leading-snug">
        {thoroughOn
          ? "Thorough: exhaustive coverage — every feature, edge cases, negative paths. Slower, more tokens."
          : "Smoke: a quick happy-path catalog of the core flows. Fast and cheap."}
      </p>
    </div>
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
      Tip: export Results or the Tester sheet as <code>.docx</code> to open straight in Word — or run the <code>.md</code> through <code>pandoc results.md -o results.pdf</code> for a PDF.
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
      <div
        class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-4 space-y-3"
        class:pinta-loading-card={app.testPilot.pendingDetails[test.id]}
      >
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
        <div class="rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[12px] text-red-700 dark:text-red-300 leading-snug flex items-start gap-2">
          <span class="flex-1 min-w-0">{app.testPilot.error}</span>
          <button
            type="button"
            class="shrink-0 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200 leading-none px-1"
            onclick={() => (app.testPilot.error = null)}
            aria-label="Dismiss error"
            title="Dismiss"
          >
            ✕
          </button>
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
                        {:else if part.kind === "bold"}
                          <strong class="font-semibold text-ink-900 dark:text-night-text">{part.value}</strong>
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
                        {:else if part.kind === "bold"}
                          <strong class="font-semibold text-ink-800 dark:text-night-text">{part.value}</strong>
                        {:else}
                          <span>{part.value}</span>
                        {/if}
                      {/each}
                    </div>
                  {:else if block.kind === "list"}
                    <svelte:element
                      this={block.ordered ? "ol" : "ul"}
                      class="text-[12.5px] text-ink-800 dark:text-night-text pl-5 space-y-1.5 leading-relaxed {block.ordered ? 'list-decimal' : 'list-disc'} marker:text-ink-400 dark:marker:text-night-mute"
                    >
                      {#each block.items as item, ii (ii)}
                        <li>
                          {#each item as part, pi (pi)}
                            {#if part.kind === "code"}
                              <code class="font-mono text-[11px] bg-ink-100 dark:bg-night-alt text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                            {:else if part.kind === "bold"}
                              <strong class="font-semibold text-ink-900 dark:text-night-text">{part.value}</strong>
                            {:else}
                              <span>{part.value}</span>
                            {/if}
                          {/each}
                        </li>
                      {/each}
                    </svelte:element>
                  {:else if block.kind === "heading"}
                    <!-- ATX heading rendered as a bold sized title.
                         Matches the chat sheet's heading treatment so
                         agent replies with `### Section` style look
                         the same in detail-steps as they do in chat. -->
                    <svelte:element
                      this={`h${Math.min(block.level + 2, 6)}`}
                      class="font-bold text-ink-900 dark:text-night-text mt-1 leading-tight {block.level === 1 ? 'text-[14px]' : block.level === 2 ? 'text-[13.5px]' : 'text-[13px]'}"
                    >
                      {#each block.parts as part, pi (pi)}
                        {#if part.kind === "code"}
                          <code class="font-mono text-[11px] bg-ink-100 dark:bg-night-alt text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                        {:else if part.kind === "bold"}
                          <strong class="font-bold">{part.value}</strong>
                        {:else}
                          <span>{part.value}</span>
                        {/if}
                      {/each}
                    </svelte:element>
                  {:else if block.kind === "table"}
                    <!-- Pipe-table → proper HTML table. Same shape as
                         the chat sheet's table renderer. Horizontal
                         scroll keeps wide tables (token comparisons,
                         etc.) from blowing out the detail-step width. -->
                    <div class="rounded-md overflow-x-auto border border-ink-200 dark:border-night-line bg-white dark:bg-night-card/60 max-w-full">
                      <table class="text-[11.5px] leading-snug w-full">
                        <thead class="bg-ink-50 dark:bg-night-bg/60 border-b border-ink-200 dark:border-night-line">
                          <tr>
                            {#each block.headers as cell, ci (ci)}
                              <th class="text-left font-semibold text-ink-700 dark:text-night-text px-2.5 py-1.5 whitespace-nowrap">
                                {#each cell as part, pi (pi)}
                                  {#if part.kind === "code"}
                                    <code class="font-mono text-[11px] bg-ink-100 dark:bg-night-alt text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                                  {:else if part.kind === "bold"}
                                    <strong class="font-bold">{part.value}</strong>
                                  {:else}
                                    <span>{part.value}</span>
                                  {/if}
                                {/each}
                              </th>
                            {/each}
                          </tr>
                        </thead>
                        <tbody>
                          {#each block.rows as row, ri (ri)}
                            <tr class="border-t border-ink-100 dark:border-night-line/60">
                              {#each row as cell, ci (ci)}
                                <td class="px-2.5 py-1.5 text-ink-800 dark:text-night-text align-top">
                                  {#each cell as part, pi (pi)}
                                    {#if part.kind === "code"}
                                      <code class="font-mono text-[11px] bg-ink-100 dark:bg-night-alt text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                                    {:else if part.kind === "bold"}
                                      <strong class="font-semibold">{part.value}</strong>
                                    {:else}
                                      <span>{part.value}</span>
                                    {/if}
                                  {/each}
                                </td>
                              {/each}
                            </tr>
                          {/each}
                        </tbody>
                      </table>
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
          class="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white text-[13px] font-semibold py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
          onclick={() => setStatusAndClose("pass")}
          disabled={app.testPilot.pending !== null || readOnlyRun}
          title={readOnlyRun ? READ_ONLY_TITLE : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Pass
        </button>
        <button
          type="button"
          class="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-ink-300 dark:border-night-line bg-transparent text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt text-[13px] font-semibold py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
          onclick={() => setStatusAndClose("fail")}
          disabled={app.testPilot.pending !== null || readOnlyRun}
          title={readOnlyRun ? READ_ONLY_TITLE : undefined}
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
      onclick={() => { chatTestId = viewing!.testId; chatOpen = true; }}
      title={chatCount > 0
        ? `Resume chat (${chatCount} message${chatCount === 1 ? "" : "s"})`
        : "Ask the agent about this test"}
      aria-label="Open chat with agent"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
        <path d="M8 12h.01" />
        <path d="M12 12h.01" />
        <path d="M16 12h.01" />
      </svg>
      {#if chatCount > 0}
        <span class="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-white text-brand-pink text-[10px] font-bold inline-flex items-center justify-center border border-brand-pink leading-none">
          {chatCount}
        </span>
      {/if}
    </button>
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
      <!-- Action buttons — compact icon-only segmented group. Inline with
           title on wide panels, wraps to next row on narrow viewports
           thanks to flex-wrap on the parent. Labels live in title +
           aria-label since the row is icon-only. -->
      <div class="inline-flex items-center shrink-0 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card divide-x divide-ink-200 dark:divide-night-line">
        <button
          type="button"
          class="inline-flex items-center justify-center w-8 h-8 rounded-l-md text-ink-700 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light hover:bg-ink-50 dark:hover:bg-night-alt"
          onclick={onPickFile}
          title="Re-import — replace catalog with a new doc"
          aria-label="Re-import catalog"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
        </button>
        <button
          type="button"
          class="inline-flex items-center justify-center w-8 h-8 text-ink-700 dark:text-night-dim hover:text-red-600 dark:hover:text-red-400 hover:bg-ink-50 dark:hover:bg-night-alt disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-700 dark:disabled:hover:text-night-dim"
          onclick={() => void clearMarks()}
          disabled={!app.testPilotHasMarks || readOnlyRun}
          title={readOnlyRun
            ? READ_ONLY_TITLE
            : !app.testPilotHasMarks
              ? "Clear marks — nothing to clear, no rows are marked yet"
              : "Clear marks — reset every Pass/Fail mark in the catalog back to untested (keeps the catalog)"}
          aria-label="Clear all Pass/Fail marks"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
        <button
          type="button"
          class="inline-flex items-center justify-center w-8 h-8 text-ink-700 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light hover:bg-ink-50 dark:hover:bg-night-alt disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-700 dark:disabled:hover:text-night-dim"
          onclick={openFileIssuesSheet}
          disabled={app.appMode === "standalone" || failedUnfiled.length === 0 || app.testPilot.pendingFileIssues}
          title={app.appMode === "standalone"
            ? "File failed tests — needs a connected companion (export your results and send them to the developer instead)"
            : failedUnfiled.length === 0
              ? scopeActive
                ? `File failed tests — nothing unfiled in “${app.scopeLabel}”`
                : "File failed tests — no failures marked yet"
              : gitlabReady
                ? `File ${failedUnfiled.length} failed test${failedUnfiled.length === 1 ? "" : "s"} as GitLab issues (one per test, via glab)`
                : `File ${failedUnfiled.length} failed test${failedUnfiled.length === 1 ? "" : "s"} — GitLab Issues module is off, entries land in .pinta/tasks.md`}
          aria-label="File failed tests as issues"
        >
          {#if app.testPilot.pendingFileIssues}
            <svg class="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
          {:else}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
          {/if}
        </button>
        <div class="relative" data-pinta-export-menu>
          <button
            type="button"
            bind:this={exportBtnEl}
            class="inline-flex items-center justify-center gap-0.5 w-9 h-8 rounded-r-md text-ink-700 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light hover:bg-ink-50 dark:hover:bg-night-alt"
            onclick={(e) => {
              exportMenuAlignLeft = e.currentTarget.getBoundingClientRect().right < 288 + 8;
              exportMenuOpen = !exportMenuOpen;
              emailedNote = null;
              // Prefill the tester-email input (and later the sign-off
              // form) while the menu animates open.
              if (exportMenuOpen) void app.loadTesterInfo();
            }}
            title={stepPrep
              ? `Generating tester-sheet steps (${Math.min(stepPrep.done + 1, stepPrep.total)} of ${stepPrep.total})…`
              : "Export this catalog — Results or Tester sheet, as Markdown or Word (.docx)"}
            aria-haspopup="dialog"
            aria-expanded={exportMenuOpen}
            aria-label="Export catalog"
            onkeydown={(e) => {
              // Escape with focus still on the trigger — the popover's
              // own handler only sees keys once focus has moved inside.
              if (e.key !== "Escape" || !exportMenuOpen) return;
              e.stopPropagation();
              exportMenuOpen = false;
            }}
          >
            {#if stepPrep}
              <svg class="animate-spin text-brand-pink dark:text-brand-pink-light" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            {:else}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            {/if}
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          {#if exportMenuOpen}
            <!-- Export popover — one block per artifact (Results / Tester
                 sheet), each offering its format buttons (Markdown / Word).
                 Grid layout makes the full matrix obvious at a glance,
                 friendlier than a flat list as formats grow. -->
            {#snippet fmtBtn(label: string, hint: string, onClick: () => void, disabled: boolean = false)}
              <button
                type="button"
                class="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-2 py-1.5 text-[11.5px] font-semibold text-ink-700 dark:text-night-dim enabled:hover:border-brand-pink enabled:hover:text-brand-pink dark:enabled:hover:text-brand-pink-light enabled:hover:bg-brand-pink/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onclick={onClick}
                {disabled}
                title={hint}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                {label}
              </button>
            {/snippet}
            <div
              class="absolute {exportMenuAlignLeft ? 'left-0' : 'right-0'} top-full mt-1 z-40 w-72 max-w-[calc(100vw-1rem)] max-h-[70vh] overflow-y-auto rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card shadow-lg"
              role="dialog"
              aria-label="Export options"
              tabindex="-1"
              onkeydown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                exportMenuOpen = false;
                exportBtnEl?.focus();
              }}
            >
              <div class="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-ink-400 dark:text-night-mute">Export</div>

              <div class="px-3 py-2 border-b border-ink-100 dark:border-night-line">
                <div class="text-[12px] font-semibold text-ink-900 dark:text-night-text">Results</div>
                <div class="text-[10.5px] text-ink-500 dark:text-night-mute leading-snug mt-0.5 mb-2">Sign-off report with Pass/Fail marks + per-row chat threads.</div>
                <div class="flex items-center gap-1.5">
                  {@render fmtBtn(".md", "Results as Markdown — opens the sign-off form (re-importable by the developer)", () => void openSignoff("md"))}
                  {@render fmtBtn(".docx", "Results as Word — opens the sign-off form; opens directly in Word, no pandoc needed", () => void openSignoff("docx"))}
                </div>
              </div>

            <!-- Step-prep status — progress while the missing steps are
                 generated, or the outcome note + "download anyway" when
                 the prep couldn't complete. Rendered under whichever
                 block asked (Tester sheet vs Email). Amber = still
                 working / needs a decision, never red. -->
            {#snippet prepStatus(targets: TesterSheetTarget[])}
              <!-- The live region stays mounted (empty when idle) so
                   screen readers announce the text that lands in it. -->
              <div role="status" aria-live="polite">
                {#if stepPrep && stepPrepTarget && targets.includes(stepPrepTarget)}
                  <div class="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-ink-600 dark:text-night-dim leading-snug" data-pinta-step-prep>
                    <svg class="animate-spin shrink-0 text-brand-pink dark:text-brand-pink-light" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                    <span class="flex-1">
                      {stepPrep.cancel
                        ? "Stopping after the current test…"
                        : `Generating steps ${Math.min(stepPrep.done + 1, stepPrep.total)} of ${stepPrep.total}…`}
                    </span>
                    {#if !stepPrep.cancel}
                      <button
                        type="button"
                        class="shrink-0 underline underline-offset-2 hover:text-brand-pink dark:hover:text-brand-pink-light"
                        onclick={cancelStepPrep}
                        aria-label="Cancel step generation"
                      >Cancel</button>
                    {:else if stepPrep.inFlight}
                      <button
                        type="button"
                        class="shrink-0 underline underline-offset-2 hover:text-brand-pink dark:hover:text-brand-pink-light"
                        onclick={stopStepPrepNow}
                        title="Drop the in-flight ask too — use this if the agent isn't responding"
                        aria-label="Stop now, dropping the in-flight ask"
                      >Stop now</button>
                    {/if}
                  </div>
                  <div class="mt-1 h-1 rounded-full bg-ink-200 dark:bg-night-line overflow-hidden" aria-hidden="true">
                    <div class="h-full bg-brand-pink dark:bg-brand-pink-light transition-[width]" style="width:{Math.round((stepPrep.done / stepPrep.total) * 100)}%"></div>
                  </div>
                {:else if stepPrepNote && steplessCount > 0 && stepPrepTarget && targets.includes(stepPrepTarget)}
                  <div class="mt-1.5 text-[10.5px] text-amber-700 dark:text-amber-400 leading-snug" data-pinta-step-prep-note>
                    {stepPrepNote}
                    <button
                      type="button"
                      class="underline underline-offset-2 font-semibold hover:text-brand-pink dark:hover:text-brand-pink-light"
                      onclick={() => rerunTesterSheetExport(false)}
                    >Retry</button>
                    or
                    <button
                      type="button"
                      class="underline underline-offset-2 font-semibold hover:text-brand-pink dark:hover:text-brand-pink-light"
                      onclick={() => rerunTesterSheetExport(true)}
                    >{stepPrepTarget === "md" || stepPrepTarget === "docx" ? "download anyway" : "send anyway"}</button>.
                  </div>
                {/if}
              </div>
            {/snippet}

              <div class="px-3 py-2">
                <div class="text-[12px] font-semibold text-ink-900 dark:text-night-text">Tester sheet</div>
                <div class="text-[10.5px] text-ink-500 dark:text-night-mute leading-snug mt-0.5 mb-1.5">Steps per row, Result left blank for the tester. Re-importable in standalone mode.</div>
                <!-- Applies to .md, .docx and Email below. Remembered with
                     the other tester-sheet prefs (pinta-tester-info). -->
                <label class="mb-2 flex items-start gap-1.5 text-[11px] text-ink-800 dark:text-night-text cursor-pointer" title="Ask the agent for steps on every test that has none before the sheet downloads or is emailed. Untick to export the sheet as it stands.">
                  <input
                    type="checkbox"
                    class="mt-0.5 w-3.5 h-3.5 rounded border-ink-300 dark:border-night-line text-brand-pink focus:ring-1 focus:ring-brand-pink/40 cursor-pointer disabled:cursor-not-allowed"
                    bind:checked={app.testerInfo.generateSteps}
                    onchange={() => app.saveTesterInfo()}
                    disabled={!!stepPrep}
                    data-pinta-generate-steps
                  />
                  <span>
                    Generate missing steps first
                    <span class="text-ink-500 dark:text-night-mute">
                      {steplessCount === 0 ? "— every test has steps" : `— ${nTests(steplessCount)} ${steplessCount === 1 ? "has" : "have"} none`}
                    </span>
                  </span>
                </label>
                <div class="flex items-center gap-1.5">
                  {@render fmtBtn(".md", app.testerInfo.generateSteps ? "Tester sheet as Markdown — generates any missing steps first" : "Tester sheet as Markdown, as it stands", () => void downloadTesterSheetMdPrepared(), !!stepPrep)}
                  {@render fmtBtn(".docx", app.testerInfo.generateSteps ? "Tester sheet as Word — generates any missing steps first; opens directly in Word, no pandoc needed" : "Tester sheet as Word, as it stands — opens directly in Word, no pandoc needed", () => void downloadTesterSheetDocx(), !!stepPrep)}
                </div>
                {@render prepStatus(["md", "docx"])}
              </div>

              <div class="px-3 py-2 border-t border-ink-100 dark:border-night-line">
                <div class="text-[12px] font-semibold text-ink-900 dark:text-night-text">Email</div>
                <div class="text-[10.5px] text-ink-500 dark:text-night-mute leading-snug mt-0.5 mb-2">Downloads the tester sheet (.md){app.testerInfo.generateSteps ? ", generating any missing steps first," : ""} and opens a prefilled draft — attach the file and send.</div>
                <input
                  type="email"
                  class="w-full px-2 py-1 text-[11px] rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute outline-none focus:border-brand-pink dark:focus:border-brand-pink-light"
                  placeholder="tester@example.com"
                  bind:value={app.testerInfo.recipient}
                  onchange={() => app.saveTesterInfo()}
                  onkeydown={(e) => {
                    if (e.key === "Enter" && emailReady && !stepPrep) void emailTesterSheet("gmail");
                  }}
                  aria-label="Tester email address"
                />
                <!-- Inline, not tooltip-only — a disabled button leaves the
                     tab order, so the reason has to be readable on the page. -->
                {#if !emailReady}
                  <div class="mt-1 text-[10.5px] text-ink-500 dark:text-night-mute">
                    {app.testerInfo.recipient.trim() ? "That doesn't look like an email address." : "Enter your tester's email to send."}
                  </div>
                {:else if stepPrep && stepPrepTarget !== "gmail" && stepPrepTarget !== "mailto"}
                  <div class="mt-1 text-[10.5px] text-ink-500 dark:text-night-mute">
                    Waiting for the tester-sheet steps to finish generating…
                  </div>
                {/if}
                {#if emailedNote}
                  <div class="mt-1 text-[10.5px] text-emerald-600 dark:text-emerald-400 leading-snug">
                    {emailedNote}
                    {#if lastMailDraft}
                      {@const again = lastMailDraft}
                      <button
                        type="button"
                        class="underline underline-offset-2 font-semibold hover:text-brand-pink dark:hover:text-brand-pink-light"
                        onclick={() => void openMailDraftTab(again.draft, again.via)}
                        title="Open the same draft again from a fresh click (in case the first one was blocked)"
                      >Open the draft again</button>
                    {/if}
                  </div>
                {/if}
                {@render prepStatus(["gmail", "mailto"])}
                <button
                  type="button"
                  class="mt-1.5 w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-pink px-2 py-1.5 text-[11.5px] font-semibold text-white hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-brand-pink transition-colors"
                  onclick={() => void emailTesterSheet("gmail")}
                  disabled={!emailReady || emailBusy || !!stepPrep}
                  title={app.testerInfo.generateSteps ? "Generates any missing steps, downloads the .md and opens a prefilled Gmail draft — attach the downloaded file and send" : "Downloads the .md as it stands and opens a prefilled Gmail draft — attach the downloaded file and send"}
                >
                  {#if emailBusy}
                    <svg class="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  {:else}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,6 12,13 2,6"/></svg>
                  {/if}
                  Open Gmail draft
                </button>
                <button
                  type="button"
                  class="mt-1 w-full text-[11px] text-ink-600 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light underline underline-offset-2 disabled:opacity-60 disabled:cursor-not-allowed disabled:no-underline disabled:hover:text-ink-600 dark:disabled:hover:text-night-dim transition-colors"
                  onclick={() => void emailTesterSheet("mailto")}
                  disabled={!emailReady || emailBusy || !!stepPrep}
                  title="Open the draft in your default mail app instead (Outlook, Mail, Thunderbird…)"
                >
                  or use my default mail app
                </button>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- SIGN-OFF form (inline, per locked spec — no overlay). Opens when
         either Results export format is clicked. Name/email/environment
         prefill from pinta-tester-info; date + notes are per-run. -->
    {#if signoffOpen}
      <div class="rounded-md border border-brand-pink/40 dark:border-brand-pink-light/40 bg-brand-pink/5 p-2.5 space-y-2">
        {#if readOnlyRun}
          <!-- Imported run active — the marks on screen are the tester's,
               so offering the developer a sign-off here would re-sign
               someone else's run as their own. Unsigned export stays. -->
          <div class="text-[12px] font-semibold text-ink-900 dark:text-night-text">Export results</div>
          <p class="text-[11.5px] text-ink-700 dark:text-night-dim leading-snug">
            The marks on screen are from the imported run{app.testPilot.importedRun?.signoff
              ? ` signed by ${app.testPilot.importedRun.signoff.tester}`
              : ""} — signing them as your own is disabled. Export without sign-off, or Clear the imported run to sign your own marks.
          </p>
        {:else}
          <div class="text-[12px] font-semibold text-ink-900 dark:text-night-text">Sign off this run</div>
          <div class="grid grid-cols-2 gap-1.5">
            <input
              type="text"
              class="col-span-2 w-full px-2 py-1.5 text-[12px] rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute outline-none focus:border-brand-pink dark:focus:border-brand-pink-light"
              placeholder="Tester name (required to sign)"
              bind:value={app.testerInfo.name}
              aria-label="Tester name"
            />
            <input
              type="email"
              class="col-span-2 w-full px-2 py-1.5 text-[12px] rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute outline-none focus:border-brand-pink dark:focus:border-brand-pink-light"
              placeholder="Email (optional)"
              bind:value={app.testerInfo.email}
              aria-label="Tester email"
            />
            <label class="block min-w-0">
              <span class="block text-[10px] font-medium text-ink-500 dark:text-night-mute mb-0.5">Run date</span>
              <input
                type="date"
                class="w-full px-2 py-1.5 text-[12px] rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card text-ink-900 dark:text-night-text outline-none focus:border-brand-pink dark:focus:border-brand-pink-light"
                bind:value={signoffDate}
                aria-label="Run date"
              />
            </label>
            <label class="block min-w-0">
              <span class="block text-[10px] font-medium text-ink-500 dark:text-night-mute mb-0.5">Environment</span>
              <select
                class="w-full px-2 py-1.5 text-[12px] rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card text-ink-900 dark:text-night-text outline-none focus:border-brand-pink dark:focus:border-brand-pink-light"
                bind:value={app.testerInfo.environment}
                aria-label="Environment"
              >
                <option value="">Environment…</option>
                <option>Dev</option>
                <option>Staging</option>
                <option>UAT</option>
                <option>Prod</option>
                <option>Other</option>
              </select>
            </label>
            <label class="col-span-2 block min-w-0">
              <span class="block text-[10px] font-medium text-ink-500 dark:text-night-mute mb-0.5">Run type</span>
              <select
                class="w-full px-2 py-1.5 text-[12px] rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card text-ink-900 dark:text-night-text outline-none focus:border-brand-pink dark:focus:border-brand-pink-light"
                bind:value={signoffRunType}
                aria-label="Run type"
                title="What kind of pass this run was — recorded in the results file"
              >
                <option>Smoke</option>
                <option>Thorough</option>
                <option>Regression</option>
              </select>
            </label>
            <textarea
              rows="2"
              class="col-span-2 w-full px-2 py-1.5 text-[12px] rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute outline-none focus:border-brand-pink dark:focus:border-brand-pink-light resize-y"
              placeholder="Notes for this run (optional — blockers, build under test, …)"
              bind:value={signoffNotes}
              aria-label="Run notes"
            ></textarea>
          </div>
        {/if}
        <div class="flex items-center gap-1.5 flex-wrap">
          {#if !readOnlyRun}
            <button
              type="button"
              class="inline-flex items-center rounded-md bg-brand-pink text-white text-[11.5px] font-semibold px-2.5 py-1.5 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={!app.testerInfo.name.trim()}
              onclick={() => void exportResultsWithSignoff(true)}
            >
              Export signed results (.{signoffOpen})
            </button>
          {/if}
          <button
            type="button"
            class="text-[11.5px] text-ink-600 dark:text-night-dim hover:text-ink-900 dark:hover:text-night-text underline"
            onclick={() => void exportResultsWithSignoff(false)}
          >
            Export without sign-off
          </button>
          <button
            type="button"
            class="ml-auto text-[11.5px] text-ink-500 dark:text-night-mute hover:text-ink-900 dark:hover:text-night-text"
            onclick={() => (signoffOpen = null)}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}

    <!-- IMPORTED-RUN banner — a tester's returned results are overlaid;
         marks are read-only until cleared (Clear restores your own). -->
    {#if app.testPilot.importedRun}
      {@const run = app.testPilot.importedRun}
      <div class="rounded-md border border-brand-pink/40 dark:border-brand-pink-light/40 bg-brand-pink/5 p-2.5 text-[12px] text-ink-800 dark:text-night-text leading-snug flex items-start gap-2">
        <div class="flex-1 min-w-0 space-y-0.5">
          <div>
            <span class="font-semibold">Imported run</span>
            {#if run.signoff}
              — {run.signoff.tester}{run.signoff.environment ? ` · ${run.signoff.environment}` : ""}{run.signoff.runType ? ` · ${run.signoff.runType} run` : ""}{run.signoff.date ? ` · ${run.signoff.date}` : ""}
            {/if}
            <span class="text-ink-500 dark:text-night-mute"> · {run.applied} of {catalogTotal} result{catalogTotal === 1 ? "" : "s"} applied{run.unknownIds.length > 0 ? `, ${run.unknownIds.length} unknown id${run.unknownIds.length === 1 ? "" : "s"} skipped` : ""}{run.scope ? ` · partial run: ${run.scope}` : ""}</span>
          </div>
          {#if run.signoff?.notes}
            <div class="text-[11px] text-ink-600 dark:text-night-dim">“{run.signoff.notes}”</div>
          {/if}
          <div class="text-[11px] text-ink-500 dark:text-night-mute">Marks are read-only while this run is shown — Clear to get your own marks back.</div>
        </div>
        <button
          type="button"
          class="shrink-0 text-[11.5px] font-semibold text-brand-pink dark:text-brand-pink-light hover:underline"
          onclick={() => app.clearImportedRun()}
          aria-label="Clear imported run"
        >
          Clear
        </button>
      </div>
    {/if}

    <!-- FILE-FAILED-TESTS selection sheet (WS4) — small inline sheet,
         failed + unfiled rows with checkboxes (all pre-checked). -->
    {#if fileIssuesOpen}
      <div class="rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-2.5 space-y-2">
        <div class="text-[12px] font-semibold text-ink-900 dark:text-night-text">
          File failed tests as issues
        </div>
        <ul class="space-y-1 max-h-48 overflow-y-auto">
          {#each failedUnfiled as row (row.id)}
            <li>
              <label class="flex items-start gap-1.5 text-[11.5px] text-ink-800 dark:text-night-text cursor-pointer rounded px-1 -mx-1 py-0.5 hover:bg-ink-50 dark:hover:bg-night-alt">
                <input
                  type="checkbox"
                  class="accent-brand-pink mt-0.5"
                  bind:checked={fileIssuesSelected[row.id]}
                />
                <span class="min-w-0">
                  <span class="font-mono text-[10.5px] text-ink-500 dark:text-night-mute tabular-nums">{row.id}</span>
                  <span class="text-ink-500 dark:text-night-mute"> · {row.section}</span>
                  <span class="block truncate" title={row.test}>{row.test}</span>
                </span>
              </label>
            </li>
          {/each}
        </ul>
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="inline-flex items-center rounded-md bg-brand-pink text-white text-[11.5px] font-semibold px-2.5 py-1.5 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={fileIssuesCheckedCount === 0}
            onclick={confirmFileIssues}
          >
            File {fileIssuesCheckedCount} issue{fileIssuesCheckedCount === 1 ? "" : "s"}
          </button>
          <button
            type="button"
            class="text-[11.5px] text-ink-600 dark:text-night-dim hover:text-ink-900 dark:hover:text-night-text"
            onclick={() => (fileIssuesOpen = false)}
          >
            Cancel
          </button>
          <span class="ml-auto text-[10.5px] text-ink-500 dark:text-night-mute">
            {app.appMode === "standalone"
              ? "Needs a connected companion — nothing will be filed"
              : gitlabReady
                ? "via glab, one issue per test"
                : "GitLab module off — entries land in .pinta/tasks.md"}
          </span>
        </div>
      </div>
    {/if}

    <!-- SEARCH — filters the catalog by id (AUTH-1), category (section
         title), or content (test title / expected). While active, all
         sections render expanded so matches aren't hidden. -->
    <div class="space-y-1">
      <div class="relative">
        <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400 dark:text-night-mute pointer-events-none" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </span>
        <input
          type="search"
          bind:this={searchEl}
          bind:value={searchQuery}
          placeholder="Search id, category, or content (e.g. AUTH-1)"
          aria-label="Search tests"
          class="w-full pl-8 {app.voiceReady ? 'pr-14' : 'pr-8'} py-1.5 text-[12px] rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute outline-none focus:border-brand-pink dark:focus:border-brand-pink-light [&::-webkit-search-cancel-button]:appearance-none"
        />
        {#if searchActive}
          <button
            type="button"
            class="absolute {app.voiceReady ? 'right-8' : 'right-2'} top-1/2 -translate-y-1/2 text-ink-400 dark:text-night-mute hover:text-ink-700 dark:hover:text-night-text leading-none"
            onclick={() => (searchQuery = "")}
            aria-label="Clear search"
            title="Clear search"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        {/if}
        {#if app.voiceReady}
          <span class="absolute right-1 top-1/2 -translate-y-1/2">
            <MicButton el={searchEl} lang={app.voiceLang} />
          </span>
        {/if}
      </div>
      {#if searchActive}
        {@const n = matchCount()}
        <div class="text-[11px] text-ink-500 dark:text-night-mute tabular-nums px-0.5">
          {n} {n === 1 ? "match" : "matches"} for “{searchQuery.trim()}”
        </div>
      {/if}
    </div>

    <!-- WORK ON — scope selector (Phase 21). Filters the list, the
         counters and the exports; never touches stored marks, and the
         .pinta bundle still carries every row. -->
    <div class="flex items-center gap-1.5">
      <label class="shrink-0 text-[11px] font-medium text-ink-500 dark:text-night-mute" for="pinta-scope">Work on</label>
      <select
        id="pinta-scope"
        class="flex-1 min-w-0 px-2 py-1 text-[11.5px] rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card text-ink-900 dark:text-night-text outline-none focus:border-brand-pink dark:focus:border-brand-pink-light"
        value={scopeToToken(app.testPilot.scope)}
        onchange={(e) => applyScopeToken(e.currentTarget.value)}
        title="Which slice of the catalog to run — everything, only what changed in the latest revision, what failed, or a saved plan"
      >
        <option value="all">Everything ({app.testPilot.catalog?.sections.reduce((n, s) => n + s.tests.length, 0) ?? 0})</option>
        {#each scopeBaseRevs as base (base)}
          <option value="since:{base}">New in v{base + 1} (added or reworded)</option>
        {/each}
        {#if app.testPilot.scope.kind === "since" && !scopeBaseRevs.includes(app.testPilot.scope.rev)}
          <!-- A scope restored from storage that predates the last five
               revisions still needs an option, or the control would read
               "Everything" while the list stays filtered. -->
          <option value="since:{app.testPilot.scope.rev}">New in v{app.testPilot.scope.rev + 1} (added or reworded)</option>
        {/if}
        <option value="failed">Failed right now</option>
        <option value="untested">Not run yet</option>
        {#each app.testPilot.plans as plan (plan.id)}
          <option value="plan:{plan.id}" title={plan.name}>{plan.name}</option>
        {/each}
      </select>
      {#if app.testPilot.scope.kind === "plan"}
        <button
          type="button"
          class="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-md text-ink-500 dark:text-night-mute hover:text-red-600 dark:hover:text-red-400 hover:bg-ink-50 dark:hover:bg-night-alt"
          onclick={() => {
            const scope = app.testPilot.scope;
            if (scope.kind === "plan") void removePlan(scope.id);
          }}
          title="Delete this saved plan (the tests themselves stay)"
          aria-label="Delete saved plan"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      {:else}
        <button
          type="button"
          class="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-md text-ink-500 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light hover:bg-ink-50 dark:hover:bg-night-alt disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-ink-500"
          onclick={() => void openPlanNameRow()}
          disabled={!app.testPilot.catalog}
          title="Save the tests currently in scope as a named plan"
          aria-label="Save current scope as a plan"
          aria-expanded={planNameOpen}
          aria-controls="pinta-plan-name"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        </button>
      {/if}
    </div>
    {#if planNameOpen}
      <div class="flex items-center gap-1.5">
        <input
          type="text"
          id="pinta-plan-name"
          bind:this={planNameEl}
          bind:value={planName}
          maxlength="60"
          placeholder="Plan name (e.g. Sprint 12 regression)"
          aria-label="Plan name"
          class="flex-1 min-w-0 px-2 py-1 text-[11.5px] rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute outline-none focus:border-brand-pink dark:focus:border-brand-pink-light"
          oninput={() => (planError = null)}
          onkeydown={(e) => {
            if (e.key === "Enter") saveScopeAsPlan();
            if (e.key === "Escape") {
              planName = "";
              planError = null;
              planNameOpen = false;
            }
          }}
        />
        <button
          type="button"
          class="shrink-0 rounded-md bg-brand-pink px-2 py-1 text-[11.5px] font-semibold text-white hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-brand-pink"
          disabled={!planName.trim()}
          onclick={saveScopeAsPlan}
        >
          Save
        </button>
      </div>
      {#if planError}
        <div class="text-[10.5px] text-red-600 dark:text-red-400 px-0.5">{planError}</div>
      {/if}
    {/if}
    {#if scopeActive}
      {@const missing = app.scopeMissingIds}
      <div class="text-[11px] text-ink-500 dark:text-night-mute leading-snug px-0.5">
        Filtered view: <span class="font-semibold text-ink-700 dark:text-night-dim">{app.scopeLabel}</span> (catalog is at v{catalogRev}).
        {#if !readOnlyRun}
          Marks still belong to the whole catalog — but <span class="font-semibold text-ink-700 dark:text-night-dim">exports and the tester sheet carry only these rows</span>.
        {:else}
          Exports and the tester sheet carry only these rows.
        {/if}
        {#if missing.length > 0}
          <span class="text-amber-600 dark:text-amber-400">{missing.length} test{missing.length === 1 ? "" : "s"} in this selection no longer exist.</span>
        {/if}
      </div>
    {/if}

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
      <!-- Tester-sheet prep progress while the Export popover is closed —
           a prep can take minutes and the spinner on the Export trigger
           alone doesn't say how far along it is. Neutral, not amber:
           it's working, nothing needs a decision. -->
      {#if stepPrep && !exportMenuOpen}
        <div role="status" class="text-[11px] text-ink-500 dark:text-night-mute flex items-center gap-1.5" data-pinta-step-prep-inline>
          <span>Generating tester-sheet steps {Math.min(stepPrep.done + 1, stepPrep.total)} of {stepPrep.total}…</span>
          <button
            type="button"
            class="underline underline-offset-2 hover:text-brand-pink dark:hover:text-brand-pink-light"
            onclick={() => {
              exportMenuAlignLeft = (exportBtnEl?.getBoundingClientRect().right ?? Infinity) < 288 + 8;
              exportMenuOpen = true;
              emailedNote = null;
              void app.loadTesterInfo();
            }}
            title="Open the Export popover to follow or cancel the step generation"
          >Show</button>
        </div>
      {/if}
    </div>

    {#if app.testPilot.error}
      <div class="rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2.5 text-[12px] text-red-700 dark:text-red-300 leading-snug flex items-start gap-2">
        <span class="flex-1 min-w-0">{app.testPilot.error}</span>
        <button
          type="button"
          class="shrink-0 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200 leading-none px-1"
          onclick={() => (app.testPilot.error = null)}
          aria-label="Dismiss error"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    {/if}

    <!-- SECTIONS -->
    <div class="space-y-3">
      {#each app.testPilot.catalog.sections.filter(sectionVisible) as section (section.title)}
        {@const collapsed = searchActive ? false : (collapsedSections[section.title] ?? false)}
        {@const secPass = section.tests.filter((t) => t.status === "pass").length}
        {@const secFail = section.tests.filter((t) => t.status === "fail").length}
        {@const secTotal = section.tests.length}
        {@const secPct = secTotal > 0 ? Math.round(((secPass + secFail) / secTotal) * 100) : 0}
        {@const secUnloaded = section.tests.filter((t) => !hasSteps(t)).length}
        {@const secBulkFetching = !!bulkFetchingSections[section.title]}
        {@const editingThisSection =
          editingField === `section:${section.title}` ||
          (editingField === "section:" && section.title === "")}
        {@const isSectionDragging =
          dragging?.kind === "section" &&
          dragging.sectionTitle === section.title}
        {@const sectionDropKey = `section:${section.title}`}
        {@const sectionDropAbove =
          dropHint?.key === sectionDropKey && dropHint.position === "above"}
        {@const sectionDropBelow =
          dropHint?.key === sectionDropKey && dropHint.position === "below"}
        <div
          class="relative rounded-lg border border-ink-200 dark:border-night-line bg-ink-50 dark:bg-night-alt transition-opacity"
          class:opacity-50={isSectionDragging}
          ondragover={(e) =>
            onItemDragOver(e, { kind: "section", sectionTitle: section.title })}
          ondrop={(e) =>
            onItemDrop(e, { kind: "section", sectionTitle: section.title })}
        >
          {#if sectionDropAbove}
            <span class="absolute -top-1 left-0 right-0 h-0.5 rounded-full bg-brand-pink dark:bg-brand-pink-light pointer-events-none" aria-hidden="true"></span>
          {/if}
          {#if sectionDropBelow}
            <span class="absolute -bottom-1 left-0 right-0 h-0.5 rounded-full bg-brand-pink dark:bg-brand-pink-light pointer-events-none" aria-hidden="true"></span>
          {/if}
          <!-- Section card was previously `overflow-hidden` so the
               header's hover-background didn't bleed past the rounded
               corners. That clipped the per-row kebab dropdowns (Edit
               title / Move / Delete) any time they extended past the
               card edge. Section header now opts into its own
               `rounded-t-lg` so the corner-mask use-case still works
               without trapping descendants. -->
          <div class="pinta-section-trigger rounded-t-lg flex items-stretch text-[12px] font-medium text-ink-900 dark:text-night-text">
            <!-- Drag handle (Phase 14.4) — grip icon visible on hover.
                 Only this element is `draggable`, so the rest of the
                 header (expand toggle, tally, kebab) stays click-only
                 and the user can't accidentally start a drag while
                 trying to interact with other affordances. -->
            {#if !editingThisSection}
              <span
                class="pinta-drag-handle shrink-0 self-stretch inline-flex items-center justify-center w-5 text-ink-400 dark:text-night-mute hover:text-ink-700 dark:hover:text-night-text cursor-grab active:cursor-grabbing opacity-0 transition-opacity"
                draggable="true"
                role="button"
                tabindex="-1"
                aria-label="Drag to reorder section"
                title="Drag to reorder"
                ondragstart={(e) =>
                  onItemDragStart(e, {
                    kind: "section",
                    sectionTitle: section.title,
                  })}
                ondragend={onItemDragEnd}
              >
                <svg width="10" height="14" viewBox="0 0 6 12" fill="currentColor" aria-hidden="true">
                  <circle cx="1.5" cy="2" r="0.85"/><circle cx="4.5" cy="2" r="0.85"/>
                  <circle cx="1.5" cy="6" r="0.85"/><circle cx="4.5" cy="6" r="0.85"/>
                  <circle cx="1.5" cy="10" r="0.85"/><circle cx="4.5" cy="10" r="0.85"/>
                </svg>
              </span>
            {/if}
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
                  class="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full hover:bg-ink-100 dark:hover:bg-night-line"
                  class:text-brand-pink={!!app.testPilot.pendingSectionSuggest[section.title]}
                  class:dark:text-brand-pink-light={!!app.testPilot.pendingSectionSuggest[section.title]}
                  class:text-ink-500={!app.testPilot.pendingSectionSuggest[section.title]}
                  class:dark:text-night-dim={!app.testPilot.pendingSectionSuggest[section.title]}
                  class:hover:text-ink-900={!app.testPilot.pendingSectionSuggest[section.title]}
                  class:dark:hover:text-night-text={!app.testPilot.pendingSectionSuggest[section.title]}
                  onclick={() => toggleSectionKebab(section.title)}
                  aria-haspopup="menu"
                  aria-expanded={sectionKebabOpen === section.title}
                  aria-label="Section actions"
                  title={app.testPilot.pendingSectionSuggest[section.title]
                    ? "Suggesting tests…"
                    : "Section actions"}
                >
                  {#if app.testPilot.pendingSectionSuggest[section.title]}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  {:else}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="12" cy="5" r="1.6" />
                      <circle cx="12" cy="12" r="1.6" />
                      <circle cx="12" cy="19" r="1.6" />
                    </svg>
                  {/if}
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
                    <button
                      type="button"
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt hover:text-ink-900 dark:hover:text-night-text disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-700 dark:disabled:hover:text-night-dim"
                      onclick={() => { app.requestSectionSuggestions(section.title); sectionKebabOpen = null; }}
                      disabled={!!app.testPilot.pendingSectionSuggest[section.title]}
                      role="menuitem"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/></svg>
                      {app.testPilot.pendingSectionSuggest[section.title] ? "Suggesting…" : "Suggest tests"}
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
          <!-- Phase 14.6 — inline suggestion checklist. Renders when the
               agent has returned scenarios for this section; the tester
               ticks which to add as USER-N rows. Shows regardless of the
               collapse state so a fresh suggestion is never hidden. -->
          {#if (app.testPilot.sectionSuggestions[section.title]?.length ?? 0) > 0}
            {@const suggestions = app.testPilot.sectionSuggestions[section.title] ?? []}
            {@const checkedCount = suggestions.filter((s) => s.checked).length}
            <div class="border-t border-brand-pink/30 dark:border-brand-pink-light/30 bg-brand-pink/5 dark:bg-brand-pink-light/5 px-3 py-2.5">
              <div class="flex items-center justify-between mb-2">
                <span class="text-[11px] font-semibold text-brand-pink dark:text-brand-pink-light inline-flex items-center gap-1">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/></svg>
                  Suggested tests ({suggestions.length})
                </span>
                <button
                  type="button"
                  class="text-[11px] text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
                  onclick={() => app.dismissSectionSuggestions(section.title)}
                >Dismiss</button>
              </div>
              <ul class="space-y-1">
                {#each suggestions as sug (sug.test)}
                  <li>
                    <button
                      type="button"
                      class="w-full flex items-start gap-2 text-left rounded px-1 py-1 hover:bg-brand-pink/10 dark:hover:bg-brand-pink-light/10"
                      onclick={() => (sug.checked = !sug.checked)}
                      aria-pressed={sug.checked}
                    >
                      <span
                        class="mt-0.5 shrink-0 w-4 h-4 inline-flex items-center justify-center rounded border {sug.checked
                          ? 'bg-brand-pink dark:bg-brand-pink-light border-brand-pink dark:border-brand-pink-light text-white dark:text-night-bg'
                          : 'border-ink-300 dark:border-night-line bg-white dark:bg-night-alt'}"
                      >
                        {#if sug.checked}
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        {/if}
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block text-[12px] font-semibold text-ink-900 dark:text-night-text leading-snug">{sug.test}</span>
                        {#if sug.expected}
                          <span class="block text-[11px] text-ink-500 dark:text-night-mute leading-snug">{sug.expected}</span>
                        {/if}
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
              <div class="flex items-center gap-2 mt-2.5">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-md bg-brand-pink dark:bg-brand-pink-light text-white dark:text-night-bg text-[11px] font-semibold px-2.5 py-1 disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
                  onclick={() => app.addCheckedSuggestions(section.title)}
                  disabled={checkedCount === 0}
                >
                  Add selected ({checkedCount})
                </button>
              </div>
            </div>
          {/if}
          {#if !collapsed}
            <ul class="border-t border-ink-200 dark:border-night-line">
              {#each visibleTests(section) as test (test.id)}
                {@const detailLoading = !!app.testPilot.pendingDetails[test.id]}
                {@const detailLoaded = !!test.detail}
                {@const chatLoading = !!app.testPilot.pendingChats[test.id]}
                {@const isActive = activeTestId === test.id}
                {@const editingTitle = editingField === `test-title:${test.id}`}
                {@const editingExpected = editingField === `test-expected:${test.id}`}
                {@const isTestDragging =
                  dragging?.kind === "test" && dragging.testId === test.id}
                {@const testDropKey = `test:${test.id}`}
                {@const testDropAbove =
                  dropHint?.key === testDropKey && dropHint.position === "above"}
                {@const testDropBelow =
                  dropHint?.key === testDropKey && dropHint.position === "below"}
                <li
                  class="relative border-b border-ink-200 dark:border-night-line last:border-b-0 transition-opacity"
                  class:opacity-50={isTestDragging}
                  data-test-row={test.id}
                  ondragover={(e) =>
                    onItemDragOver(e, {
                      kind: "test",
                      sectionTitle: section.title,
                      testId: test.id,
                    })}
                  ondrop={(e) =>
                    onItemDrop(e, {
                      kind: "test",
                      sectionTitle: section.title,
                      testId: test.id,
                    })}
                >
                  {#if testDropAbove}
                    <span class="absolute -top-px left-2 right-2 h-0.5 rounded-full bg-brand-pink dark:bg-brand-pink-light pointer-events-none z-10" aria-hidden="true"></span>
                  {/if}
                  {#if testDropBelow}
                    <span class="absolute -bottom-px left-2 right-2 h-0.5 rounded-full bg-brand-pink dark:bg-brand-pink-light pointer-events-none z-10" aria-hidden="true"></span>
                  {/if}
                  <!-- Drag handle (Phase 14.4) — grip icon at the
                       leading edge of each row, opacity-0 by default
                       so it doesn't visually compete with the status
                       checkbox. Fades in on row hover via the
                       pinta-test-row group selector (see app.css).
                       Hidden while inline-editing this row so the
                       caret cursor isn't fighting a grab cursor. -->
                  {#if !editingTitle && !editingExpected}
                    <span
                      class="pinta-drag-handle absolute left-0.5 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-4 h-7 text-ink-400 dark:text-night-mute hover:text-ink-700 dark:hover:text-night-text cursor-grab active:cursor-grabbing opacity-0 transition-opacity"
                      draggable="true"
                      role="button"
                      tabindex="-1"
                      aria-label="Drag to reorder test"
                      title="Drag to reorder"
                      ondragstart={(e) =>
                        onItemDragStart(e, {
                          kind: "test",
                          sectionTitle: section.title,
                          testId: test.id,
                        })}
                      ondragend={onItemDragEnd}
                    >
                      <svg width="8" height="12" viewBox="0 0 6 12" fill="currentColor" aria-hidden="true">
                        <circle cx="1.5" cy="2" r="0.85"/><circle cx="4.5" cy="2" r="0.85"/>
                        <circle cx="1.5" cy="6" r="0.85"/><circle cx="4.5" cy="6" r="0.85"/>
                        <circle cx="1.5" cy="10" r="0.85"/><circle cx="4.5" cy="10" r="0.85"/>
                      </svg>
                    </span>
                  {/if}
                  <div
                    class="pinta-test-row flex items-start gap-3 px-3 py-3 transition-colors {isActive
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
                      class="shrink-0 w-5 h-5 mt-0.5 inline-flex items-center justify-center rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      class:bg-emerald-500={test.status === "pass"}
                      class:text-white={test.status === "pass" || test.status === "fail"}
                      class:bg-red-500={test.status === "fail"}
                      class:border={test.status === "untested"}
                      class:border-ink-300={test.status === "untested"}
                      class:dark:border-night-line={test.status === "untested"}
                      class:bg-white={test.status === "untested"}
                      class:dark:bg-night-alt={test.status === "untested"}
                      onclick={() => toggleStatusMenu(test.id)}
                      disabled={readOnlyRun}
                      title={readOnlyRun ? READ_ONLY_TITLE : undefined}
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
                           Clicking opens ONLY the chat sheet (not the
                           steps detail view), so the tester can ask a
                           quick question without forcing a fetchDetailSteps
                           round-trip. Hidden when chat is disabled via
                           module setting. -->
                      {#if chatEnabled}
                        {@const hasChat = (test.chat?.length ?? 0) > 0}
                        <button
                          type="button"
                          class="shrink-0 w-8 h-9 inline-flex items-center justify-center rounded-full hover:bg-ink-50 dark:hover:bg-night-alt"
                          class:text-brand-pink={hasChat || chatLoading}
                          class:dark:text-brand-pink-light={hasChat || chatLoading}
                          class:text-ink-400={!hasChat && !chatLoading}
                          class:dark:text-night-mute={!hasChat && !chatLoading}
                          class:hover:text-brand-pink={!chatLoading}
                          class:dark:hover:text-brand-pink-light={!chatLoading}
                          onclick={() => { chatTestId = test.id; chatOpen = true; chatDraft = ""; }}
                          title={chatLoading
                            ? "Agent is replying to your last question…"
                            : hasChat
                              ? `${test.chat!.length} chat message${test.chat!.length === 1 ? "" : "s"} with the agent`
                              : "Ask the agent a question about this row"}
                          aria-label={chatLoading
                            ? `Chat reply pending for ${test.id}`
                            : hasChat
                              ? `View chat for ${test.id}`
                              : `Open chat for ${test.id}`}
                        >
                          {#if chatLoading}
                            <!-- Replace the bubble with a spinner so the
                                 user can ask another row while this one
                                 is still computing, then come back —
                                 same UX as the `?` (Help) icon. -->
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin" aria-hidden="true">
                              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                            </svg>
                          {:else}
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" fill={hasChat ? "currentColor" : "none"} />
                              <path d="M8 12h.01" stroke={hasChat ? "white" : "currentColor"} />
                              <path d="M12 12h.01" stroke={hasChat ? "white" : "currentColor"} />
                              <path d="M16 12h.01" stroke={hasChat ? "white" : "currentColor"} />
                            </svg>
                          {/if}
                        </button>
                      {/if}

                      <!-- Filed indicator — this failed row already has a
                           tracker issue (GitLab link) or a tasks.md entry. -->
                      {#if app.testPilot.filedIssues[test.id]}
                        {@const filed = app.testPilot.filedIssues[test.id]!}
                        {@const filedHref = safeExternalUrl(filed.url)}
                        <!-- Agent-supplied link: https / loopback http only (persisted
                             entries from older builds are re-checked here). -->
                        {#if filed.target === "gitlab" && filedHref}
                          <a
                            href={filedHref}
                            target="_blank"
                            rel="noreferrer"
                            class="shrink-0 w-8 h-9 inline-flex items-center justify-center rounded-full text-emerald-600 dark:text-emerald-400 hover:bg-ink-50 dark:hover:bg-night-alt"
                            title={`Filed to GitLab${filed.title ? `: ${filed.title}` : ""} — open issue`}
                            aria-label={`Open the GitLab issue for ${test.id}`}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                          </a>
                        {:else}
                          <span
                            class="shrink-0 w-8 h-9 inline-flex items-center justify-center text-emerald-600 dark:text-emerald-400"
                            title={`Filed locally${filed.path ? ` → ${filed.path}` : " → .pinta/tasks.md"}`}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                          </span>
                        {/if}
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
                        {@const tIdx = sIdx2 >= 0 ? app.testPilot.catalog.sections[sIdx2]!.tests.findIndex((t) => t.id === test.id) : -1}
                        {@const isFirstTest = tIdx === 0}
                        {@const isLastTest = sIdx2 >= 0 && tIdx === app.testPilot.catalog.sections[sIdx2]!.tests.length - 1}
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
                        class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-emerald-50 dark:hover:bg-emerald-950/30 hover:text-emerald-700 dark:hover:text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed"
                        onclick={() => setStatusFromMenu(test.id, "pass")}
                        disabled={readOnlyRun}
                        title={readOnlyRun ? READ_ONLY_TITLE : undefined}
                        role="menuitem"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-600 dark:text-emerald-400"><polyline points="20 6 9 17 4 12"/></svg>
                        Pass
                      </button>
                      <button
                        type="button"
                        class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
                        onclick={() => setStatusFromMenu(test.id, "fail")}
                        disabled={readOnlyRun}
                        title={readOnlyRun ? READ_ONLY_TITLE : undefined}
                        role="menuitem"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="text-red-600 dark:text-red-400"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        Fail
                      </button>
                      <button
                        type="button"
                        class="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink-700 dark:text-night-dim hover:bg-ink-50 dark:hover:bg-night-alt disabled:opacity-40 disabled:cursor-not-allowed"
                        onclick={() => setStatusFromMenu(test.id, "untested")}
                        disabled={readOnlyRun}
                        title={readOnlyRun ? READ_ONLY_TITLE : undefined}
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

      <!-- No-results state — only while a query is active and nothing
           matched. The search box above stays put so the user can edit
           or clear the query. -->
      {#if (searchActive || scopeActive) && matchCount() === 0}
        <div class="rounded-lg border border-dashed border-ink-300 dark:border-night-line bg-ink-50 dark:bg-night-alt px-3 py-6 text-center space-y-2">
          <p class="text-[12px] text-ink-600 dark:text-night-dim">
            {#if searchActive && scopeActive}
              No tests in “{app.scopeLabel}” match “{searchQuery.trim()}”.
            {:else if searchActive}
              No tests match “{searchQuery.trim()}”.
            {:else}
              Nothing in “{app.scopeLabel}” right now.
            {/if}
          </p>
          <button
            type="button"
            class="text-[11px] font-medium text-brand-pink dark:text-brand-pink-light hover:underline"
            onclick={() => {
              searchQuery = "";
              app.setTestPilotScope({ kind: "all" });
            }}
          >
            {searchActive && !scopeActive ? "Clear search" : "Show everything"}
          </button>
        </div>
      {/if}

      <!-- Add-section affordance — appends an empty section + drops
           the user into inline-edit on its title. Mirrors the
           "+ Add author / + Add description" pattern in the header.
           Hidden while a search is active (adding a blank section into a
           filtered view would be confusing). -->
      {#if !searchActive && !scopeActive}
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
      {/if}
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

<!-- Phase 14 — Chat bottom sheet. Rendered at top level so the catalog
     row chat icon can pop the sheet WITHOUT forcing the steps DETAIL
     view open. In DETAIL view the FAB sets `chatTestId` to the viewed
     row; from the catalog the row's chat icon sets it directly. -->
{#if chatTestId}
  {@const chatTest = findChatTest()}
  {@const chatSection = findChatSectionTitle()}
  {@const author = app.testPilot.catalog?.author?.trim()}
  {@const firstName = author ? author.split(/\s+/)[0] : ""}
  {#await loadChatSheet() then ChatSheetMod}
  <ChatSheetMod.default
    open={chatOpen && !!chatTest}
    contextHeader="Talking about"
    contextLabel={chatTest?.id ?? ""}
    contextSubLabel={chatSection}
    messages={chatTest?.chat ?? []}
    pending={chatPending}
    error={app.testPilot.error}
    placeholder="Ask the agent about this test…"
    greeting={`Hi${firstName ? ` ${firstName}` : ""} — I can help you review ${chatTest?.id ?? "this test"}. What would you like to check?`}
    quickPrompts={[
      { label: "Summarize this test", prompt: `Summarize ${chatTest?.id ?? "this test"} in 2-3 sentences — what it's checking, why it matters, and what the tester should look for.` },
      { label: "Submit Gitlab Issue", prompt: `Help me draft a GitLab issue for a bug I found while running ${chatTest?.id ?? "this test"}. Ask me for the repro steps, expected vs actual behavior, and severity, then format it as a GitLab issue (title + markdown body).` },
      { label: "Check for issues", prompt: `Are there any common failure modes or edge cases I should watch for when running ${chatTest?.id ?? "this test"}?` },
      // Format hint at the end is load-bearing: pushes the agent
      // toward the §7.10.3a `N. **Title** — Outcome` shape so the
      // "Add N to spec" button reliably appears on the reply.
      { label: "Suggest tests", prompt: `Suggest 5-8 additional test scenarios that belong under "${chatSection}" alongside ${chatTest?.id ?? "this test"}. Focus on adjacent edge cases, permission paths, error states, and device variants I might not have covered. Format each suggestion on its own line as \`N. **Concise test title** — Expected outcome.\` so I can one-click add the ones I want to my spec.` },
    ]}
    onClear={() => {
      if (chatTestId) app.clearChat(chatTestId);
    }}
    onExport={() => {
      if (!chatTestId) return;
      const md = app.exportTestPilotRowChatMarkdown(chatTestId);
      const ts = new Date().toISOString().slice(0, 10);
      downloadBlob(
        new Blob([md], { type: "text/markdown" }),
        `pinta-chat-${chatTestId}-${ts}.md`,
      );
    }}
    addToSectionLabel={chatSection}
    onAddSuggestions={(items) => {
      // Phase 14.3 — one-click batch add from agent suggestions.
      // The button only renders when both props are set + the
      // reply contains parseable `**Title** — Outcome` items, so
      // we always have a real section to target here.
      if (chatSection && items.length > 0) {
        app.addTestPilotTests(chatSection, items);
      }
    }}
    onAddSuggestionsToNewSection={(title, items) => {
      // Phase 14.3 — secondary route: user opted to drop the
      // suggestions into a fresh section. Pass `chatSection` as
      // the insertion anchor so the new category lands directly
      // BELOW the section the user was chatting about, instead of
      // at the bottom of the catalog (where it'd be visually
      // disconnected from the conversation that produced it).
      if (title && items.length > 0) {
        app.addTestPilotSectionWithTests(title, items, chatSection);
      }
    }}
    imagesEnabled={true}
    onClose={() => { chatOpen = false; chatDraft = ""; chatTestId = null; }}
    onSend={(prompt, images) => {
      if (chatTestId) void app.sendChatMessage(chatTestId, prompt, images);
    }}
  />
  {:catch}
    <div role="alert" class="absolute inset-x-3 bottom-3 z-30 flex items-start gap-2 text-xs text-red-600 border border-red-200 bg-red-50 dark:text-red-300 dark:border-red-900/40 dark:bg-red-950/90 rounded-md p-2">
      <p class="flex-1">Couldn't load the chat. Try again.</p>
      <button type="button" class="shrink-0 leading-none px-1" aria-label="Dismiss" title="Dismiss" onclick={() => { chatOpen = false; chatTestId = null; }}>✕</button>
    </div>
  {/await}
{/if}

<!-- Section-scoped chat removed — section help is now the icon-only
     "Suggest Test" affordance on each section header. The per-row chat
     sheet above is unaffected. -->
