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
} from "./local-store.js";
import { decodePintaFile, decodePintaMarkdown } from "./pinta-file.js";
import { uid } from "./id.js";

const SELECTED_KEY = "pinta-selected-companion";

export type ExtensionMode = "draw" | "select" | "review" | "idle";

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

  private client: WsClient | null = null;
  private creatingSession = false;
  private lastUrl: string | null = null;
  /** Origin currently driving the standalone-mode session (IDB key). */
  private currentOrigin: string | null = null;

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
    await this.rescan(activeTabUrl);
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
      const res = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
    this.creatingSession = false;
    this.selectedCompanion = companion;
    if (!companion) {
      this.connectionStatus = "disconnected";
      return;
    }
    this.client = new WsClient({
      url: `ws://127.0.0.1:${companion.port}/`,
      onMessage: (msg) => this.onMessage(msg),
      onStatusChange: (status) => {
        this.connectionStatus = status;
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
    this.creatingSession = true;
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
    this.creatingSession = true;
    this.send({ type: "session.create", url });
  }

  /**
   * Add a URL pattern to the selected companion's project. Returns the
   * full updated patterns list on success, throws on failure.
   */
  async associateUrl(pattern: string): Promise<string[]> {
    const base = this.httpBase();
    if (!base) throw new Error("no companion selected");
    const res = await fetch(`${base}/v1/url-patterns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { urlPatterns: string[] };
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
      case "session.created":
      case "session.synced": {
        const previousSessionId = this.session?.id ?? null;
        this.session = msg.session;
        this.creatingSession = false;
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
}

export const app = new ExtensionState();
