// Runes store for the full-tab Devices canvas. Deliberately tiny and
// SELF-CONTAINED: it must never import lib/state.svelte.ts — that module
// constructs the whole side-panel ExtensionState singleton (companion
// WebSocket and all) at import time. This page only needs two
// chrome.storage.local keys: its own state blob, and the shared module
// settings (read-only, for the customDevices catalog additions).

import {
  CUSTOM_SIZE_MAX,
  CUSTOM_SIZE_MIN,
  customSizeModel,
  DEVICE_CATALOG,
  defaultDevicesState,
  layoutUnplacedFrames,
  mergeCatalog,
  modelsForGroup,
  NAV_SETTLE_MS,
  NavSyncTracker,
  newFrame,
  normalizeTargetUrl,
  storableTargetUrl,
  urlOrigin,
  rearrangeFrames,
  parseCustomDevices,
  parseStoredDevicesState,
  stepGlobalZoom,
  stepZoom,
  type DeviceGroup,
  type DeviceModel,
  type DevicesPageStateShape,
  type FrameRectReport,
} from "../lib/devices.js";

const DEVICES_KEY = "pinta-devices";
/** Written by the side panel (state.svelte.ts saveModules) — read-only here. */
const MODULES_KEY = "pinta-modules";

/** Soft cap — every frame is a full live instance of the user's app. */
export const MAX_FRAMES = 12;

type ModulesBlob = Record<
  string,
  { settings?: Record<string, string | boolean> } | undefined
>;

// Nav-sync reporting is done by the declared content script
// src/content/nav-reporter.ts (all_frames), which stays inert until this
// page activates it with a "pinta-nav-start" ping — executeScript can't
// target this tab because its TOP frame is the extension's own page.

class DevicesPageState {
  state = $state<DevicesPageStateShape>(defaultDevicesState());
  catalog = $state<DeviceModel[]>(DEVICE_CATALOG);
  error = $state<string | null>(null);
  openTabs = $state<{ title: string; url: string }[]>([]);
  /** Last-touched frame renders on top (drag/click raises it). */
  frontId = $state<string | null>(null);
  /** Frame currently expanded to fill the viewport (null = none).
   *  Style-only overlay on the SAME element, so the iframe never
   *  reloads on expand/restore. */
  expandedId = $state<string | null>(null);
  /** Per-frame iframe src. Sync updates individual entries so the frame
   *  that originated a navigation is never reloaded. */
  frameSrc = $state<Record<string, string>>({});
  /** Frame hosting the annotate overlay (null = none). One at a time, so
   *  the side panel's tab-wide broadcasts reach exactly one live overlay.
   *  Session-only — never persisted. */
  annotateFrameId = $state<string | null>(null);
  /** Frame whose overlay acknowledged activation (null = none live yet).
   *  Until this matches annotateFrameId the header shows "Starting…". */
  annotateReadyId = $state<string | null>(null);
  /** One retry per activation: reload the frame (a frame that was open
   *  before the extension loaded has no content script until it does). */
  private annotateTimer: ReturnType<typeof setTimeout> | null = null;
  private annotateRetried = false;

  /** DOM iframes by frame id — identity lookup for postMessage sources.
   *  Not reactive on purpose; only read inside event handlers. */
  private iframeEls = new Map<string, HTMLIFrameElement>();
  /** Per-frame nav-sync bookkeeping (last reported URL, re-point grace,
   *  expected loads) — pure logic in lib/devices.ts. A frame's first
   *  report is recorded but never propagated (prevents a storm when the
   *  reporter lands in frames that are already open). */
  private nav = new NavSyncTracker();
  /** Debounced propagation: only the SETTLED URL of a redirect chain spreads. */
  private navTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  async hydrate(): Promise<void> {
    try {
      const got = await chrome.storage.local.get([DEVICES_KEY, MODULES_KEY]);
      this.state = parseStoredDevicesState(got[DEVICES_KEY]);
      const modules = got[MODULES_KEY] as ModulesBlob | undefined;
      this.catalog = mergeCatalog(
        DEVICE_CATALOG,
        parseCustomDevices(modules?.["devices"]?.settings?.customDevices),
      );
    } catch {
      // storage unavailable — defaults already in place
    }
    // A ?url= from the launcher wins over the persisted URL: opening the
    // canvas from the side panel is an explicit "show me THIS app".
    const q = new URLSearchParams(location.search).get("url");
    if (q) {
      const u = normalizeTargetUrl(q);
      if (u !== "") this.state.url = u;
    }
    // First run / pre-drag state: give position-less frames a spot.
    layoutUnplacedFrames(
      this.state.frames,
      this.state.globalZoom,
      Math.max(600, window.innerWidth),
    );
    this.resetFrameSrcs();
    this.save();
    void this.loadOpenTabs();
    this.syncPinging();
  }

