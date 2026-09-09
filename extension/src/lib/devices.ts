// Phase 24 — Devices module (multi-device canvas). Pure helpers for the
// full-tab simulator page: the curated device catalog, custom-device
// parsing from the module setting, zoom math, target-URL normalization,
// and tolerant (de)serialization of the persisted page state.
//
// No chrome.* APIs and no runes in here — everything is unit-testable.

export type DeviceClass =
  | "Mobile"
  | "Tablet"
  | "Laptop"
  | "Small Desktop"
  | "Large Desktop"
  | "Custom";

export const DEVICE_CLASSES: DeviceClass[] = [
  "Mobile",
  "Tablet",
  "Laptop",
  "Small Desktop",
  "Large Desktop",
  "Custom",
];

export type DeviceModel = {
  id: string;
  label: string;
  class: DeviceClass;
  /** CSS-pixel viewport, in the model's natural orientation (mobile /
   *  tablet portrait-first, desktop classes landscape-first). */
  width: number;
  height: number;
};

export type Orientation = "portrait" | "landscape";

/** One frame on the canvas. Dims are SNAPSHOTTED from the model at
 *  creation so a frame survives its custom model being deleted from
 *  Settings — the frame keeps rendering at its last known size. */
export type DeviceFrame = {
  id: string;
  modelId: string;
  label: string;
  width: number;
  height: number;
  orientation: Orientation;
  /** Per-frame zoom multiplier (1 = 100% of device pixels). */
  zoom: number;
  /** Bumped to force this frame's iframe to reload. */
  nonce: number;
  /** Canvas position (px). Unset = "unplaced" — the page lays the frame
   *  out on next open (first run, or state from before drag existed). */
  x?: number;
  y?: number;
};

export type DevicesPageStateShape = {
  frames: DeviceFrame[];
  /** Percent, 25–200. Multiplies every frame's own zoom. */
  globalZoom: number;
  url: string;
  /** Navigation sync: navigating inside one frame drives the others. */
  sync: boolean;
};

// ---------------------------------------------------------------------------
// Catalog

export const DEVICE_CATALOG: DeviceModel[] = [
  // Mobile (portrait-first)
  { id: "iphone-se", label: "iPhone SE", class: "Mobile", width: 375, height: 667 },
  { id: "iphone-16-pro", label: "iPhone 16 Pro", class: "Mobile", width: 402, height: 874 },
  { id: "iphone-16-pro-max", label: "iPhone 16 Pro Max", class: "Mobile", width: 440, height: 956 },
  { id: "pixel-8", label: "Pixel 8", class: "Mobile", width: 412, height: 915 },
  { id: "galaxy-s24", label: "Galaxy S24", class: "Mobile", width: 360, height: 780 },
  // Tablet (portrait-first)
  { id: "ipad-mini", label: "iPad Mini", class: "Tablet", width: 744, height: 1133 },
  { id: "ipad-air", label: "iPad Air", class: "Tablet", width: 820, height: 1180 },
  { id: "ipad-pro-129", label: "iPad Pro 12.9", class: "Tablet", width: 1024, height: 1366 },
  { id: "surface-pro", label: "Surface Pro", class: "Tablet", width: 912, height: 1368 },
  // Laptop (landscape-first)
  { id: "laptop-macbook-air", label: "MacBook Air", class: "Laptop", width: 1280, height: 832 },
  { id: "laptop-hd", label: "Laptop HD", class: "Laptop", width: 1366, height: 768 },
  { id: "laptop-macbook-pro-16", label: "MacBook Pro 16", class: "Laptop", width: 1536, height: 960 },
  // Small Desktop (landscape-first)
  { id: "desktop-full-hd", label: "Full HD 16:9", class: "Small Desktop", width: 1920, height: 1080 },
  // Large Desktop (landscape-first)
  { id: "desktop-qhd", label: "QHD", class: "Large Desktop", width: 2560, height: 1440 },
  { id: "desktop-4k", label: "4K UHD", class: "Large Desktop", width: 3840, height: 2160 },
];

/** Default per-frame zoom so a freshly added frame lands at a workable
 *  size — big devices come in zoomed out. */
export function classDefaultZoom(cls: DeviceClass): number {
  switch (cls) {
    case "Mobile":
      return 1;
    case "Tablet":
      return 0.75;
    case "Laptop":
    case "Small Desktop":
      return 0.5;
    case "Large Desktop":
      return 0.35;
    case "Custom":
      return 1;
  }
}

