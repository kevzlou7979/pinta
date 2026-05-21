import type {
  Annotation,
  ClientMessage,
  ImportedSession,
  ServerMessage,
  Session,
  SessionModule,
} from "@pinta/shared";
import {
  BUILTIN_MODULES,
  getModuleSpec,
  moduleIsConfigured,
  type ModuleSpec,
} from "./modules.js";
import { WsClient, type WsClientStatus } from "./ws-client.js";
import {
  discoverCompanions,
  type Companion,
} from "./companions.js";
import { findCompanionForUrl, matchAny } from "./url-patterns.js";
import {
  loadByOrigin,
  save as saveLocal,
  clearOrigin as clearLocal,
  originOf,
  getImportedSessions,
  addImportedSession,
  removeImportedSession,
  clearImportedSessions,
} from "./local-store.js";
import { decodePintaFile, decodePintaMarkdown } from "./pinta-file.js";
import { uid } from "./id.js";
import {
  composeTestDocMarkdown as composeTestDocMarkdownPure,
  nextUserTestId as nextUserTestIdPure,
} from "./test-pilot-doc.js";

const SELECTED_KEY = "pinta-selected-companion";

export type ExtensionMode = "draw" | "select" | "review" | "idle";

/** What the user has done with a test row in the current catalog. */
export type TestPilotStatus = "untested" | "pass" | "fail";

/** A single test row in the catalog. */
export type TestPilotTest = {
  id: string;
  test: string;
  expected: string;
  /** Local-only — not part of the agent's catalog JSON. */
  status: TestPilotStatus;
  /** Per-row detail cache, populated when the user clicks "?". */
  detail?: { steps: string[]; askedAt: number };
  /**
   * Free-form tester note for this row — typed in the detail view's
   * comment textarea above the Pass / Fail buttons. Persisted via
   * `saveTestPilot()` and embedded in the markdown export so QA notes
   * survive sign-off ("PIN field flashed red for 200ms before settling
   * — minor flicker, not a blocker"). Local-only; never travels to the
   * agent.
   */
  comment?: string;
};

/** A heading group within the catalog (e.g. "1.1 Authentication"). */
export type TestPilotSection = {
  title: string;
  tests: TestPilotTest[];
};

/** The full catalog extracted from one imported markdown doc. */
export type TestPilotCatalog = {
  docId: string;
  filename: string;
  importedAt: number;
  sections: TestPilotSection[];
  /** Optional human-authored metadata. Editable inline from the
   *  Test Pilot header; preserved across re-imports of the same docId
   *  so the user doesn't have to retype it. Surfaced in the exported
   *  markdown report. */
  title?: string;
  author?: string;
  description?: string;
};

/** In-flight query metadata so we can route the eventual session.synced
 *  to the right Test Pilot slot. */
export type TestPilotPending =
  | { kind: "doc-parse"; sessionId: string; filename: string }
  | { kind: "doc-generate"; sessionId: string; startedAt: number }
  | { kind: "detail-steps"; sessionId: string; testId: string };

/**
 * Top-level connection mode.
 * - `discovering`: first scan in flight, don't render mode-dependent UI yet
 * - `connected`: at least one companion is running; existing WS-driven flow
 * - `standalone`: no companions running anywhere; session lives in IndexedDB,
 *   only Copy is exposed (no agent submit). Designed for testers hitting
 *   deployed URLs who have no project on disk.
 */
export type AppMode = "discovering" | "connected" | "standalone";

function newDraft(url: string): Session {
  return {
    id: crypto.randomUUID(),
    url,
    projectRoot: "",
    startedAt: Date.now(),
    annotations: [],
    status: "drafting",
    producer: "extension",
  };
}

class ExtensionState {
  session = $state<Session | null>(null);
  mode = $state<ExtensionMode>("idle");
  selectedAnnotationId = $state<string | null>(null);
  connectionStatus = $state<WsClientStatus>("disconnected");
  lastError = $state<string | null>(null);

  /** All running companions, refreshed via rescan(). */
  companions = $state<Companion[]>([]);
  /** Which companion this side panel is connected to. */
  selectedCompanion = $state<Companion | null>(null);
  /** True while the first discovery scan is in flight. */
  scanning = $state(false);

  /** Sessions imported from `.pinta` share files. Read-only — viewable
   *  in History, optionally forkable into an editable local session. */
  importedSessions = $state<ImportedSession[]>([]);
  /** When set, the side panel renders a read-only viewer for this
   *  imported session instead of the regular drafting UI. Closing the
   *  viewer (or forking it) clears this back to null. */
  viewingImportedId = $state<string | null>(null);

  /**
   * Per-module enable + settings, persisted to chrome.storage.local under
   * the `pinta-modules` key. Keyed by module id; modules without an entry
   * are treated as disabled with empty settings. The Settings panel
   * mutates this; submit reads from it.
   */
  modules = $state<
    Record<
      string,
      { enabled: boolean; settings: Record<string, string | boolean> }
    >
  >({});
  /**
   * Per-session opt-in checkboxes — module ids the user has ticked for
   * the current submit. In-memory only; cleared on each new session so
   * the user always has to consciously opt in (matches the existing
   * `autoApply` / `includeScreenshot` pattern).
   */
  tickedModules = $state<Record<string, boolean>>({});
  /** True when Settings panel is open in the side panel. */
  viewingSettings = $state<boolean>(false);
  /**
   * Visual feedback toggles. `pulse` controls the pink/blue/etc.
   * pulsating glow that surrounds the page edges while the agent is
   * applying a session. Off by default — purely cosmetic.
   * Persisted to chrome.storage.local under `pinta-pulse-settings`.
   */
  pulseSettings = $state<{ enabled: boolean; color: string }>({
    enabled: false,
    color: "#3B82F6",
  });

  /**
   * Test Pilot — interactive module state. The user imports a markdown
   * test spec; the agent extracts a catalog of sections + test rows
   * (via a `kind: "query"` session with `op: "doc-parse"`). Each row
   * can be marked Pass / Fail locally and can be expanded via the
   * "?" button to ask the agent for detailed steps (`op: "detail-steps"`).
   *
   * Persisted to chrome.storage.local under `pinta-test-pilot:current`.
   * `pending` tracks an in-flight query session so the side panel can
   * show loading state and route the eventual `session.synced` back
   * into this slot instead of the annotation draft.
   */
  testPilot = $state<{
    catalog: TestPilotCatalog | null;
    /** Singleton slot for doc-parse / doc-generate. Those are blocking
     *  flows the user sees as a full-panel overlay, so one at a time. */
    pending: TestPilotPending | null;
    /** Concurrent in-flight detail-steps fetches, keyed by testId. The
     *  user can click ? on AUTH-01, go back, click ? on AUTH-02, and
     *  both spinners run side-by-side until the agent answers each. */
    pendingDetails: Record<string, { askedAt: number }>;
    error: string | null;
    /** True while the user has an inline edit (section rename, test
     *  title / expected, catalog meta) in flight. Set by the side
     *  panel on `startEditing`, cleared on `commitEdit` / `cancelEdit`.
     *  `applyCatalogResult` bails when this is true so a mid-edit
     *  Generate result doesn't clobber the user's in-progress text. */
    editingActive: boolean;
  }>({ catalog: null, pending: null, pendingDetails: {}, error: null, editingActive: false });

  /** Timer that fires if a Test Pilot query never gets a response —
   *  prevents the "Asking the agent…" spinner from sticking forever
   *  when no `/pinta` skill is listening, or the agent crashed mid-run. */
  private testPilotTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-testId timers for concurrent detail fetches. Same purpose as
   *  `testPilotTimer` but one-per-row so each ? can time out
   *  independently. */
  private detailTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Hard ceiling for any single Test Pilot query (doc-parse or
   *  detail-steps). Generous — long markdown docs take a while — but
   *  bounded. After this we surface a recovery message. */
  private static readonly TEST_PILOT_TIMEOUT_MS = 120_000;
  /** doc-generate is materially slower — the agent reads the whole
   *  project and writes a fresh UAT spec. Bump the ceiling so a
   *  legitimate multi-minute scan isn't killed early. */
  private static readonly TEST_PILOT_GENERATE_TIMEOUT_MS = 600_000;

  private client: WsClient | null = null;
  private creatingSession = false;
  /** Timer that recovers a stuck `creatingSession = true` if the
   *  companion never echoes back `session.created` / `session.synced`. */
  private creatingSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly CREATE_SESSION_TIMEOUT_MS = 10_000;
  private lastUrl: string | null = null;
  /** Origin currently driving the standalone-mode session (IDB key). */
  private currentOrigin: string | null = null;

  /**
   * Origins the user has explicitly opted into standalone mode for via
   * the "Use standalone for this site" button on the associate prompt.
   * Persisted to `chrome.storage.local["pinta-standalone-origins"]` so
   * the preference survives reloads. `rescan()` consults this set
   * BEFORE auto-routing to a companion — without it, a tab on an
   * unknown URL with a single running companion would silently get
   * auto-picked back into that project on every navigation.
   *
   * Explicitly picking a companion from the project picker removes the
   * current origin from the set (the user signaled "I do want this
   * one"), so reverting from standalone is one click away.
   */
  private standaloneOrigins = new Set<string>();
  private static readonly STANDALONE_ORIGINS_KEY = "pinta-standalone-origins";

