// Runes store for the full-tab Devices canvas. Deliberately tiny and
// SELF-CONTAINED: it must never import lib/state.svelte.ts — that module
// constructs the whole side-panel ExtensionState singleton (companion
// WebSocket and all) at import time. This page only needs two
// chrome.storage.local keys: its own state blob, and the shared module
// settings (read-only, for the customDevices catalog additions).

import {
  CANVAS_GAP,
  DEVICE_CATALOG,
  defaultDevicesState,
  frameOuterSize,
  layoutUnplacedFrames,
  mergeCatalog,
  modelsForGroup,
  newFrame,
  normalizeTargetUrl,
  parseCustomDevices,
  parseStoredDevicesState,
  stepGlobalZoom,
  stepZoom,
  type DeviceGroup,
  type DeviceModel,
  type DevicesPageStateShape,
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
  /** Per-frame iframe src. Sync updates individual entries so the frame
   *  that originated a navigation is never reloaded. */
  frameSrc = $state<Record<string, string>>({});

  /** DOM iframes by frame id — identity lookup for postMessage sources.
   *  Not reactive on purpose; only read inside event handlers. */
  private iframeEls = new Map<string, HTMLIFrameElement>();
  /** Last URL each frame reported — undefined until its first report,
   *  which is recorded but never propagated (prevents a storm when the
   *  reporter lands in frames that are already open). */
  private frameUrl = new Map<string, string>();
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
    if (this.state.sync) this.startPinging();
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
      void chrome.storage.local
        .set({ [DEVICES_KEY]: $state.snapshot(this.state) })
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
    const frame = newFrame(model);
    // Drop the new frame below everything placed so it never lands
    // hidden under an existing one.
    let maxBottom = 0;
    for (const f of this.state.frames) {
      if (f.x != null && f.y != null) {
        maxBottom = Math.max(
          maxBottom,
          f.y + frameOuterSize(f, this.state.globalZoom).h,
        );
      }
    }
    frame.x = CANVAS_GAP;
    frame.y = maxBottom > 0 ? maxBottom + CANVAS_GAP : CANVAS_GAP;
    this.state.frames.push(frame);
    this.frameSrc[frame.id] = this.state.url;
    this.frontId = frame.id;
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
    this.state.frames = this.state.frames.filter((f) => f.id !== id);
    delete this.frameSrc[id];
    this.iframeEls.delete(id);
    this.frameUrl.delete(id);
    this.save();
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
    if (frame) frame.nonce++;
  }

  refreshAll(): void {
    for (const f of this.state.frames) f.nonce++;
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
      this.refreshAll();
      this.save();
    }
  }

  // -----------------------------------------------------------------------
  // Navigation sync

  toggleSync(): void {
    this.state.sync = !this.state.sync;
    this.save();
    if (this.state.sync) this.startPinging();
    else this.stopPinging();
  }

  registerIframe(id: string, el: HTMLIFrameElement | null): void {
    if (el) this.iframeEls.set(id, el);
    else this.iframeEls.delete(id);
  }

  /** An iframe finished a (re)load — its fresh document's reporter is
   *  inert again; re-ping so it starts (the interval also covers this,
   *  this just makes it immediate). */
  notifyFrameLoaded(): void {
    if (this.state.sync) this.pingFrames();
  }

  /** Activate the nav reporters. The ping is harmless and idempotent
   *  (a started reporter ignores repeats), so a short interval covers
   *  every timing race: content script not yet injected at load-event
   *  time, frames added later, reloads. */
  private startPinging(): void {
    if (this.pingTimer) return;
    this.pingFrames();
    this.pingTimer = setInterval(() => this.pingFrames(), 2000);
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private pingFrames(): void {
    for (const el of this.iframeEls.values()) {
      try {
        el.contentWindow?.postMessage({ type: "pinta-nav-start" }, "*");
      } catch {
        // frame detached mid-iteration — ignore
      }
    }
  }

  /**
   * A frame posted its URL. Untrusted input: the shape is validated,
   * only http(s) URLs are accepted, and the sender must be one of OUR
   * iframes (identity-checked against the registered elements).
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
    const url = normalizeTargetUrl(data.url);
    if (url === "") return;
    const prev = this.frameUrl.get(originId);
    this.frameUrl.set(originId, url);
    // First report from a document = position fix, not a navigation.
    if (!this.state.sync || prev === undefined || prev === url) return;
    if (url !== this.state.url) {
      this.state.url = url;
      this.save();
    }
    for (const f of this.state.frames) {
      if (f.id === originId) continue; // never reload the originator
      const actual = this.frameUrl.get(f.id);
      if (this.frameSrc[f.id] === url && actual !== url) {
        // The stored src already claims this URL but the frame drifted
        // (it navigated internally since, as an originator whose src we
        // deliberately never rewrite) — a reactive write would be a
        // no-op, so poke the element directly: assigning src always
        // re-navigates, even to the same string.
        const el = this.iframeEls.get(f.id);
        if (el) el.src = url;
      }
      this.frameSrc[f.id] = url;
      this.frameUrl.set(f.id, url);
    }
  }
}

export const devices = new DevicesPageState();