/**
 * Effective render dims for a frame. Rotation is symmetric across all
 * classes: landscape guarantees width ≥ height, portrait guarantees
 * height ≥ width — so "rotate" always flips and never produces nonsense
 * regardless of the model's natural orientation.
 */
export function dimsFor(frame: {
  width: number;
  height: number;
  orientation: Orientation;
}): { width: number; height: number } {
  const long = Math.max(frame.width, frame.height);
  const short = Math.min(frame.width, frame.height);
  return frame.orientation === "landscape"
    ? { width: long, height: short }
    : { width: short, height: long };
}

/** The orientation a model naturally ships in (mobile/tablet portrait,
 *  desktop classes landscape). */
export function naturalOrientation(model: DeviceModel): Orientation {
  return model.width >= model.height ? "landscape" : "portrait";
}

// ---------------------------------------------------------------------------
// Custom size (responsive config — quick W×H entry in the toolbar)

export const CUSTOM_SIZE_MIN = 200;
export const CUSTOM_SIZE_MAX = 4000;

/** Build an ad-hoc model from a typed Width × Height. Null when out of
 *  range — the canvas shows an error instead of a broken frame. */
export function customSizeModel(
  width: number,
  height: number,
): DeviceModel | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const w = Math.round(width);
  const h = Math.round(height);
  if (
    w < CUSTOM_SIZE_MIN ||
    w > CUSTOM_SIZE_MAX ||
    h < CUSTOM_SIZE_MIN ||
    h > CUSTOM_SIZE_MAX
  ) {
    return null;
  }
  return { id: `size:${w}x${h}`, label: `${w}×${h}`, class: "Custom", width: w, height: h };
}

// ---------------------------------------------------------------------------
// Device groups (bulk add)

/** Toolbar bulk-add groups. "Desktops" spans both desktop classes. */
export type DeviceGroup = "Mobile" | "Tablet" | "Laptop" | "Desktops";
export const DEVICE_GROUPS: DeviceGroup[] = [
  "Mobile",
  "Tablet",
  "Laptop",
  "Desktops",
];

export function modelsForGroup(
  catalog: DeviceModel[],
  group: DeviceGroup,
): DeviceModel[] {
  const classes: DeviceClass[] =
    group === "Desktops" ? ["Small Desktop", "Large Desktop"] : [group];
  return catalog.filter((m) => classes.includes(m.class));
}

// ---------------------------------------------------------------------------
// Custom devices (module setting)

/**
 * Parse the `customDevices` module setting. Mirrors parseDevicePresets'
 * tolerance: any malformed input yields `[]` — a broken setting must
 * never break the canvas. Valid entries get `custom:<label>` ids; an
 * invalid/missing `class` lands in "Custom".
 */
