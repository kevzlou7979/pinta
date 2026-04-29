import type {
  Annotation,
  ClientMessage,
  ServerMessage,
  Session,
} from "@pinta/shared";
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
} from "./local-store.js";

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
    await this.rescan(activeTabUrl);
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

      // Wipe the locally-loaded session if we're entering routing — it
      // gets re-hydrated below if we end up standalone, replaced by the
      // companion's session if we end up connected.
      const wasStandalone = !!this.currentOrigin;
      if (wasStandalone) {
        this.session = null;
        this.currentOrigin = null;
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
    if (this.appMode === "standalone") {
      await this.mutateLocal((s) => ({
        ...s,
        annotations: [...s.annotations, annotation],
      }));
      return;
    }
    this.send({ type: "annotation.add", annotation });
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
    this.send({ type: "session.submit", screenshot, autoApply });
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
      case "session.synced":
        this.session = msg.session;
        this.creatingSession = false;
        this.lastError = null;
        break;
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
