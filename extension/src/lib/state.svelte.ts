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
import { findCompanionForUrl } from "./url-patterns.js";

const SELECTED_KEY = "pinta-selected-companion";

export type ExtensionMode = "draw" | "select" | "review" | "idle";

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

  /** Manual rescan — used after a connection drop or user-triggered refresh. */
  async rescan(activeTabUrl: string | null = this.lastUrl): Promise<void> {
    this.scanning = true;
    try {
      this.companions = await discoverCompanions();
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
        // fall back to the auto-pick policy.
        const next = this.pickCompanion(this.companions, activeTabUrl);
        await this.connectTo(next);
      } else if (stillSelected !== this.selectedCompanion) {
        // Stay put but refresh the cached entry (urlPatterns may have
        // changed since last scan).
        this.selectedCompanion = stillSelected;
      }
    } finally {
      this.scanning = false;
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

  ensureSession(url: string): void {
    this.lastUrl = url;
    if (this.session || this.creatingSession || !this.client) return;
    this.creatingSession = true;
    this.send({ type: "session.create", url });
  }

  addAnnotation(annotation: Annotation): void {
    this.send({ type: "annotation.add", annotation });
  }

  updateAnnotation(id: string, patch: Partial<Annotation>): void {
    this.send({ type: "annotation.update", id, patch });
  }

  removeAnnotation(id: string): void {
    this.send({ type: "annotation.remove", id });
  }

  submit(screenshot = "", autoApply?: boolean): void {
    this.send({ type: "session.submit", screenshot, autoApply });
  }

  /**
   * Cancel the current session and start a fresh one for the same URL.
   */
  async cancelAndRestart(url: string): Promise<void> {
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