  /**
   * Top-level connection mode. Standalone whenever no companion is
   * currently selected — covers both "no companions running" (tester
   * case) and "companions exist but none matched this URL" (tester on
   * a URL the dev forgot to register). The picker still appears in the
   * header so the user can associate manually if they want. Distinct
   * from `mode` above which controls the active drawing tool.
   */
  get appMode(): AppMode {
    if (this.selectedCompanion) return "connected";
    if (this.scanning && this.companions.length === 0) return "discovering";
    return "standalone";
  }

  /** True if the active tab's origin has been opt-in pinned to
   *  standalone mode. UI flag — App.svelte uses this to decorate the
   *  picker / show a "managed standalone" hint instead of the normal
   *  associate prompt. */
  get isUrlPinnedStandalone(): boolean {
    const origin = originOf(this.lastUrl);
    return !!origin && this.standaloneOrigins.has(origin);
  }

  /**
   * Begin the extension lifecycle. Discovers companions, picks one
   * (auto via URL pattern, or honoring a previously-stored choice),
   * and opens the WebSocket. Safe to call multiple times — subsequent
   * calls just rescan + re-evaluate.
   */
  async start(activeTabUrl: string | null): Promise<void> {
    this.lastUrl = activeTabUrl;
    // Hydrate imported sessions in parallel with the scan — they live
    // in IndexedDB and don't depend on which companion we land on.
    void this.refreshImported();
    void this.loadModules();
    void this.loadPulseSettings();
    void this.loadStandaloneOrigins();
    // Stage the legacy global catalog (if any) for the first companion
    // to claim. The actual per-project load happens inside connectTo.
    void this.readLegacyTestPilot();
    await this.rescan(activeTabUrl);
  }

  // ─── Pulse settings (cosmetic processing-glow on the page edges) ────

  private static readonly PULSE_KEY = "pinta-pulse-settings";

  // ─── Standalone-origin opt-ins ─────────────────────────────────────