export function parseCustomDevices(
  settingValue: string | boolean | undefined,
): DeviceModel[] {
  if (typeof settingValue !== "string" || settingValue.trim() === "") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(settingValue);
    if (!Array.isArray(parsed)) return [];
    const out: DeviceModel[] = [];
    for (const p of parsed) {
      if (
        p &&
        typeof p === "object" &&
        typeof (p as DeviceModel).label === "string" &&
        (p as DeviceModel).label.trim() !== "" &&
        typeof (p as DeviceModel).width === "number" &&
        (p as DeviceModel).width > 0 &&
        typeof (p as DeviceModel).height === "number" &&
        (p as DeviceModel).height > 0
      ) {
        const label = (p as DeviceModel).label.trim();
        const cls = (p as DeviceModel).class;
        out.push({
          id: `custom:${label}`,
          label,
          class:
            typeof cls === "string" && DEVICE_CLASSES.includes(cls)
              ? cls
              : "Custom",
          width: Math.round((p as DeviceModel).width),
          height: Math.round((p as DeviceModel).height),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Merge custom devices into the built-in catalog. A custom whose label
 * matches a built-in REPLACES it (in place, keeping catalog order);
 * the rest are appended, so the model dropdown groups them by class.
 */
export function mergeCatalog(
  builtin: DeviceModel[],
  custom: DeviceModel[],
): DeviceModel[] {
  const out = [...builtin];
  for (const c of custom) {
    const i = out.findIndex((m) => m.label === c.label);
    if (i >= 0) out[i] = c;
    else out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zoom

export const FRAME_ZOOM_STEPS = [0.25, 0.35, 0.5, 0.65, 0.75, 1, 1.25, 1.5, 2];
export const GLOBAL_ZOOM_MIN = 25;
export const GLOBAL_ZOOM_MAX = 200;

/** Step a frame zoom up/down along FRAME_ZOOM_STEPS. An off-step value
 *  snaps to the nearest step first, then moves. Clamps at the ends. */
export function stepZoom(current: number, dir: 1 | -1): number {
  let nearest = 0;
  for (let i = 1; i < FRAME_ZOOM_STEPS.length; i++) {
    if (
      Math.abs(FRAME_ZOOM_STEPS[i]! - current) <
      Math.abs(FRAME_ZOOM_STEPS[nearest]! - current)
    ) {
      nearest = i;
    }
  }
  const next = Math.min(
    FRAME_ZOOM_STEPS.length - 1,
    Math.max(0, nearest + dir),
  );
  return FRAME_ZOOM_STEPS[next]!;
}

/** Step the global zoom ±10%, clamped to [25, 200]. */
export function stepGlobalZoom(pct: number, dir: 1 | -1): number {
  return Math.min(GLOBAL_ZOOM_MAX, Math.max(GLOBAL_ZOOM_MIN, pct + dir * 10));
}

/** The scale actually applied to a frame's iframe. Never ≤ 0. */
export function effectiveScale(
  frame: { zoom: number },
  globalZoomPct: number,
): number {
  const s = frame.zoom * (globalZoomPct / 100);
  return s > 0 ? s : 0.01;
}

// ---------------------------------------------------------------------------
// Target URL

/**
 * Normalize user input into a frameable URL. Only http(s) comes out:
 * a missing scheme gets `http://`; anything else (javascript:, data:,
 * chrome:, chrome-extension:, file:, …) yields "" — frames only ever
 * load web pages.
 */
export function normalizeTargetUrl(input: string): string {
  const raw = input.trim();
  if (raw === "") return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  // A colon followed by pure digits is a port (localhost:5173), not a
  // scheme — everything else with a scheme prefix is rejected.
  if (/^[a-z][a-z0-9+.-]*:(?!\d+([/?#]|$))/i.test(raw)) return "";
  return `http://${raw}`;
}

// ---------------------------------------------------------------------------
// Frames + persisted state

let frameSeq = 0;

/** Create a frame from a model — dims snapshot, class-default zoom. */
export function newFrame(
  model: DeviceModel,
  orientation?: Orientation,
): DeviceFrame {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `frame-${Date.now()}-${frameSeq++}`;
  return {
    id,
    modelId: model.id,
    label: model.label,
    width: model.width,
    height: model.height,
    orientation: orientation ?? naturalOrientation(model),
    zoom: classDefaultZoom(model.class),
    nonce: 0,
  };
}

/** Header/dropdown title: "iPhone 16 Pro · 402×874" (orientation-aware). */
export function frameTitle(frame: DeviceFrame): string {
  const d = dimsFor(frame);
  return `${frame.label} · ${d.width}×${d.height}`;
}

// ---------------------------------------------------------------------------
// Canvas layout (free-drag positioning)

/** Card min width — the header bar needs room even for tiny frames.
 *  Must match the `max(300px, …)` in DeviceFrame.svelte. */
export const FRAME_MIN_W = 300;
/** Header bar + gap above the bezel, px (approximate, for layout math). */
export const FRAME_HEADER_H = 42;
export const CANVAS_GAP = 24;

/** Outer footprint of a frame card on the canvas (header + bezel). */
export function frameOuterSize(
  frame: DeviceFrame,
  globalZoomPct: number,
): { w: number; h: number } {
  const d = dimsFor(frame);
  const s = effectiveScale(frame, globalZoomPct);
  return {
    w: Math.max(FRAME_MIN_W, Math.round(d.width * s) + 16),
    h: FRAME_HEADER_H + Math.round(d.height * s) + 16,
  };
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Skyline top-left packing (masonry): the best spot for a w-wide frame
 * given what's already placed. Candidate columns are the left margin and
 * every placed frame's right edge; for each, the frame must sit below
 * all placed frames it overlaps horizontally (gap included). Lowest y
 * wins, ties go left. O(n²) — fine for the 12-frame cap.
 */
export function packPosition(
  placed: Rect[],
  w: number,
  viewportW: number,
): { x: number; y: number } {
  const candidates = new Set<number>([CANVAS_GAP]);
  for (const r of placed) candidates.add(r.x + r.w + CANVAS_GAP);
  let best: { x: number; y: number } | null = null;
  for (const x of candidates) {
    if (x > CANVAS_GAP && x + w > viewportW) continue;
    let y = CANVAS_GAP;
    for (const r of placed) {
      if (x < r.x + r.w + CANVAS_GAP && r.x < x + w + CANVAS_GAP) {
        y = Math.max(y, r.y + r.h + CANVAS_GAP);
      }
    }
    if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y };
  }
  return best ?? { x: CANVAS_GAP, y: CANVAS_GAP };
}

/**
 * Masonry-place frames that don't have a position yet, packing them into
 * the gaps around already-placed content. Runs on hydrate (first run /
 * pre-drag state) and after every add. Mutates the frames in place.
 */
export function layoutUnplacedFrames(
  frames: DeviceFrame[],
  globalZoomPct: number,
  viewportW: number,
): void {
  const placed: Rect[] = [];
  for (const f of frames) {
    if (f.x != null && f.y != null) {
      const o = frameOuterSize(f, globalZoomPct);
      placed.push({ x: f.x, y: f.y, w: o.w, h: o.h });
    }
  }
  for (const f of frames) {
    if (f.x != null && f.y != null) continue;
    const o = frameOuterSize(f, globalZoomPct);
    const pos = packPosition(placed, o.w, viewportW);
    f.x = pos.x;
    f.y = pos.y;
    placed.push({ x: pos.x, y: pos.y, w: o.w, h: o.h });
  }
}

/** Rearrange Workspace: forget every position and re-pack the whole
 *  canvas into masonry, keeping the frames' array order. */
export function rearrangeFrames(
  frames: DeviceFrame[],
  globalZoomPct: number,
  viewportW: number,
): void {
  for (const f of frames) {
    delete f.x;
    delete f.y;
  }
  layoutUnplacedFrames(frames, globalZoomPct, viewportW);
}

export function defaultDevicesState(): DevicesPageStateShape {
  const phone = DEVICE_CATALOG.find((m) => m.id === "iphone-16-pro")!;
  const desktop = DEVICE_CATALOG.find((m) => m.id === "desktop-full-hd")!;
  return {
    frames: [newFrame(phone), newFrame(desktop)],
    globalZoom: 100,
    url: "",
    sync: false,
  };
}

const MAX_FRAME_ZOOM = 4;

/**
 * Validate a persisted state blob. Bad frames are dropped, zooms
 * clamped, missing fields defaulted; anything unusable falls back to
 * the default two-frame state.
 */
export function parseStoredDevicesState(raw: unknown): DevicesPageStateShape {
  if (!raw || typeof raw !== "object") return defaultDevicesState();
  const o = raw as Partial<DevicesPageStateShape>;
  const frames: DeviceFrame[] = [];
  if (Array.isArray(o.frames)) {
    for (const f of o.frames) {
      if (
        f &&
        typeof f === "object" &&
        typeof f.id === "string" &&
        f.id !== "" &&
        typeof f.label === "string" &&
        f.label !== "" &&
        typeof f.width === "number" &&
        f.width > 0 &&
        typeof f.height === "number" &&
        f.height > 0
      ) {
        frames.push({
          id: f.id,
          modelId: typeof f.modelId === "string" ? f.modelId : "",
          label: f.label,
          width: Math.round(f.width),
          height: Math.round(f.height),
          // Invalid/negative positions come back as "unplaced" so the
          // page re-lays them out instead of hiding frames off-canvas.
          ...(typeof f.x === "number" && f.x >= 0 && typeof f.y === "number" && f.y >= 0
            ? { x: Math.round(f.x), y: Math.round(f.y) }
            : {}),
          orientation:
            f.orientation === "landscape" || f.orientation === "portrait"
              ? f.orientation
              : f.width >= f.height
                ? "landscape"
                : "portrait",
          zoom:
            typeof f.zoom === "number" && f.zoom > 0
              ? Math.min(MAX_FRAME_ZOOM, f.zoom)
              : 1,
          nonce: 0,
        });
      }
    }
  }
  if (frames.length === 0) return defaultDevicesState();
  return {
    frames,
    globalZoom:
      typeof o.globalZoom === "number"
        ? Math.min(GLOBAL_ZOOM_MAX, Math.max(GLOBAL_ZOOM_MIN, o.globalZoom))
        : 100,
    url: typeof o.url === "string" ? normalizeTargetUrl(o.url) : "",
    sync: o.sync === true,
  };
}