  /** Point every frame at the shared target URL. */
  private resetFrameSrcs(): void {
    const next: Record<string, string> = {};
    for (const f of this.state.frames) next[f.id] = this.state.url;
    this.frameSrc = next;
  }

  srcFor(id: string): string {
    return this.frameSrc[id] ?? this.state.url;
  }

  /** Debounced persist — zoom taps shouldn't hammer storage. */
  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // Never persist query strings / fragments (tokens in magic links,
      // OAuth callbacks, or URLs forged by a framed page): origin + path.
      const snap = $state.snapshot(this.state);
      void chrome.storage.local
        .set({ [DEVICES_KEY]: { ...snap, url: storableTargetUrl(snap.url) } })
        .catch(() => {});
    }, 300);
  }

  /** Open http(s) tabs of the current window, most recent first — feeds
   *  the "use an open tab" picker. Never queries {active:true}: that
   *  would return this page itself. */
  async loadOpenTabs(): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      this.openTabs = tabs
        .filter((t): t is chrome.tabs.Tab & { url: string } =>
          typeof t.url === "string" && /^https?:\/\//i.test(t.url),
        )
        .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
        .map((t) => ({ title: t.title?.trim() || t.url, url: t.url }));
    } catch {
      this.openTabs = [];
    }
  }

  addFrame(modelId: string): void {
    if (this.state.frames.length >= MAX_FRAMES) {
      this.error = `Up to ${MAX_FRAMES} frames at once — remove one first (each frame is a live copy of your app).`;
      return;
    }
    const model =
      this.catalog.find((m) => m.id === modelId) ?? this.catalog[0];
    if (!model) return;
    this.pushFrame(model);
  }

  /** Responsive config: add a frame from a typed Width × Height. */
  addCustomFrame(width: number, height: number): void {
    if (this.state.frames.length >= MAX_FRAMES) {
      this.error = `Up to ${MAX_FRAMES} frames at once — remove one first.`;
      return;
    }
    const model = customSizeModel(width, height);
    if (!model) {
      this.error = `Enter a size between ${CUSTOM_SIZE_MIN} and ${CUSTOM_SIZE_MAX} px per side.`;
      return;
    }
    this.pushFrame(model);
  }

  /** Shared add path: pushed unplaced, then masonry-packed into the
   *  nearest free spot. */
  private pushFrame(model: DeviceModel): void {
    const frame = newFrame(model);
    this.state.frames.push(frame);
    this.frameSrc[frame.id] = this.state.url;
    layoutUnplacedFrames(
      this.state.frames,
      this.state.globalZoom,
      Math.max(600, window.innerWidth),
    );
    this.frontId = frame.id;
    this.save();
  }

  /** Clear the whole canvas. */
  clearFrames(): void {
    this.setAnnotateFrame(null);
    this.state.frames = [];
    this.frameSrc = {};
    this.nav.clear();
    this.cancelNavPropagation();
    this.frontId = null;
    this.expandedId = null;
    this.save();
  }

  /** Rearrange Workspace — re-pack every frame into masonry. */
  rearrange(): void {
    rearrangeFrames(
      this.state.frames,
      this.state.globalZoom,
      Math.max(600, window.innerWidth),
    );
    this.save();
  }

  /** Bulk add: one frame per model of the group (e.g. every Mobile).
   *  New frames are pushed unplaced, then auto-laid out in wrap rows
   *  below the existing content. Partial add when the cap is hit. */
  addGroup(group: DeviceGroup): void {
    const models = modelsForGroup(this.catalog, group);
    if (models.length === 0) return;
    let added = 0;
    for (const m of models) {
      if (this.state.frames.length >= MAX_FRAMES) {
        this.error = `Frame cap (${MAX_FRAMES}) reached — added ${added} of ${models.length} ${group} devices.`;
        break;
      }
      const frame = newFrame(m);
      this.state.frames.push(frame);
      this.frameSrc[frame.id] = this.state.url;
      added++;
    }
    if (added === 0) return;
    layoutUnplacedFrames(
      this.state.frames,
      this.state.globalZoom,
      Math.max(600, window.innerWidth),
    );
    this.frontId = this.state.frames.at(-1)?.id ?? null;
    this.save();
  }

  /** Free-drag: update a frame's canvas position (clamped to ≥ 0). */
  moveFrame(id: string, x: number, y: number): void {
    const frame = this.state.frames.find((f) => f.id === id);
    if (!frame) return;
    frame.x = Math.max(0, Math.round(x));
    frame.y = Math.max(0, Math.round(y));
    this.save();
  }

  bringToFront(id: string): void {
    this.frontId = id;
  }

  removeFrame(id: string): void {
    if (this.annotateFrameId === id) this.setAnnotateFrame(null);
    this.state.frames = this.state.frames.filter((f) => f.id !== id);
    delete this.frameSrc[id];
    this.iframeEls.delete(id);
    this.nav.forget(id);
    if (this.expandedId === id) this.expandedId = null;
    this.save();
  }

  toggleExpand(id: string): void {
    this.expandedId = this.expandedId === id ? null : id;
    if (this.expandedId) this.frontId = id;
  }

  /** Switch a frame's model — re-snapshot dims/label, reset orientation
   *  to the model's natural one and zoom to the class default. */
  setModel(id: string, modelId: string): void {
    const model = this.catalog.find((m) => m.id === modelId);
    const frame = this.state.frames.find((f) => f.id === id);
    if (!model || !frame) return;
    const fresh = newFrame(model);
    frame.modelId = model.id;
    frame.label = model.label;
    frame.width = model.width;
    frame.height = model.height;
    frame.orientation = fresh.orientation;
    frame.zoom = fresh.zoom;
    this.save();
  }

  rotate(id: string): void {
    const frame = this.state.frames.find((f) => f.id === id);
    if (!frame) return;
    frame.orientation =
      frame.orientation === "portrait" ? "landscape" : "portrait";
    this.save();
  }

  frameZoom(id: string, dir: 1 | -1): void {
    const frame = this.state.frames.find((f) => f.id === id);
    if (!frame) return;
    frame.zoom = stepZoom(frame.zoom, dir);
    this.save();
  }

  globalZoom(dir: 1 | -1): void {
    this.state.globalZoom = stepGlobalZoom(this.state.globalZoom, dir);
    this.save();
  }

  refreshFrame(id: string): void {
    const frame = this.state.frames.find((f) => f.id === id);
    if (!frame) return;
    this.nav.markRepointed(id, Date.now());
    frame.nonce++;
  }

  refreshAll(): void {
    // Reloads (and their redirects) are Pinta-initiated: they must never
    // come back as navigations and ripple across the canvas.
    this.cancelNavPropagation();
    const now = Date.now();
    for (const f of this.state.frames) {
      this.nav.markRepointed(f.id, now);
      f.nonce++;
    }
  }

  setUrl(raw: string): void {
    const u = normalizeTargetUrl(raw);
    if (raw.trim() !== "" && u === "") {
      this.error =
        "Only http(s) URLs can be framed — e.g. http://localhost:5173";
      return;
    }
    if (u !== this.state.url) {
      this.state.url = u;
      this.resetFrameSrcs();
      this.refreshAll(); // marks every frame re-pointed (nav grace)
      this.save();
    }
  }

  // -----------------------------------------------------------------------
  // Navigation sync

  toggleSync(): void {
    this.state.sync = !this.state.sync;
    this.save();
    this.syncPinging();
  }

  /** Make `id` the frame you annotate in (null = stop). The previous
   *  target is told to go inert right away; the ping loop re-activates the
   *  target after reloads / navigations (a fresh document starts inert). */
  setAnnotateFrame(id: string | null): void {
    const prev = this.annotateFrameId;
    this.clearAnnotateTimer();
    this.annotateRetried = false;
    this.annotateFrameId = id;
    this.annotateReadyId = null;
    if (prev && prev !== id) this.postAnnotate(prev, false);
    if (id) {
      this.frontId = id;
      this.postAnnotate(id, true);
      this.armAnnotateWatchdog(id);
    }
    this.syncPinging();
  }

  /** The frame's overlay answered — annotation is really live there.
   *  Callers must pass only acks that arrived over chrome.runtime straight
   *  from a sub-frame of this tab (isDirectSubframeSender): a page can post
   *  anything to its parent window but can't send a runtime message. The
   *  `token` is the frame id the activation ping carried. */
  handleAnnotateAck(token: string, on: boolean): void {
    if (!this.iframeEls.has(token)) return;
    if (on && this.annotateFrameId === token) {
      this.clearAnnotateTimer();
      this.annotateReadyId = token;
    } else if (this.annotateReadyId === token) {
      this.annotateReadyId = null;
    }
  }

  /** No ack means no Pinta in that frame yet. Reload it once (content
   *  scripts land on the fresh document), then give up with a message
   *  rather than leaving the header claiming it's annotating. */
  private armAnnotateWatchdog(id: string): void {
    this.clearAnnotateTimer();
    this.annotateTimer = setTimeout(() => {
      this.annotateTimer = null;
      if (this.annotateFrameId !== id || this.annotateReadyId === id) return;
      if (!this.annotateRetried) {
        this.annotateRetried = true;
        this.refreshFrame(id);
        this.armAnnotateWatchdog(id);
        return;
      }
      this.error =
        "Couldn't start annotating in that device. Reload this page (F5) and try again — frames opened before Pinta was reloaded don't have it yet.";
      this.annotateFrameId = null;
      this.syncPinging();
    }, 2500);
  }

  private clearAnnotateTimer(): void {
    if (this.annotateTimer) clearTimeout(this.annotateTimer);
    this.annotateTimer = null;
  }

  toggleAnnotate(id: string): void {
    this.setAnnotateFrame(this.annotateFrameId === id ? null : id);
  }

  /** Re-send activation to the current target (the side panel asks when
   *  it hasn't heard from a frame). Returns whether one is set. */
  repingAnnotate(): boolean {
    const id = this.annotateFrameId;
    if (!id) return false;
    this.postAnnotate(id, true);
    return true;
  }

  private postAnnotate(id: string, on: boolean): void {
    const origin = this.expectedOrigin(id);
    if (!origin) return;
    try {
      this.iframeEls
        .get(id)
        ?.contentWindow?.postMessage({ type: "pinta-annotate", on, token: id }, origin);
    } catch {
      // frame detached — ignore
    }
  }

  /** The origin frame `id` is expected to show (its configured src).
   *  Pings are addressed to it instead of "*": a frame that wandered to
   *  another origin simply doesn't get activated. */
  private expectedOrigin(id: string): string | null {
    return urlOrigin(this.srcFor(id));
  }

  /**
   * Where the annotating frame sits right now, for the device-frame
   * screenshot (service worker crops the visible-tab capture with it).
   * Scrolls the frame into view first so as much as possible is visible.
   */
  async annotateFrameRect(): Promise<FrameRectReport | null> {
    const id = this.annotateFrameId;
    const el = id ? this.iframeEls.get(id) : null;
    if (!el) return null;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    // rAF never fires in a hidden tab — don't hang the screenshot on it.
    await Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      new Promise((r) => setTimeout(r, 150)),
    ]);
    const b = el.getBoundingClientRect();
    return {
      rect: { x: b.x, y: b.y, width: b.width, height: b.height },
      cssWidth: el.offsetWidth,
      cssHeight: el.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  }

  registerIframe(id: string, el: HTMLIFrameElement | null): void {
    if (el) this.iframeEls.set(id, el);
    else this.iframeEls.delete(id);
  }

  /** An iframe finished a (re)load — its fresh document's reporter is
   *  inert again; re-ping so it starts (the interval also covers this,
   *  this just makes it immediate). With the frame id, a Pinta-initiated
   *  reload also resets that frame's nav baseline (NavSyncTracker.loaded)
   *  so its first report — often a redirect — isn't read as navigation. */
  notifyFrameLoaded(id?: string): void {
    if (id && this.annotateReadyId === id) this.annotateReadyId = null;
    if (id) this.nav.loaded(id, Date.now());
    if (this.state.sync || this.annotateFrameId) this.pingFrames();
  }

  /** Ping while anything needs it: nav sync, or an annotating frame. The
   *  ping activates the nav reporters; it's harmless and idempotent (a
   *  started reporter ignores repeats), so a short interval covers every
   *  timing race: content script not yet injected at load-event time,
   *  frames added later, reloads. */
  private syncPinging(): void {
    if (this.state.sync || this.annotateFrameId) {
      // Sync off but still pinging for an annotating frame (which no longer
      // re-starts reporters): stop every reporter's poll now.
      if (!this.state.sync) this.postNavStop();
      this.startPinging();
    } else {
      this.stopPinging(); // posts pinta-nav-stop once
    }
  }

  private startPinging(): void {
    if (this.pingTimer) return;
    this.pingFrames();
    this.pingTimer = setInterval(() => this.pingFrames(), 2000);
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (!this.state.sync) this.postNavStop();
  }

  /** Tell every frame's nav reporter to stop polling (nav-reporter.ts). */
  private postNavStop(): void {
    for (const [id, el] of this.iframeEls) {
      const origin = this.expectedOrigin(id);
      if (!origin) continue;
      try {
        el.contentWindow?.postMessage({ type: "pinta-nav-stop" }, origin);
      } catch {
        // frame detached — ignore
      }
    }
  }

  private pingFrames(): void {
    for (const [id, el] of this.iframeEls) {
      const origin = this.expectedOrigin(id);
      if (!origin) continue;
      try {
        if (this.state.sync) {
          el.contentWindow?.postMessage({ type: "pinta-nav-start" }, origin);
        }
        if (this.annotateFrameId === id) {
          el.contentWindow?.postMessage({ type: "pinta-annotate", on: true, token: id }, origin);
        }
      } catch {
        // frame detached mid-iteration — ignore
      }
    }
  }

  /**
   * A frame posted its URL. Untrusted input — the framed page's main world
   * can post the same message: the shape is validated, the sender must be
   * one of OUR iframes (identity-checked against the registered elements),
   * and only same-origin http(s) navigations outside a re-point grace
   * window spread (NavSyncTracker), debounced so redirects settle first.
   */
  handleNavMessage(event: MessageEvent): void {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (!data || data.type !== "pinta-nav" || typeof data.url !== "string") {
      return;
    }
    let originId: string | null = null;
    for (const [id, el] of this.iframeEls) {
      if (el.contentWindow === event.source) {
        originId = id;
        break;
      }
    }
    if (!originId) return;
    const { verdict, url } = this.nav.report(originId, data.url, this.state.url, Date.now());
    if (verdict !== "propagate" || !this.state.sync) return;
    // Latest wins: a redirect chain in the originator replaces the pending
    // URL, so only where it settles reloads the other frames.
    this.cancelNavPropagation();
    const from = originId;
    this.navTimer = setTimeout(() => {
      this.navTimer = null;
      this.propagateNav(from, url);
    }, NAV_SETTLE_MS);
  }

  private cancelNavPropagation(): void {
    if (this.navTimer) clearTimeout(this.navTimer);
    this.navTimer = null;
  }

  private propagateNav(originId: string, url: string): void {
    // The originator moved on (e.g. to another origin) — nothing settled.
    if (!this.state.sync || this.nav.urlOf(originId) !== url) return;
    if (normalizeTargetUrl(url) === "") return;
    if (url !== this.state.url) {
      this.state.url = url;
      this.save();
    }
    const now = Date.now();
    for (const f of this.state.frames) {
      if (f.id === originId) continue; // never reload the originator
      const actual = this.nav.urlOf(f.id);
      if (this.frameSrc[f.id] === url) {
        if (actual === url) continue; // already there — no reload
        // The stored src already claims this URL but the frame drifted
        // (it navigated internally since, as an originator whose src we
        // deliberately never rewrite) — a reactive write would be a
        // no-op, so poke the element directly: assigning src always
        // re-navigates, even to the same string.
        const el = this.iframeEls.get(f.id);
        if (!el) continue;
        this.nav.markRepointed(f.id, now, url);
        el.src = url;
        continue;
      }
      this.nav.markRepointed(f.id, now, url);
      this.frameSrc[f.id] = url;
    }
  }
}

export const devices = new DevicesPageState();