  async loadStandaloneOrigins(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.STANDALONE_ORIGINS_KEY,
      );
      const raw = stored?.[ExtensionState.STANDALONE_ORIGINS_KEY] as
        | string[]
        | undefined;
      if (Array.isArray(raw)) {
        this.standaloneOrigins = new Set(
          raw.filter((s): s is string => typeof s === "string"),
        );
      }
    } catch {
      // storage missing — empty set is fine
    }
  }

  private async saveStandaloneOrigins(): Promise<void> {
    try {
      await chrome.storage?.local?.set({
        [ExtensionState.STANDALONE_ORIGINS_KEY]: [
          ...this.standaloneOrigins,
        ],
      });
    } catch {
      // ignore — in-memory set still drives current session behavior
    }
  }

  /**
   * Pin the current URL's origin to standalone mode. Disconnects any
   * active companion + hydrates the local-store session for the origin.
   * Persistent — survives reloads, navigations, and rescans until the
   * user explicitly picks a companion from the project picker (which
   * removes the origin via `select()`).
   */
  async pinCurrentUrlToStandalone(): Promise<void> {
    const origin = originOf(this.lastUrl);
    if (!origin) return;
    this.standaloneOrigins.add(origin);
    void this.saveStandaloneOrigins();
    // Disconnect the active companion so the side panel immediately
    // flips into standalone mode for this tab. Routing on subsequent
    // rescans honors the set so it doesn't snap back.
    await this.connectTo(null);
    await this.hydrateStandalone(this.lastUrl);
  }

  /** Remove the current origin's standalone pin (used implicitly when
   *  the user picks a companion). */
  private unpinOriginFromStandalone(origin: string | null): void {
    if (!origin) return;
    if (this.standaloneOrigins.delete(origin)) {
      void this.saveStandaloneOrigins();
    }
  }

  async loadPulseSettings(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.PULSE_KEY,
      );
      const raw = stored?.[ExtensionState.PULSE_KEY] as
        | { enabled?: boolean; color?: string }
        | undefined;
      if (raw && typeof raw === "object") {
        if (typeof raw.enabled === "boolean") this.pulseSettings.enabled = raw.enabled;
        if (typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color)) {
          this.pulseSettings.color = raw.color;
        }
      }
    } catch {
      // storage missing — defaults stand
    }
  }

  private async savePulseSettings(): Promise<void> {
    try {
      await chrome.storage?.local?.set({
        [ExtensionState.PULSE_KEY]: $state.snapshot(this.pulseSettings),
      });
    } catch {
      // ignore
    }
  }

  setPulseEnabled(enabled: boolean): void {
    this.pulseSettings.enabled = enabled;
    void this.savePulseSettings();
  }

  setPulseColor(hex: string): void {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    this.pulseSettings.color = hex;
    void this.savePulseSettings();
  }

  // ─── Test Pilot (interactive module) ───────────────────────────────

  /** Legacy global slot from v0.3.1 and earlier, before catalogs were
   *  scoped per-project. Read once on startup; the first companion the
   *  user connects to after upgrade inherits it (see loadTestPilot).
   *  After migration the key is removed. */
  private static readonly LEGACY_TEST_PILOT_KEY = "pinta-test-pilot:current";

  /** Per-companion storage key. Uses `projectRoot` (stable absolute
   *  path) rather than `port` (ephemeral, reassigned on restart). */
  private static testPilotKeyFor(companion: Companion): string {
    return `pinta-test-pilot:${companion.projectRoot}`;
  }

  /** Holds the legacy catalog between `readLegacyTestPilot` (called from
   *  `start`) and the first `loadTestPilot(companion)` call that claims
   *  it. Null afterwards. */
  private legacyTestPilotCatalog: TestPilotCatalog | null = null;

  /** Read the pre-v0.3.2 global catalog slot, if any. Doesn't write to
   *  state.testPilot — just stages it for the first connectTo to claim. */
  private async readLegacyTestPilot(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.LEGACY_TEST_PILOT_KEY,
      );
      const raw = stored?.[ExtensionState.LEGACY_TEST_PILOT_KEY] as
        | TestPilotCatalog
        | undefined;
      if (raw && typeof raw === "object" && Array.isArray(raw.sections)) {
        this.legacyTestPilotCatalog = raw;
      }
    } catch {
      // storage missing (test env) — defaults are fine
    }
  }

  /** Wipe in-memory Test Pilot state. Used when switching companions or
   *  dropping into standalone — the previous project's catalog, pending
   *  fetches, timers, and error all belong to that project, not this
   *  one. Persisted catalog is untouched (lives in chrome.storage). */
  private resetTestPilotState(): void {
    for (const id of Object.keys(this.testPilot.pendingDetails)) {
      this.clearDetailTimer(id);
    }
    this.clearTestPilotTimeout();
    this.testPilot.catalog = null;
    this.testPilot.pending = null;
    this.testPilot.pendingDetails = {};
    this.testPilot.error = null;
  }

  /** Hydrate Test Pilot state for the given companion. Pass null to
   *  enter standalone (clears state, no load). Idempotent. */
  async loadTestPilot(companion: Companion | null): Promise<void> {
    this.resetTestPilotState();
    if (!companion) return;
    const key = ExtensionState.testPilotKeyFor(companion);
    try {
      const stored = await chrome.storage?.local?.get(key);
      const raw = stored?.[key] as TestPilotCatalog | undefined;
      if (raw && typeof raw === "object" && Array.isArray(raw.sections)) {
        this.testPilot.catalog = raw;
        return;
      }
      // Legacy migration — the first companion picked after upgrade
      // inherits the pre-v0.3.2 global catalog. After this runs the
      // legacy key is gone and subsequent companion switches just see
      // empty state until they import their own.
      if (this.legacyTestPilotCatalog) {
        this.testPilot.catalog = this.legacyTestPilotCatalog;
        this.legacyTestPilotCatalog = null;
        await chrome.storage?.local?.set({
          [key]: $state.snapshot(this.testPilot.catalog),
        });
        await chrome.storage?.local?.remove(
          ExtensionState.LEGACY_TEST_PILOT_KEY,
        );
      }
    } catch {
      // storage missing (test env) — defaults are fine
    }
  }

  private async saveTestPilot(): Promise<void> {
    const companion = this.selectedCompanion;
    // Standalone has no project context to scope this catalog to.
    // Mutations from the UI shouldn't reach here in standalone (the
    // empty state hides the import/generate affordances), but if they
    // do, drop the write silently rather than leaking back into the
    // legacy global slot.
    if (!companion) return;
    const key = ExtensionState.testPilotKeyFor(companion);
    try {
      if (this.testPilot.catalog) {
        await chrome.storage?.local?.set({
          [key]: $state.snapshot(this.testPilot.catalog),
        });
      } else {
        await chrome.storage?.local?.remove(key);
      }
    } catch {
      // ignore
    }
  }

  /**
   * User imported a markdown test doc. Fire a one-shot
   * `module.query.submit` carrying the raw doc; the companion creates
   * a fresh ephemeral session, attaches a `kind: "query"` annotation
   * with the JSON-encoded request, and extracts the content to
   * `.pinta/test-docs/{docId}.md` for the agent to read. When the
   * agent calls `mark_session_done(id, payload)`, `onMessage` routes
   * the eventual `session.synced` into `testPilot.catalog`.
   */
  /**
   * Ask the agent to generate a fresh UAT markdown spec for the whole
   * app from project context, then return the parsed catalog. Same
   * result shape as importTestDoc — just no markdown to upload.
   */
  async generateTestDoc(): Promise<void> {
    if (!this.client || this.connectionStatus !== "connected") {
      this.testPilot.error =
        "No companion connected. Start `pinta-companion .` in your project to use Test Pilot.";
      return;
    }
    // Reuse the existing catalog's docId so the agent overwrites
    // `.pinta/test-docs/{docId}.md` in place — the file becomes a
    // maintained artifact across spec revisions. A fresh UUID is minted
    // only on the first generate (no prior catalog).
    const docId = this.testPilot.catalog?.docId ?? crypto.randomUUID();
    const url = this.lastUrl ?? "";
    this.testPilot.error = null;
    this.testPilot.pending = {
      kind: "doc-generate",
      sessionId: "",
      startedAt: Date.now(),
    };
    this.armTestPilotTimeout();
    const queryComment = JSON.stringify({ op: "generate-doc", docId });
    const settings = this.modules["test-pilot"]?.settings ?? {};
    this.send({
      type: "module.query.submit",
      url,
      moduleId: "test-pilot",
      moduleSettings: settings,
      queryComment,
    });
  }

  async importTestDoc(filename: string, content: string): Promise<void> {
    if (!this.client || this.connectionStatus !== "connected") {
      this.testPilot.error =
        "No companion connected. Start `pinta-companion .` in your project to use Test Pilot.";
      return;
    }
    // Same rationale as generateTestDoc — reuse the existing docId so a
    // re-import overwrites `.pinta/test-docs/{docId}.md` in place. The
    // companion's `extractTestDocContent` writes the new content; with
    // a stable docId, no orphan files accumulate.
    const docId = this.testPilot.catalog?.docId ?? crypto.randomUUID();
    const url = this.lastUrl ?? "";
    this.testPilot.error = null;
    this.testPilot.pending = { kind: "doc-parse", sessionId: "", filename };
    this.armTestPilotTimeout();
    const queryComment = JSON.stringify({
      op: "doc-parse",
      docId,
      filename,
      content,
    });
    const settings = this.modules["test-pilot"]?.settings ?? {};
    this.send({
      type: "module.query.submit",
      url,
      moduleId: "test-pilot",
      moduleSettings: settings,
      queryComment,
    });
  }

  /**
   * User clicked the "?" on a test row in the catalog. Fire another
   * query session with `op: "detail-steps"` and the test id.
   *
   * `overrideDetailedSteps` lets the detail view's inline "Details"
   * checkbox flip verbosity per re-ask without permanently changing
   * the module-wide setting. Pass undefined (default) to honor the
   * module's `detailed_steps` setting verbatim.
   */
  async fetchDetailSteps(
    testId: string,
    opts: { overrideDetailedSteps?: boolean } = {},
  ): Promise<void> {
    if (!this.client || this.connectionStatus !== "connected") {
      this.testPilot.error =
        "No companion connected. Start `pinta-companion .` in your project to use Test Pilot.";
      return;
    }
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    // Already in flight — don't double-submit (e.g. user clicked ? while
    // the spinner was still running on that same row).
    if (this.testPilot.pendingDetails[testId]) return;
    let section: TestPilotSection | null = null;
    for (const s of catalog.sections) {
      if (s.tests.some((t) => t.id === testId)) {
        section = s;
        break;
      }
    }
    if (!section) return;
    const url = this.lastUrl ?? "";
    this.testPilot.error = null;
    this.testPilot.pendingDetails[testId] = { askedAt: Date.now() };
    this.armDetailTimeout(testId);
    // Compute the effective verbosity for this specific call. Overrides
    // win; otherwise honor the module-wide setting.
    const baseSettings = this.modules["test-pilot"]?.settings ?? {};
    const effectiveDetailed =
      opts.overrideDetailedSteps !== undefined
        ? opts.overrideDetailedSteps
        : baseSettings.detailed_steps === true;
    // Carry the verbosity in BOTH the queryComment AND the module
    // settings. The queryComment is the canonical per-call signal the
    // agent reads first (single-place lookup, can't drift if the agent
    // misses the deeper modules[].settings path). modules[].settings
    // keeps backward-compat with the original wire contract.
    const queryComment = JSON.stringify({
      op: "detail-steps",
      docId: catalog.docId,
      testId,
      sectionTitle: section.title,
      detailedSteps: effectiveDetailed,
    });
    const settings: Record<string, string | boolean> = {
      ...baseSettings,
      detailed_steps: effectiveDetailed,
    };
    this.send({
      type: "module.query.submit",
      url,
      moduleId: "test-pilot",
      moduleSettings: settings,
      queryComment,
    });
  }

  /** Cancel an in-flight detail fetch (user clicked Cancel under the
   *  spinner). Removes the entry and clears its timer. */
  cancelDetailFetch(testId: string): void {
    if (!this.testPilot.pendingDetails[testId]) return;
    this.clearDetailTimer(testId);
    delete this.testPilot.pendingDetails[testId];
  }

  private armDetailTimeout(testId: string): void {
    this.clearDetailTimer(testId);
    const t = setTimeout(() => {
      if (!this.testPilot.pendingDetails[testId]) return;
      delete this.testPilot.pendingDetails[testId];
      this.detailTimers.delete(testId);
      this.testPilot.error =
        `Timed out waiting for the agent to get steps for ${testId}. ` +
        `Make sure \`/pinta\` is running in a Claude Code terminal for this project, then try again.`;
    }, ExtensionState.TEST_PILOT_TIMEOUT_MS);
    this.detailTimers.set(testId, t);
  }

  private clearDetailTimer(testId: string): void {
    const t = this.detailTimers.get(testId);
    if (t) {
      clearTimeout(t);
      this.detailTimers.delete(testId);
    }
  }

  /** User clicked Cancel on a stuck Test Pilot spinner. */
  cancelTestPilotPending(): void {
    if (!this.testPilot.pending) return;
    this.clearTestPilotTimeout();
    this.testPilot.pending = null;
    this.testPilot.error = "Cancelled.";
  }

  /**
   * Arm a fresh timeout for the current `testPilot.pending`. If it
   * fires, the user gets a recovery message explaining the most
   * common cause (no `/pinta` agent listening). doc-generate uses a
   * much longer ceiling because a full-app scan is legitimately slow.
   */
  private armTestPilotTimeout(): void {
    this.clearTestPilotTimeout();
    const pending = this.testPilot.pending;
    if (!pending) return;
    const ms =
      pending.kind === "doc-generate"
        ? ExtensionState.TEST_PILOT_GENERATE_TIMEOUT_MS
        : ExtensionState.TEST_PILOT_TIMEOUT_MS;
    this.testPilotTimer = setTimeout(() => {
      if (!this.testPilot.pending) return;
      const what =
        this.testPilot.pending.kind === "doc-parse"
          ? "parse the test doc"
          : this.testPilot.pending.kind === "doc-generate"
            ? "generate the test spec"
            : "get the test steps";
      this.testPilot.pending = null;
      this.testPilot.error =
        `Timed out waiting for the agent to ${what}. ` +
        `Make sure \`/pinta\` is running in a Claude Code terminal for this project, then try again.`;
    }, ms);
  }

  private clearTestPilotTimeout(): void {
    if (this.testPilotTimer) {
      clearTimeout(this.testPilotTimer);
      this.testPilotTimer = null;
    }
  }

  /**
   * Fetch with a hard timeout via AbortController. Without this, a
   * hung companion (FD-leak, blocked event loop, antivirus stalling
   * the socket) wedges every caller's UI spinner forever.
   */
  private static async fetchWithTimeout(
    input: RequestInfo,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = 8_000, ...rest } = init;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(input, { ...rest, signal: ctrl.signal });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Centralized setter for `creatingSession` that pairs the flag with a
   * recovery timer. When set true, schedules a 10s fallback that clears
   * the flag and surfaces an error — guards against the wedge where
   * the companion is reachable but never echoes back `session.created`
   * (e.g. mid-crash, broken pipe).
   */
  private markCreatingSession(active: boolean, reason?: string): void {
    if (this.creatingSessionTimer) {
      clearTimeout(this.creatingSessionTimer);
      this.creatingSessionTimer = null;
    }
    this.creatingSession = active;
    if (!active) return;
    this.creatingSessionTimer = setTimeout(() => {
      if (!this.creatingSession) return;
      this.creatingSession = false;
      this.creatingSessionTimer = null;
      this.lastError =
        reason ??
        "Couldn't start a session — the companion didn't respond. Check that pinta-companion is running.";
    }, ExtensionState.CREATE_SESSION_TIMEOUT_MS);
  }

  setTestStatus(testId: string, status: TestPilotStatus): void {
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    for (const section of catalog.sections) {
      for (const t of section.tests) {
        if (t.id === testId) {
          t.status = status;
          void this.saveTestPilot();
          return;
        }
      }
    }
  }

  /**
   * Set / clear the tester comment on a test row. Empty / whitespace-
   * only strings collapse to `undefined` so the field stays absent in
   * the catalog JSON instead of saving `""` everywhere.
   */
  setTestComment(testId: string, comment: string): void {
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    const normalized = comment.trim() === "" ? undefined : comment;
    for (const section of catalog.sections) {
      for (const t of section.tests) {
        if (t.id === testId) {
          if (normalized === undefined) delete t.comment;
          else t.comment = normalized;
          void this.saveTestPilot();
          return;
        }
      }
    }
  }

  // ─── Phase 13 — manual catalog editing ─────────────────────────────
  //
  // The companion's `.pinta/test-docs/{docId}.md` is the source of truth
  // for which rows exist + their wording. Every mutator below mutates
  // the in-memory `testPilot.catalog` (Svelte 5 picks up the $state
  // reactivity), persists to `chrome.storage.local` via
  // `saveTestPilot()`, then PUTs the composed-back markdown to the
  // companion so the agent's `?` (detail-steps) flow works against
  // user-added rows and edits survive regen.

  /**
   * Single in-flight PUT promise — concurrent edits chain via `.then()`
   * so the file on disk is always written in the order the user made
   * the changes. Without this, rapid-fire add-delete-add could race
   * and leave the on-disk spec in a state that doesn't match the UI.
   */
  private testDocPushChain: Promise<void> = Promise.resolve();

  /**
   * Compose the current catalog back to markdown for round-tripping to
   * the companion. Delegates to a pure helper in `test-pilot-doc.ts`
   * so the logic is unit-testable without booting the state class /
   * chrome.* surface. No-op when no catalog is loaded.
   */
  private composeTestDocMarkdown(): string {
    const c = this.testPilot.catalog;
    if (!c) return "";
    // Strip the Svelte 5 reactive proxy before passing — the pure
    // helper only needs the raw shape.
    return composeTestDocMarkdownPure($state.snapshot(c) as TestPilotCatalog);
  }

  /**
   * Push the composed catalog to the companion. Fire-and-forget but
   * serialized via `testDocPushChain` so writes never race. On
   * companion failure, surfaces `testPilot.error`; the browser-side
   * edit still stands and the next successful edit re-PUTs the full
   * file (each PUT is a full replacement, no reconciliation needed).
   */
  private pushTestDocToCompanion(): void {
    const c = this.testPilot.catalog;
    if (!c) return;
    const docId = c.docId;
    const base = this.httpBase();
    if (!base) return; // standalone mode — no disk sync, just in-memory + chrome.storage.
    const content = this.composeTestDocMarkdown();
    this.testDocPushChain = this.testDocPushChain
      .catch(() => {
        // swallow prior errors so a single failure doesn't poison the
        // whole chain — each PUT is independent.
      })
      .then(async () => {
        try {
          const res = await ExtensionState.fetchWithTimeout(
            `${base}/v1/test-docs/${encodeURIComponent(docId)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content }),
              timeoutMs: 8_000,
            },
          );
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(
              `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
            );
          }
          // Clear any stale sync error from a prior failure now that
          // we know the companion is reachable again.
          if (this.testPilot.error?.startsWith("Couldn't sync spec")) {
            this.testPilot.error = null;
          }
        } catch (err) {
          this.testPilot.error = `Couldn't sync spec to disk: ${(err as Error).message}`;
        }
      });
  }

  /**
   * Compute the next free `USER-N` id. Delegates to `test-pilot-doc.ts`
   * so the logic is unit-tested in isolation. Returns `USER-1` for an
   * empty catalog (used when this is called before any catalog exists).
   */
  private nextUserTestId(): string {
    const c = this.testPilot.catalog;
    if (!c) return "USER-1";
    return nextUserTestIdPure($state.snapshot(c) as TestPilotCatalog);
  }

  /**
   * Find a section by title. Returns the index too so callers can do
   * reorder math without re-scanning. Returns null if not found.
   */
  private findSection(
    title: string,
  ): { idx: number; section: TestPilotSection } | null {
    const c = this.testPilot.catalog;
    if (!c) return null;
    const idx = c.sections.findIndex((s) => s.title === title);
    if (idx === -1) return null;
    return { idx, section: c.sections[idx]! };
  }

  /**
   * Find a test by id across all sections. Returns the indexes too so
   * callers can do reorder math without re-scanning.
   */
  private findTest(
    testId: string,
  ): { sIdx: number; tIdx: number; section: TestPilotSection; test: TestPilotTest } | null {
    const c = this.testPilot.catalog;
    if (!c) return null;
    for (let i = 0; i < c.sections.length; i++) {
      const section = c.sections[i]!;
      const tIdx = section.tests.findIndex((t) => t.id === testId);
      if (tIdx !== -1) {
        return { sIdx: i, tIdx, section, test: section.tests[tIdx]! };
      }
    }
    return null;
  }

  /** After any catalog mutation, fan-out to local persistence + disk
   *  sync. Single call site means we never forget either step. */
  private commitCatalogEdit(): void {
    void this.saveTestPilot();
    this.pushTestDocToCompanion();
  }

  /** Append a new section to the catalog. Title may be empty — the
   *  UI sets `editingField = "section:"` immediately after to focus
   *  the inline input for typing. */
  addTestPilotSection(title: string): void {
    const c = this.testPilot.catalog;
    if (!c) return;
    c.sections.push({ title, tests: [] });
    this.commitCatalogEdit();
  }

  /** Rename a section by current title. No-op on collision (two
   *  sections sharing a title would break the title-keyed lookup). */
  renameTestPilotSection(oldTitle: string, newTitle: string): void {
    if (oldTitle === newTitle) return;
    const found = this.findSection(oldTitle);
    if (!found) return;
    const c = this.testPilot.catalog!;
    if (c.sections.some((s, i) => i !== found.idx && s.title === newTitle)) {
      this.testPilot.error = `A section named "${newTitle}" already exists.`;
      return;
    }
    found.section.title = newTitle;
    this.commitCatalogEdit();
  }

  /** Remove a section and every test inside it. */
  removeTestPilotSection(title: string): void {
    const found = this.findSection(title);
    if (!found) return;
    this.testPilot.catalog!.sections.splice(found.idx, 1);
    this.commitCatalogEdit();
  }

  /** Move a section up or down within the catalog. No-op at
   *  boundaries (no wraparound). */
  moveTestPilotSection(title: string, direction: "up" | "down"): void {
    const found = this.findSection(title);
    if (!found) return;
    const sections = this.testPilot.catalog!.sections;
    const newIdx = direction === "up" ? found.idx - 1 : found.idx + 1;
    if (newIdx < 0 || newIdx >= sections.length) return;
    const [moved] = sections.splice(found.idx, 1);
    sections.splice(newIdx, 0, moved!);
    this.commitCatalogEdit();
  }

  /** Append a test to the named section. Auto-mints a `USER-N` id if
   *  the caller didn't supply one. `test`/`expected` default to empty
   *  strings so the UI can drop the user into inline-edit mode. */
  addTestPilotTest(
    sectionTitle: string,
    input: { id?: string; test?: string; expected?: string },
  ): string | null {
    const found = this.findSection(sectionTitle);
    if (!found) return null;
    const id = input.id ?? this.nextUserTestId();
    found.section.tests.push({
      id,
      test: input.test ?? "",
      expected: input.expected ?? "",
      status: "untested",
    });
    this.commitCatalogEdit();
    return id;
  }

  /** Patch a test's `test` (title) or `expected` fields. Ignores
   *  empty/undefined patch values — pass empty string explicitly to
   *  clear a field. */
  updateTestPilotTest(
    testId: string,
    patch: { test?: string; expected?: string },
  ): void {
    const found = this.findTest(testId);
    if (!found) return;
    if (patch.test !== undefined) found.test.test = patch.test;
    if (patch.expected !== undefined) found.test.expected = patch.expected;
    this.commitCatalogEdit();
  }

  /** Remove a test from its containing section. */
  removeTestPilotTest(testId: string): void {
    const found = this.findTest(testId);
    if (!found) return;
    found.section.tests.splice(found.tIdx, 1);
    this.commitCatalogEdit();
  }

  /** Move a test up or down within its section. No-op at boundaries.
   *  Cross-section moves are explicitly out of scope for v1. */
  moveTestPilotTest(testId: string, direction: "up" | "down"): void {
    const found = this.findTest(testId);
    if (!found) return;
    const newIdx = direction === "up" ? found.tIdx - 1 : found.tIdx + 1;
    if (newIdx < 0 || newIdx >= found.section.tests.length) return;
    const [moved] = found.section.tests.splice(found.tIdx, 1);
    found.section.tests.splice(newIdx, 0, moved!);
    this.commitCatalogEdit();
  }

  /** UI signals an inline edit is in flight so an incoming catalog
   *  payload (e.g. user re-runs Generate mid-edit) doesn't clobber it.
   *  Side panel calls this on startEditing/commitEdit/cancelEdit. */
  setTestPilotEditingActive(active: boolean): void {
    this.testPilot.editingActive = active;
  }

  // ─── /Phase 13 ──────────────────────────────────────────────────────

  /** Render a markdown report from the current catalog. */
  exportResults(): string {
    const c = this.testPilot.catalog;
    if (!c) return "# Test Pilot — no catalog loaded\n";
    let pass = 0,
      fail = 0,
      untested = 0;
    for (const s of c.sections) {
      for (const t of s.tests) {
        if (t.status === "pass") pass++;
        else if (t.status === "fail") fail++;
        else untested++;
      }
    }
    const total = pass + fail + untested;
    const today = new Date().toISOString().slice(0, 10);
    const heading = c.title?.trim() || c.filename;
    let out = `# Test Pilot results — ${heading}\n`;
    const metaBits: string[] = [`Run on ${today}`];
    if (c.author?.trim()) metaBits.push(`by ${c.author.trim()}`);
    metaBits.push(
      `${pass}/${total} passed, ${fail} failed, ${untested} untested`,
    );
    out += `_${metaBits.join(", ")}_\n\n`;
    if (c.description?.trim()) out += `${c.description.trim()}\n\n`;
    for (const s of c.sections) {
      out += `## ${s.title}\n\n`;
      out += `| ID | Test | Expected | Result |\n`;
      out += `|----|------|----------|--------|\n`;
      const notes: { id: string; comment: string }[] = [];
      for (const t of s.tests) {
        const result =
          t.status === "pass"
            ? "✓ Pass"
            : t.status === "fail"
              ? "✗ Fail"
              : "⚠ Untested";
        const id = t.id.replace(/\|/g, "\\|");
        const test = t.test.replace(/\|/g, "\\|").replace(/\n/g, " ");
        const expected = t.expected.replace(/\|/g, "\\|").replace(/\n/g, " ");
        // Note marker — appends a `[note]` superscript next to the
        // result so readers know to scroll to the notes block. Keeps
        // the table itself one row per test (multi-line comments
        // would break Markdown table rendering).
        const resultCell = t.comment ? `${result} [note]` : result;
        out += `| ${id} | ${test} | ${expected} | ${resultCell} |\n`;
        if (t.comment) notes.push({ id: t.id, comment: t.comment });
      }
      out += `\n`;
      if (notes.length > 0) {
        out += `**Notes**\n\n`;
        for (const n of notes) {
          // Indent multi-line comments under the bullet so they hang
          // correctly in rendered markdown. Single-line comments stay
          // on one line.
          const lines = n.comment.split(/\r?\n/);
          out += `- \`${n.id}\` — ${lines[0]}\n`;
          for (let i = 1; i < lines.length; i++) {
            out += `  ${lines[i]}\n`;
          }
        }
        out += `\n`;
      }
    }
    return out;
  }

  clearTestPilot(): void {
    this.clearTestPilotTimeout();
    this.testPilot.catalog = null;
    this.testPilot.pending = null;
    this.testPilot.error = null;
    void this.saveTestPilot();
    // Also wipe the on-disk copy of the spec. UAT docs often contain
    // real credentials / internal URLs — leaving them lying around in
    // .pinta/test-docs/ after the user has cleared the catalog is a
    // surprise leak. Fire-and-forget; companion absence is fine.
    const base = this.httpBase();
    if (base) {
      void ExtensionState.fetchWithTimeout(`${base}/v1/test-docs`, {
        method: "DELETE",
        timeoutMs: 5_000,
      }).catch(() => {
        // best effort — disk cleanup failure isn't actionable in the UI
      });
    }
  }

  // ─── Modules (built-in integrations like GitLab Issues) ─────────────

  private static readonly MODULES_KEY = "pinta-modules";

  /** Pull module enable/settings from chrome.storage.local. */
  async loadModules(): Promise<void> {
    try {
      const stored = await chrome.storage?.local?.get(
        ExtensionState.MODULES_KEY,
      );
      const raw = stored?.[ExtensionState.MODULES_KEY] as
        | typeof this.modules
        | undefined;
      if (raw && typeof raw === "object") {
        this.modules = raw;
      }
    } catch {
      // storage missing (test env) — defaults are fine
    }
  }

  private async saveModules(): Promise<void> {
    try {
      await chrome.storage?.local?.set({
        [ExtensionState.MODULES_KEY]: $state.snapshot(this.modules),
      });
    } catch {
      // ignore — non-fatal, in-memory state still wins
    }
  }

  /** Initialize a missing module entry with defaults from its spec. */
  private ensureModuleEntry(spec: ModuleSpec): void {
    if (this.modules[spec.id]) return;
    const settings: Record<string, string | boolean> = {};
    for (const field of spec.settings) {
      if (field.default !== undefined) settings[field.key] = field.default;
    }
    this.modules[spec.id] = { enabled: false, settings };
  }

  setModuleEnabled(id: string, enabled: boolean): void {
    const spec = getModuleSpec(id);
    if (!spec) return;
    this.ensureModuleEntry(spec);
    this.modules[id]!.enabled = enabled;
    if (!enabled) {
      // Untick it for the current submit too — having a disabled module
      // still queued would be confusing.
      delete this.tickedModules[id];
    }
    void this.saveModules();
  }

  setModuleSetting(
    id: string,
    key: string,
    value: string | boolean,
  ): void {
    const spec = getModuleSpec(id);
    if (!spec) return;
    this.ensureModuleEntry(spec);
    this.modules[id]!.settings[key] = value;
    void this.saveModules();
    // Flipping `detailed_steps` should make the next test-row open
    // re-fetch fresh steps — otherwise the cached `test.detail` from
    // the previous mode would hide the change from the user.
    if (id === "test-pilot" && key === "detailed_steps") {
      const catalog = this.testPilot.catalog;
      if (catalog) {
        for (const section of catalog.sections) {
          for (const t of section.tests) delete t.detail;
        }
        void this.saveTestPilot();
      }
    }
  }

  /** True iff the module is enabled AND every required setting is filled. */
  moduleReady(id: string): boolean {
    const spec = getModuleSpec(id);
    const entry = this.modules[id];
    if (!spec || !entry || !entry.enabled) return false;
    return moduleIsConfigured(spec, entry.settings);
  }

  setModuleTicked(id: string, ticked: boolean): void {
    if (ticked) this.tickedModules[id] = true;
    else delete this.tickedModules[id];
  }

  /** Compose the SessionModule[] payload for a submit, picking only
   *  ready + ticked modules. Returns undefined when nothing is active so
   *  the field is omitted from the wire instead of appearing as an
   *  empty array. */
  buildSessionModules(): SessionModule[] | undefined {
    const out: SessionModule[] = [];
    for (const spec of BUILTIN_MODULES) {
      if (!this.tickedModules[spec.id]) continue;
      if (!this.moduleReady(spec.id)) continue;
      const settings = this.modules[spec.id]?.settings ?? {};
      out.push({
        id: spec.id,
        // Snapshot strips Svelte 5 reactive proxies before crossing the
        // structuredClone boundary on chrome.runtime / fetch().
        settings: $state.snapshot(settings) as Record<
          string,
          string | boolean
        >,
      });
    }
    return out.length > 0 ? out : undefined;
  }

  /** Reset per-session ticked modules. Called on each new session start
   *  so the user has to re-tick (matches autoApply / includeScreenshot
   *  behavior). */
  resetTickedModules(): void {
    this.tickedModules = {};
  }

  // ─── /Modules ───────────────────────────────────────────────────────

  /** Reload imported sessions from IndexedDB. Called on start and after
   *  any add/remove so the History panel stays in sync. */
  async refreshImported(): Promise<void> {
    try {
      this.importedSessions = await getImportedSessions();
    } catch (err) {
      this.lastError = `imported sessions read failed: ${(err as Error).message}`;
    }
  }

  /** Import a `.pinta` share file or a Pinta-exported `.md` markdown
   *  file. Parses + validates, persists to IDB, refreshes the in-memory
   *  list. Routes by file extension; falls back to a JSON sniff if the
   *  extension is missing or wrong. Throws on validation failure so the
   *  caller can toast. */
  async importPintaFile(file: File): Promise<ImportedSession> {
    const text = await file.text();
    const name = file.name.toLowerCase();
    const isMarkdown =
      name.endsWith(".md") ||
      name.endsWith(".markdown") ||
      (!name.endsWith(".pinta") && !text.trimStart().startsWith("{"));
    const imported = isMarkdown ? decodePintaMarkdown(text) : decodePintaFile(text);
    await addImportedSession(imported);
    await this.refreshImported();
    return imported;
  }

  async removeImported(id: string): Promise<void> {
    await removeImportedSession(id).catch((err) => {
      this.lastError = `imported session delete failed: ${(err as Error).message}`;
    });
    if (this.viewingImportedId === id) this.viewingImportedId = null;
    await this.refreshImported();
  }

  /**
   * Wipe both local (companion-side) and imported (IDB-side) session
   * history. The companion preserves the drafting session if one is
   * active, so the user doesn't lose work in flight. Best-effort on each
   * leg — one failure doesn't block the other.
   */
  async clearAllHistory(): Promise<void> {
    const base = this.httpBase();
    if (base) {
      try {
        const res = await ExtensionState.fetchWithTimeout(`${base}/v1/sessions`, {
          method: "DELETE",
          timeoutMs: 8_000,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
        }
      } catch (err) {
        this.lastError = `clear sessions failed: ${(err as Error).message}`;
      }
    }
    try {
      await clearImportedSessions();
      this.viewingImportedId = null;
    } catch (err) {
      this.lastError = `clear imported failed: ${(err as Error).message}`;
    }
    await this.refreshImported();
  }

  /** Open the read-only viewer for an imported session. */
  viewImported(id: string): void {
    if (!this.importedSessions.some((s) => s.id === id)) return;
    this.viewingImportedId = id;
  }

  /**
   * Submit an imported session to the connected companion as a brand-new
   * already-submitted session — the agent picks it up like any other
   * submission and applies the changes. The user's active draft is left
   * alone (no clobber). Connected mode only.
   *
   * Returns the new session id on success so callers can show a toast
   * with a link / pointer; throws on transport failure.
   */
  async sendImportedToAgent(
    id: string,
    opts: { autoApply?: boolean } = {},
  ): Promise<string | null> {
    const imported = this.importedSessions.find((s) => s.id === id);
    if (!imported) return null;
    const base = this.httpBase();
    if (!base) {
      this.lastError =
        "Send to agent requires a connected companion. Switch projects from the picker, or use Fork in standalone mode.";
      return null;
    }
    const now = Date.now();
    const payload: Session = {
      id: crypto.randomUUID(),
      url: this.lastUrl ?? imported.session.url,
      projectRoot: "",
      startedAt: now,
      submittedAt: now,
      // Fresh annotation ids so per-annotation status updates from the
      // agent don't collide with anything in the source-side history.
      annotations: imported.session.annotations.map((a) => ({
        ...a,
        id: uid("ann"),
        status: undefined,
        errorMessage: undefined,
      })),
      fullPageScreenshot: imported.session.fullPageScreenshot,
      status: "submitted",
      // Reuse the existing 'test' producer rather than adding a new
      // enum value — the wire contract stays narrow, and the agent
      // already handles 'test' submissions identically to extension ones.
      producer: "test",
      autoApply: opts.autoApply,
      // Modules ride along with imported sessions too — recipients of a
      // shared `.pinta` may want to file the friend's annotations as
      // GitLab issues against their *own* project. Modules are stripped
      // from share-file exports, so configuration is always the
      // recipient's own.
      modules: this.buildSessionModules(),
    };
    try {
      const res = await ExtensionState.fetchWithTimeout(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: 8_000,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
      }
      return payload.id;
    } catch (err) {
      this.lastError = `send to agent failed: ${(err as Error).message}`;
      return null;
    }
  }

  /** Close the read-only viewer. */
  closeImportedViewer(): void {
    this.viewingImportedId = null;
  }

  /**
   * Clone an imported session into a new editable standalone session
   * for the current origin. Annotations get fresh ids so the fork
   * doesn't collide with anything in the source agent's tracking. The
   * fork lands as the active draft for the current URL.
   */
  /**
   * Result of a fork attempt. `would-overwrite` means the active draft
   * has unsaved annotations — the caller must re-invoke with
   * `allowOverwrite: true` (typically after a `window.confirm`) to
   * actually replace it. This guard exists because the cloned session
   * is written through to IndexedDB at the same origin key as the
   * existing draft, irreversibly clobbering it.
   */
  async forkImportedToLocal(
    id: string,
    opts: { allowOverwrite?: boolean } = {},
  ): Promise<"forked" | "would-overwrite" | "no-op"> {
    const imported = this.importedSessions.find((s) => s.id === id);
    if (!imported) return "no-op";
    if (this.appMode !== "standalone" || !this.currentOrigin) {
      this.lastError =
        "fork is only available in standalone mode (no companion selected)";
      return "no-op";
    }
    if (
      !opts.allowOverwrite &&
      this.session &&
      this.session.annotations.length > 0
    ) {
      return "would-overwrite";
    }
    const url = this.lastUrl ?? imported.session.url;
    const cloned: Session = {
      id: crypto.randomUUID(),
      url,
      projectRoot: "",
      startedAt: Date.now(),
      annotations: imported.session.annotations.map((a) => ({
        ...a,
        id: uid("ann"),
        // Drop any agent-set lifecycle so the forked annotations start
        // fresh — they haven't been picked up in this project yet.
        status: undefined,
        errorMessage: undefined,
      })),
      status: "drafting",
      producer: "extension",
    };
    this.session = cloned;
    this.viewingImportedId = null;
    await saveLocal(this.currentOrigin, $state.snapshot(cloned) as Session).catch(
      (err) => {
        this.lastError = `local store write failed: ${(err as Error).message}`;
      },
    );
    return "forked";
  }

  stop(): void {
    this.client?.stop();
    this.client = null;
    this.connectionStatus = "disconnected";
  }

  /**
   * Re-evaluate routing for the current tab URL.
   *
   * Fast-path: if `force` is false (the navigation case) and the active
   * tab still matches the currently-selected companion's URL patterns,
   * skip the port scan entirely. SPAs that route via pushState fire
   * `chrome.tabs.onUpdated` repeatedly during a single user navigation,
   * and re-probing 21 ports on each event was wasted work whenever the
   * destination was still inside the same project.
   *
   * Manual rescan triggers (the "↻ Rescan" button) pass `force = true`
   * so the scan still discovers newly-started companions.
   */
  async rescan(
    activeTabUrl: string | null = this.lastUrl,
    force: boolean = false,
  ): Promise<void> {
    if (
      !force &&
      this.selectedCompanion &&
      activeTabUrl &&
      this.selectedCompanion.urlPatterns.length > 0 &&
      matchAny(activeTabUrl, this.selectedCompanion.urlPatterns)
    ) {
      // Routing context still resolves to the same companion. Update
      // the cached URL so future calls have an accurate baseline, but
      // don't burn the port-scan budget.
      this.lastUrl = activeTabUrl;
      return;
    }

    this.scanning = true;
    try {
      this.companions = await discoverCompanions();

      // Don't pre-wipe the standalone session here. Both follow-up paths
      // handle it themselves: connectTo() nulls `this.session` before the
      // new WS handshake, and hydrateStandalone() is idempotent for the
      // same origin. Pre-wiping caused the session.id $effect in App.svelte
      // (line ~854) to fire a transient `annotated.clear` to the content
      // script every time rescan ran on the same origin — which wiped all
      // on-page pin badges even though nothing about the session had
      // actually changed.

      // Honor the user's explicit "use standalone for this origin"
      // opt-in BEFORE anything else. Skips URL-match auto-routing and
      // the single-companion auto-pick fallback so a tab on a pinned
      // origin doesn't silently snap back to a companion when the
      // user navigates within it.
      const currentOrigin = originOf(activeTabUrl);
      if (currentOrigin && this.standaloneOrigins.has(currentOrigin)) {
        if (this.selectedCompanion) await this.connectTo(null);
        await this.hydrateStandalone(activeTabUrl);
        return;
      }

      const stillSelected = this.selectedCompanion
        ? this.companions.find(
            (c) => c.port === this.selectedCompanion!.port,
          ) ?? null
        : null;

      // The active tab URL is the source of truth for routing — even if
      // our current companion is alive, the user may have switched to a
      // tab that uniquely matches a *different* companion. Follow it.
      const urlMatch = activeTabUrl
        ? findCompanionForUrl(this.companions, activeTabUrl)
        : null;

      if (urlMatch && urlMatch.port !== this.selectedCompanion?.port) {
        // Tab URL points to a specific companion that isn't our current
        // selection. Switch — this is what makes the side panel "follow
        // the tab" between projects.
        await this.connectTo(urlMatch);
      } else if (!stillSelected) {
        // Current companion is gone and the URL doesn't disambiguate —
        // fall back to the auto-pick policy. Returns null if no auto-pick
        // is possible (zero companions, or many with no URL match).
        const next = this.pickCompanion(this.companions, activeTabUrl);
        await this.connectTo(next);
      } else if (
        activeTabUrl &&
        stillSelected.urlPatterns.length > 0 &&
        !matchAny(activeTabUrl, stillSelected.urlPatterns)
      ) {
        // Tab moved to a URL the current project doesn't claim, and no
        // other project claimed it either (urlMatch was null). Stay
        // connected so a multi-page draft survives — the user might be
        // briefly off-route inside the same review (e.g. opened a
        // /pricing page that the project's URL patterns don't list).
        // Each annotation carries its own `url` so attribution stays
        // correct even when added on a non-claimed page. Catch-all
        // companions (no urlPatterns) take this branch implicitly via
        // the predicate above.
      } else if (stillSelected !== this.selectedCompanion) {
        // Stay put but refresh the cached entry (urlPatterns may have
        // changed since last scan).
        this.selectedCompanion = stillSelected;
      }

      // Standalone fallback: routing landed on no companion (either
      // none exist, or none match and there's no auto-pick). Hydrate
      // the local session for the current origin so annotations have a
      // place to land.
      if (!this.selectedCompanion) {
        if (this.client) {
          this.client.stop();
          this.client = null;
          this.connectionStatus = "disconnected";
        }
        await this.hydrateStandalone(activeTabUrl);
      }
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Standalone mode: load (or leave empty for later creation) the session
   * for the current origin. Called from rescan when no companions exist.
   */
  private async hydrateStandalone(activeTabUrl: string | null): Promise<void> {
    const origin = originOf(activeTabUrl);
    if (!origin) {
      // Unsupported URL (chrome://, about:, etc.) — keep state cleared.
      this.session = null;
      this.currentOrigin = null;
      return;
    }
    if (this.currentOrigin === origin && this.session) return;
    this.currentOrigin = origin;
    try {
      const existing = await loadByOrigin(origin);
      this.session = existing ?? null;
    } catch (err) {
      this.lastError = `local store read failed: ${(err as Error).message}`;
      this.session = null;
    }
  }

  /** User picked a project from the dropdown — switch WS to that companion. */
  async select(companion: Companion | null): Promise<void> {
    await this.connectTo(companion);
    if (companion) {
      // User explicitly picked a companion — they want associated mode,
      // not standalone. Clear any pin on the current origin so rescans
      // honor the choice instead of pulling the rug.
      this.unpinOriginFromStandalone(originOf(this.lastUrl));
      try {
        await chrome.storage?.local?.set({ [SELECTED_KEY]: companion.projectRoot });
      } catch {
        // storage perm missing or quota issue — ignore, in-memory state still wins
      }
    }
  }

  /**
   * Auto-pick policy: URL pattern match wins; else, restored preference
   * if it's still running; else, the only companion if there's just one;
   * else, null (user must pick).
   */
  private pickCompanion(
    list: Companion[],
    url: string | null,
  ): Companion | null {
    if (list.length === 0) return null;
    if (url) {
      const match = findCompanionForUrl(list, url);
      if (match) return match;
    }
    if (list.length === 1) return list[0]!;
    return null;
  }

  private async connectTo(companion: Companion | null): Promise<void> {
    if (this.selectedCompanion?.port === companion?.port) return;
    // Switching projects: stale pin badges from the previous companion's
    // session would otherwise linger on the page until the user clicks
    // them. Clear them now so the overlay reflects the new companion's
    // (empty or restored) annotations only.
    const switchingBetweenProjects =
      this.selectedCompanion !== null && companion !== null;
    if (switchingBetweenProjects) await this.clearOverlayBadges();
    this.client?.stop();
    this.client = null;
    this.session = null;
    this.markCreatingSession(false);
    this.selectedCompanion = companion;
    // Swap Test Pilot catalogs to match. Standalone clears state
    // entirely (catalogs are scoped per project — there's nothing to
    // show without one). loadTestPilot handles both branches.
    void this.loadTestPilot(companion);
    if (!companion) {
      this.connectionStatus = "disconnected";
      return;
    }
    this.client = new WsClient({
      url: `ws://127.0.0.1:${companion.port}/`,
      onMessage: (msg) => this.onMessage(msg),
      onStatusChange: (status) => {
        this.connectionStatus = status;
        // When the WS disconnects mid-create, the companion will never
        // echo back the session-created response that clears the flag.
        // Drop the flag here so the user can retry instead of being
        // stuck on a no-op spinner.
        if (status === "disconnected" && this.creatingSession) {
          this.markCreatingSession(false);
        }
      },
    });
    this.client.start();
  }

  /**
   * Tell the active tab's content script to drop all pin badges. Used
   * on companion switch so the previous project's badges don't leak
   * into the next project's view.
   */
  private async clearOverlayBadges(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id == null) return;
      await chrome.tabs
        .sendMessage(tab.id, { type: "annotated.clear" })
        .catch(() => {
          // content script not injected on this URL — nothing to clear
        });
    } catch {
      // chrome.tabs missing (test env) — ignore
    }
  }

  /**
   * URL of the HTTP API for the selected companion. Returns null when
   * no companion is selected — callers should guard.
   */
  httpBase(): string | null {
    if (!this.selectedCompanion) return null;
    return `http://127.0.0.1:${this.selectedCompanion.port}`;
  }

  send(msg: ClientMessage): void {
    this.client?.send(msg);
  }

  async ensureSession(url: string): Promise<void> {
    this.lastUrl = url;
    if (this.session || this.creatingSession) return;

    if (this.appMode === "standalone") {
      const origin = originOf(url);
      if (!origin) return;
      this.currentOrigin = origin;
      const existing = await loadByOrigin(origin).catch(() => null);
      if (existing) {
        this.session = existing;
        return;
      }
      const draft = newDraft(url);
      this.session = draft;
      // Snapshot before save — IndexedDB's structuredClone can't handle
      // Svelte 5 reactive proxies that wrap state objects.
      await saveLocal(origin, $state.snapshot(draft) as Session).catch((err) => {
        this.lastError = `local store write failed: ${(err as Error).message}`;
      });
      return;
    }

    if (!this.client) return;
    this.markCreatingSession(true);
    this.send({ type: "session.create", url });
  }

  async addAnnotation(annotation: Annotation): Promise<void> {
    // Adding a new annotation means the user has shifted from "looking
    // at someone else's session" to "working on their own". Close the
    // imported viewer so the annotation list they just contributed to is
    // actually visible — without this, the new card lands in
    // app.session.annotations but the viewer is rendered on top of it.
    if (this.viewingImportedId) this.viewingImportedId = null;
    // Stamp the page URL the annotation was created on so multi-page
    // sessions stay correctly attributed when the user navigates between
    // routes. Skill / GitLab module fall back to `session.url` if absent.
    const stamped: Annotation = {
      ...annotation,
      url: annotation.url ?? this.lastUrl ?? this.session?.url,
    };
    if (this.appMode === "standalone") {
      await this.mutateLocal((s) => ({
        ...s,
        annotations: [...s.annotations, stamped],
      }));
      return;
    }
    this.send({ type: "annotation.add", annotation: stamped });
  }

  async updateAnnotation(id: string, patch: Partial<Annotation>): Promise<void> {
    if (this.appMode === "standalone") {
      await this.mutateLocal((s) => ({
        ...s,
        annotations: s.annotations.map((a) =>
          a.id === id ? ({ ...a, ...patch } as Annotation) : a,
        ),
      }));
      return;
    }
    this.send({ type: "annotation.update", id, patch });
  }

  async removeAnnotation(id: string): Promise<void> {
    if (this.appMode === "standalone") {
      await this.mutateLocal((s) => ({
        ...s,
        annotations: s.annotations.filter((a) => a.id !== id),
      }));
      return;
    }
    this.send({ type: "annotation.remove", id });
  }

  submit(screenshot = "", autoApply?: boolean): void {
    // No-op in standalone — the side panel hides Submit there. Defensive
    // guard so a stray call (e.g. from a hotkey) doesn't crash.
    if (this.appMode === "standalone") return;
    const modules = this.buildSessionModules();
    this.send({
      type: "session.submit",
      screenshot,
      autoApply,
      modules,
    });
  }

  /**
   * Wipe the standalone session for the current origin and start a
   * fresh draft — equivalent of "Cancel and restart" in connected mode.
   * No-op in connected mode (callers should use `cancelAndRestart`).
   */
  async clearStandaloneSession(): Promise<void> {
    if (this.appMode !== "standalone" || !this.currentOrigin) return;
    const url = this.lastUrl ?? "";
    await clearLocal(this.currentOrigin).catch(() => {});
    this.session = null;
    if (url) await this.ensureSession(url);
  }

  /**
   * Apply a pure mutation to the local-mode session and persist. No-op
   * if there's no active session yet (caller should ensureSession first).
   */
  private async mutateLocal(
    fn: (s: Session) => Session,
  ): Promise<void> {
    if (!this.session || !this.currentOrigin) return;
    const next = fn(this.session);
    this.session = next;
    // Snapshot strips Svelte 5 reactive proxies — IndexedDB uses
    // structuredClone internally and chokes on them otherwise.
    await saveLocal(this.currentOrigin, $state.snapshot(next) as Session).catch(
      (err) => {
        this.lastError = `local store write failed: ${(err as Error).message}`;
      },
    );
  }

  /**
   * Cancel the current session and start a fresh one for the same URL.
   */
  async cancelAndRestart(url: string): Promise<void> {
    if (this.appMode === "standalone") {
      await this.clearStandaloneSession();
      return;
    }
    const current = this.session;
    const base = this.httpBase();
    if (current && current.status !== "drafting" && base) {
      try {
        await fetch(
          `${base}/v1/sessions/${encodeURIComponent(current.id)}/status`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "error",
              errorMessage: "canceled by user",
            }),
          },
        );
      } catch (err) {
        this.lastError = `cancel failed: ${(err as Error).message}`;
      }
    }
    this.session = null;
    this.markCreatingSession(true);
    // `force: true` tells the companion to discard any active drafting
    // session before creating a fresh one. Without it the server's
    // drafting-idempotency echoes the old session right back and the
    // annotations the user just cleared silently resurrect.
    this.send({ type: "session.create", url, force: true });
  }

  /**
   * Add a URL pattern to the selected companion's project. Returns the
   * full updated patterns list on success, throws on failure.
   */
  async associateUrl(pattern: string): Promise<string[]> {
    const base = this.httpBase();
    if (!base) throw new Error("no companion selected");
    const res = await ExtensionState.fetchWithTimeout(`${base}/v1/url-patterns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern }),
      timeoutMs: 5_000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let body: { urlPatterns: string[] };
    try {
      body = (await res.json()) as { urlPatterns: string[] };
    } catch {
      throw new Error("companion returned a non-JSON response");
    }
    // Update local cache so the picker reflects the change immediately.
    if (this.selectedCompanion) {
      this.selectedCompanion = {
        ...this.selectedCompanion,
        urlPatterns: body.urlPatterns,
      };
      this.companions = this.companions.map((c) =>
        c.port === this.selectedCompanion!.port ? this.selectedCompanion! : c,
      );
    }
    return body.urlPatterns;
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "module.query.created": {
        // Companion confirmed our interactive-module submit. Pin the
        // session id so the eventual session.synced for that id flows
        // into the right slot instead of stomping the annotation draft.
        // Detail-steps queries are tracked per-testId in pendingDetails
        // and identify themselves by the queryComment op — they don't
        // need to pin a sessionId here. Only doc-parse/doc-generate use
        // the singleton `pending` slot.
        if (
          msg.moduleId === "test-pilot" &&
          this.testPilot.pending &&
          !this.testPilot.pending.sessionId &&
          ExtensionState.queryOp(msg.session) !== "detail-steps"
        ) {
          this.testPilot.pending.sessionId = msg.session.id;
        }
        break;
      }
      case "session.created":
      case "session.synced": {
        // Route Test Pilot query session events away from the regular
        // annotation flow so the draft isn't disturbed. Detect by EITHER
        // the pinned sessionId OR the session.modules payload — the
        // companion's store.submit() notifyChange can broadcast
        // session.synced before the targeted module.query.created ack
        // arrives, leaving pending.sessionId still empty. Without the
        // modules-based fallback, the ephemeral test-pilot session
        // (status: submitted) replaces this.session here, sessionPending
        // flips true, and the page-edge processing pulse never stops
        // because handleTestPilotSync (run on the eventual done event)
        // doesn't touch this.session.status.
        const isInteractiveModuleSession =
          msg.session.modules?.some((m) => m.id === "test-pilot") ?? false;
        if (isInteractiveModuleSession) {
          // Concurrent detail-steps fetches live in pendingDetails,
          // keyed by testId pulled from the session's query annotation
          // — that's how we tell two parallel ? clicks apart.
          const op = ExtensionState.queryOp(msg.session);
          if (op === "detail-steps") {
            const testId = ExtensionState.queryField(msg.session, "testId");
            if (testId) this.handleDetailSync(msg.session, testId);
            return;
          }
        }
        if (
          this.testPilot.pending &&
          (this.testPilot.pending.sessionId === msg.session.id ||
            isInteractiveModuleSession)
        ) {
          if (!this.testPilot.pending.sessionId) {
            this.testPilot.pending.sessionId = msg.session.id;
          }
          this.handleTestPilotSync(msg.session);
          return;
        }
        const previousSessionId = this.session?.id ?? null;
        this.session = msg.session;
        this.markCreatingSession(false);
        this.lastError = null;
        // A new session started → drop ticked module checkboxes so the
        // user has to consciously opt in for the next submit. Mirrors
        // how autoApply / includeScreenshot behave per-batch.
        if (msg.session.id !== previousSessionId) {
          this.resetTickedModules();
        }
        break;
      }
      case "session.applying":
        if (this.session) this.session.status = "applying";
        break;
      case "session.done":
        if (this.session) {
          this.session.status = "done";
          this.session.appliedSummary = msg.summary;
        }
        break;
      case "error":
        this.lastError = msg.message;
        break;
    }
  }

  /** Pull a field from the first query annotation's JSON comment. The
   *  companion attaches a single `kind: "query"` annotation whose
   *  `comment` is the JSON we sent as `queryComment` — that's our only
   *  channel for correlating per-request data (testId, op) back through
   *  the WebSocket roundtrip. */
  private static queryField(session: Session, field: string): string | null {
    const annot = session.annotations.find((a) => a.kind === "query");
    if (!annot?.comment) return null;
    try {
      const parsed = JSON.parse(annot.comment) as Record<string, unknown>;
      const v = parsed[field];
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }
  private static queryOp(session: Session): string | null {
    return ExtensionState.queryField(session, "op");
  }

  /** Concurrent detail-steps response handler. Routed here when the
   *  session's query annotation says `op: "detail-steps"`. Looks up the
   *  pending entry by testId; if the user already cancelled (entry
   *  absent), the response is silently dropped. */
  private handleDetailSync(session: Session, testId: string): void {
    const entry = this.testPilot.pendingDetails[testId];
    if (!entry) return; // already cancelled / timed out
    if (session.status === "done") {
      this.clearDetailTimer(testId);
      const summary = session.appliedSummary ?? "";
      try {
        const payload = JSON.parse(summary) as {
          type?: string;
          [k: string]: unknown;
        };
        if (payload.type === "test-pilot-detail") {
          this.applyDetailResult(payload);
        } else {
          this.testPilot.error =
            "Agent returned an unrecognized response. Check the skill version.";
        }
      } catch (err) {
        this.testPilot.error = `Couldn't parse agent response: ${(err as Error).message}`;
      }
      delete this.testPilot.pendingDetails[testId];
    } else if (session.status === "error") {
      this.clearDetailTimer(testId);
      this.testPilot.error =
        session.errorMessage ?? `Test Pilot query failed for ${testId}.`;
      delete this.testPilot.pendingDetails[testId];
    }
  }

  /**
   * Route a Test Pilot query session's lifecycle into the testPilot
   * state slot. The session itself is ephemeral; we only care about
   * the final `status === "done"` payload (or an `error`).
   */
  private handleTestPilotSync(session: Session): void {
    if (!this.testPilot.pending) return;
    if (session.status === "done") {
      this.clearTestPilotTimeout();
      const summary = session.appliedSummary ?? "";
      try {
        const payload = JSON.parse(summary) as {
          type?: string;
          [k: string]: unknown;
        };
        if (payload.type === "test-pilot-catalog") {
          this.applyCatalogResult(payload);
        } else if (payload.type === "test-pilot-detail") {
          this.applyDetailResult(payload);
        } else {
          this.testPilot.error =
            "Agent returned an unrecognized response. Check the skill version.";
        }
      } catch (err) {
        this.testPilot.error = `Couldn't parse agent response: ${(err as Error).message}`;
      }
      this.testPilot.pending = null;
    } else if (session.status === "error") {
      this.clearTestPilotTimeout();
      this.testPilot.error =
        session.errorMessage ?? "Test Pilot query failed.";
      this.testPilot.pending = null;
    }
  }

  private applyCatalogResult(payload: { [k: string]: unknown }): void {
    // Phase 13 — bail if the user is mid-edit. An incoming catalog
    // payload would otherwise clobber the in-progress text they just
    // typed (inline title / expected / section rename). The pending
    // payload is dropped; the user is asked to commit or cancel and
    // re-trigger Generate.
    if (this.testPilot.editingActive) {
      this.testPilot.error =
        "A catalog update arrived while you were editing. Commit or cancel your edit, then click Generate / Re-import again.";
      this.testPilot.pending = null;
      return;
    }
    const sections = Array.isArray(payload.sections) ? payload.sections : [];
    const newDocId =
      typeof payload.docId === "string" ? payload.docId : crypto.randomUUID();
    // Carry over user-authored metadata when re-importing the same doc
    // so the user's title/author/description survive a Re-import click.
    const prior = this.testPilot.catalog;
    const sameDoc = prior && prior.docId === newDocId;
    const carry = sameDoc
      ? { title: prior.title, author: prior.author, description: prior.description }
      : {};
    // Id-keyed merge so Pass/Fail marks and cached per-row detail steps
    // survive across spec revisions. Same docId AND same test id means
    // the user already ran this scenario — keep their state. Genuinely
    // new ids come in untested; ids that disappear from the new spec
    // are dropped (the test no longer exists). Tradeoff: if the agent
    // ever renumbers an unchanged scenario, marks won't carry — the
    // SKILL.md generate-doc rules call this out and instruct the agent
    // to preserve stable ids during in-place regen.
    const priorById = new Map<string, TestPilotTest>();
    if (sameDoc) {
      for (const section of prior.sections) {
        for (const test of section.tests) {
          priorById.set(test.id, test);
        }
      }
    }
    const catalog: TestPilotCatalog = {
      docId: newDocId,
      filename:
        typeof payload.filename === "string"
          ? payload.filename
          : (this.testPilot.pending?.kind === "doc-parse"
              ? this.testPilot.pending.filename
              : this.testPilot.pending?.kind === "doc-generate"
                ? "generated-tests.md"
                : "test-spec.md"),
      importedAt: Date.now(),
      sections: sections.map((s: any) => ({
        title: String(s?.title ?? "Untitled"),
        tests: Array.isArray(s?.tests)
          ? s.tests.map((t: any) => {
              const id = String(t?.id ?? "??");
              const carriedOver = priorById.get(id);
              return {
                id,
                test: String(t?.test ?? ""),
                expected: String(t?.expected ?? ""),
                status: carriedOver?.status ?? ("untested" as TestPilotStatus),
                detail: carriedOver?.detail,
                // Preserve tester notes across re-imports of the same
                // doc — same policy as status / detail. Without this,
                // a Re-import wipes commentary the user wrote during
                // the previous run.
                comment: carriedOver?.comment,
              };
            })
          : [],
      })),
      ...carry,
    };
    this.testPilot.catalog = catalog;
    this.testPilot.error = null;
    void this.saveTestPilot();
  }

  /** Reset every test row in the active catalog to `untested` and drop
   *  cached per-row detail. Keeps the catalog structure intact (same
   *  sections, same test ids, same metadata) — the user gets a clean
   *  slate to re-run testing without losing the parsed spec or having
   *  to clear and re-import. Persists immediately. No-op when there's
   *  no catalog loaded. */
  clearTestPilotMarks(): void {
    const c = this.testPilot.catalog;
    if (!c) return;
    for (const section of c.sections) {
      for (const test of section.tests) {
        test.status = "untested";
        test.detail = undefined;
      }
    }
    void this.saveTestPilot();
  }

  /** Update the user-authored metadata on the active catalog. Empty
   *  strings are normalized to `undefined` so the UI can fall back to
   *  placeholders. Persists immediately. */
  setTestPilotMeta(patch: {
    title?: string;
    author?: string;
    description?: string;
  }): void {
    const c = this.testPilot.catalog;
    if (!c) return;
    const norm = (v: string | undefined) => {
      if (v === undefined) return undefined;
      const trimmed = v.trim();
      return trimmed === "" ? undefined : trimmed;
    };
    if ("title" in patch) c.title = norm(patch.title);
    if ("author" in patch) c.author = norm(patch.author);
    if ("description" in patch) c.description = norm(patch.description);
    void this.saveTestPilot();
  }

  private applyDetailResult(payload: { [k: string]: unknown }): void {
    const testId =
      typeof payload.testId === "string"
        ? payload.testId
        : this.testPilot.pending?.kind === "detail-steps"
          ? this.testPilot.pending.testId
          : null;
    if (!testId) return;
    const steps = Array.isArray(payload.steps)
      ? payload.steps.map((s) => String(s))
      : [];
    const catalog = this.testPilot.catalog;
    if (!catalog) return;
    for (const section of catalog.sections) {
      for (const t of section.tests) {
        if (t.id === testId) {
          t.detail = { steps, askedAt: Date.now() };
          this.testPilot.error = null;
          void this.saveTestPilot();
          return;
        }
      }
    }
  }
}

export const app = new ExtensionState();
