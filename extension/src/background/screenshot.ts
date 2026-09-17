/// <reference types="chrome" />

// Captures a full-page screenshot of the given tab by scroll-and-stitch.
// Runs in the background service worker (only it can call captureVisibleTab
// on arbitrary tabs).
//
// Two modes, and each computes ONLY what its caller uses (the payload rides
// runtime messaging, so an unused multi-MB field is pure waste):
//   - "stitched": one JPEG in CSS pixels — captured physical bitmaps are
//     downscaled to viewport dimensions during stitch so consumers (the
//     compositor) don't need to track DPR. Used by connected-mode submit.
//   - "slices": the raw per-viewport captures + page-Y offsets, no stitch.
//     Used by the bundle export (one composited image per scroll section).

import { frameCaptureGeometry, type FrameRectReport } from "../lib/devices-frame.js";

export type FullPageCaptureMode = "stitched" | "slices";

export type FullPageCapture = {
  mode: FullPageCaptureMode;
  /** Stitched full-page image (JPEG). Present only in "stitched" mode. */
  dataUrl?: string;
  /** Per-viewport raw captures with their page-Y offsets. Present only in
   *  "slices" mode. Lets a consumer produce one composited image per scroll
   *  position instead of a single stitched image — avoids fixed/sticky
   *  elements appearing duplicated vertically when stitched. */
  slices?: Array<{ dataUrl: string; offsetY: number }>;
  /** Page dimensions in CSS pixels — same coordinate space as Annotation strokes. */
  pageWidth: number;
  pageHeight: number;
  /** Height actually captured. Equal to pageHeight unless the capture was
   *  capped (pixel budget or wall-clock budget), in which case the bottom
   *  is dropped. */
  capturedHeight: number;
  /** True when the capture was truncated (page over the pixel budget, or
   *  the scroll loop ran out of time). Surface to the user so they know not
   *  all of the page made it into the screenshot. */
  capped: boolean;
  viewportWidth: number;
  viewportHeight: number;
  /** DPR of the captured tab at capture time, in case a consumer wants higher fidelity. */
  devicePixelRatio: number;
};

type PageDims = {
  pageWidth: number;
  pageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
};

// Chrome enforces MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2, so we need
// >= 500ms between captures. 600ms gives margin and lets sticky/lazy
// elements settle after each scroll step.
const SETTLE_MS = 600;

/** Longest canvas side we allow. Chrome's hard limit is 32,767 px; half of
 *  it keeps the stitch well clear and is still ~15 laptop viewports. */
export const MAX_CANVAS_SIDE = 16_384;

/** Stitch canvas area budget in CSS px² (the stitch is at 1x). 60M px² is
 *  ~240 MB of RGBA at worst — only reached on very wide pages, since the
 *  side cap binds first below ~3,660 px wide. */
export const AREA_BUDGET = 60_000_000;

/** Wall-clock budget for the scroll-and-capture loop. Leaves the MV3 service
 *  worker margin for the stitch + encode before its ~30s idle horizon. When
 *  exceeded the capture stops early and returns a partial (`capped`). */
export const CAPTURE_BUDGET_MS = 18_000;

// JPEG quality for the stitched output. q=0.85 is roughly 5–10× smaller
// than PNG with no perceptible loss for screenshot content (text +
// rectangles). Annotations are composited later in the side panel, so
// re-encode loss is one generation, not two.
const STITCHED_JPEG_QUALITY = 0.85;
/** captureVisibleTab quality (0–100) for the per-viewport captures. */
const CAPTURE_JPEG_QUALITY = 92;

/** Max height (CSS px) a full-page capture may cover for a page this wide:
 *  bounded by the canvas side cap and the area budget. Pure → unit-tested. */
export function fullPageHeightCap(pageWidth: number): number {
  const w = Math.max(1, Math.floor(pageWidth));
  return Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.floor(AREA_BUDGET / w)));
}

export async function captureFullPage(
  tabId: number,
  mode: FullPageCaptureMode = "stitched",
): Promise<FullPageCapture> {
  const started = Date.now();
  const dims = await measure(tabId);
  const vh = Math.max(1, dims.viewportHeight);

  // Truncate over-large pages — better to ship a partial screenshot than to
  // blow Chrome's canvas limits or OOM the worker mid-stitch.
  let capturedHeight = Math.max(1, Math.min(dims.pageHeight, fullPageHeightCap(dims.pageWidth)));
  let capped = capturedHeight < dims.pageHeight;

  const stitcher = mode === "stitched" ? createStitcher(dims, capturedHeight) : null;
  const slices: Array<{ dataUrl: string; offsetY: number }> = [];
  // Stitched mode decodes + draws each capture while the NEXT scroll settles
  // (the settle sleep is idle time anyway), so no slice data URL outlives
  // its draw and there's no separate stitch pass after the loop.
  let drawing: Promise<void> = Promise.resolve();
  let covered = 0;

  try {
    let y = 0;
    while (true) {
      if (covered > 0 && Date.now() - started >= CAPTURE_BUDGET_MS) {
        capped = true;
        capturedHeight = covered;
        break;
      }
      const targetY = Math.min(y, Math.max(0, capturedHeight - vh));
      await scrollTo(tabId, targetY);
      await sleep(SETTLE_MS);
      // JPEG q92 capture: far faster for Chrome to encode than PNG on hi-DPR
      // viewports and several× smaller over messaging; the output is JPEG anyway.
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: CAPTURE_JPEG_QUALITY });
      covered = Math.min(capturedHeight, targetY + vh);
      if (stitcher) {
        drawing = drawing.then(() => stitcher.draw(dataUrl, targetY));
      } else {
        slices.push({ dataUrl, offsetY: targetY });
      }
      if (targetY + vh >= capturedHeight) break;
      y += vh;
    }
  } finally {
    // Restore original scroll position (best-effort — the tab may be gone).
    // A pending draw's rejection is surfaced by the await below.
    drawing.catch(() => {});
    await scrollTo(tabId, dims.scrollY).catch(() => {});
  }

  if (capped) {
    console.warn(
      `[pinta] page is ${dims.pageWidth}×${dims.pageHeight}px; ` +
        `captured the first ${capturedHeight}px (pixel/time budget).`,
    );
  }

  let dataUrl: string | undefined;
  if (stitcher) {
    await drawing;
    dataUrl = await stitcher.encode(capturedHeight);
  }
  return {
    mode,
    ...(dataUrl !== undefined ? { dataUrl } : {}),
    ...(stitcher ? {} : { slices }),
    pageWidth: dims.pageWidth,
    pageHeight: dims.pageHeight,
    capturedHeight,
    capped,
    viewportWidth: dims.viewportWidth,
    viewportHeight: dims.viewportHeight,
    devicePixelRatio: dims.devicePixelRatio,
  };
}

async function measure(tabId: number): Promise<PageDims> {
  const [first] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1,
    }),
  });
  if (!first?.result) throw new Error("could not measure page");
  return first.result;
}

async function scrollTo(tabId: number, y: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (sy: number) => window.scrollTo({ top: sy, left: 0, behavior: "instant" as ScrollBehavior }),
    args: [y],
  });
}

/** Streaming stitcher: a CSS-px (1x) canvas sized to the capped height.
 *  Each capture is fetch → decode → drawImage → close, one at a time, so
 *  at most one decoded viewport bitmap is alive (at 1920×1080 DPR 2 each is
 *  ~16 MB raw; holding them all routinely OOM-killed the MV3 worker). */
function createStitcher(dims: PageDims, height: number) {
  const width = Math.max(1, Math.min(Math.floor(dims.pageWidth), MAX_CANVAS_SIDE));
  const oc = new OffscreenCanvas(width, Math.max(1, Math.floor(height)));
  const ctx = oc.getContext("2d");
  if (!ctx) throw new Error("no 2d context on OffscreenCanvas");
  // Pre-fill so any uncovered pixel encodes as white in JPEG (no alpha).
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, oc.width, oc.height);

  return {
    async draw(dataUrl: string, offsetY: number): Promise<void> {
      const blob = await fetch(dataUrl).then((r) => r.blob());
      const bm = await createImageBitmap(blob);
      try {
        // Source = full physical bitmap; destination = scaled to CSS viewport size.
        ctx.drawImage(bm, 0, 0, bm.width, bm.height, 0, offsetY, dims.viewportWidth, dims.viewportHeight);
      } finally {
        bm.close();
      }
    },
    /** JPEG over PNG: 5–10× smaller for screenshot content. Crops to
     *  `finalHeight` when the loop stopped early on the time budget. */
    async encode(finalHeight: number): Promise<string> {
      let out: OffscreenCanvas = oc;
      const h = Math.max(1, Math.floor(finalHeight));
      if (h < oc.height) {
        out = new OffscreenCanvas(oc.width, h);
        out.getContext("2d")?.drawImage(oc, 0, 0);
        oc.width = oc.height = 1; // release the tall backing store early
      }
      let blob: Blob;
      try {
        blob = await out.convertToBlob({ type: "image/jpeg", quality: STITCHED_JPEG_QUALITY });
      } finally {
        // Release the backing stores now, on both paths — the worker may
        // live on for a while and a 16k-tall canvas is ~250 MB raw.
        out.width = out.height = 1;
        oc.width = oc.height = 1;
      }
      return await blobToDataUrl(blob);
    },
  };
}

export type DeviceFrameCapture = {
  /** The annotating device's viewport (JPEG). Pixel size is
   *  imageWidth×imageHeight — never upscaled past the frame's on-screen
   *  physical pixels; annotations are still in device CSS px. */
  dataUrl: string;
  /** Device viewport in CSS px — pass as the composite viewport size. */
  width: number;
  height: number;
  /** Actual encoded image size in px. */
  imageWidth: number;
  imageHeight: number;
  /** Part of the frame was outside the canvas window (blank there). */
  clipped: boolean;
};

/** Long-edge cap for the device frame image (vision models downscale past
 *  ~1568 px anyway, so extra pixels only cost tokens). */
export const DEVICE_FRAME_MAX_EDGE = 1568;
const DEVICE_FRAME_JPEG_QUALITY = 0.9;

/** Output image size for a device frame capture: the frame's real on-screen
 *  physical width (capped at its CSS width — never upscale a scaled-down
 *  frame), aspect kept, long edge ≤ DEVICE_FRAME_MAX_EDGE. Returns the
 *  factor k mapping device CSS px → output px. Pure → unit-tested. */
export function deviceFrameOutputSize(report: FrameRectReport): {
  width: number;
  height: number;
  k: number;
} {
  const cssW = Math.max(1, report.cssWidth);
  const cssH = Math.max(1, report.cssHeight);
  const dpr = report.devicePixelRatio > 0 ? report.devicePixelRatio : 1;
  let k = Math.min(cssW, report.rect.width * dpr) / cssW;
  if (!(k > 0)) k = 1;
  const longEdge = Math.max(cssW, cssH) * k;
  if (longEdge > DEVICE_FRAME_MAX_EDGE) k *= DEVICE_FRAME_MAX_EDGE / longEdge;
  return {
    width: Math.max(1, Math.round(cssW * k)),
    height: Math.max(1, Math.round(cssH * k)),
    k,
  };
}

/**
 * Devices module: capture the annotating device frame on a Devices canvas
 * tab. The canvas reports the frame's on-screen box; we capture the visible
 * tab and crop that box back into a device-proportioned image, so annotation
 * coordinates (device CSS px) line up for compositeAnnotationsToViewport
 * (which scales by image px / CSS px).
 *
 * The tab must be the ACTIVE tab of its window both before and after the
 * capture — captureVisibleTab grabs whatever is showing, so a tab switch
 * mid-flight would otherwise crop another tab's pixels.
 */
export async function captureDeviceFrame(tabId: number): Promise<DeviceFrameCapture> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error("the Devices tab isn't the active tab — switch back to it");
  const windowId = tab.windowId;
  const reply = (await chrome.runtime.sendMessage({
    type: "devices.annotate-frame-rect",
    tabId,
  })) as { rect?: FrameRectReport | null } | undefined;
  const report = reply?.rect;
  if (!report) {
    throw new Error("no device is being annotated — click Annotate on a device frame first");
  }
  const g = frameCaptureGeometry(report);
  if (!g) throw new Error("the annotating device is off-screen — scroll it into view");
  const shot = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 92 });
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (active?.id !== tabId) {
    throw new Error("the active tab changed during capture — try again");
  }
  const out = deviceFrameOutputSize(report);
  const bitmap = await createImageBitmap(await fetch(shot).then((r) => r.blob()));
  let blob: Blob;
  try {
    const oc = new OffscreenCanvas(out.width, out.height);
    const ctx = oc.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      bitmap,
      g.sx,
      g.sy,
      g.sw,
      g.sh,
      g.dx * out.k,
      g.dy * out.k,
      g.dw * out.k,
      g.dh * out.k,
    );
    blob = await oc.convertToBlob({ type: "image/jpeg", quality: DEVICE_FRAME_JPEG_QUALITY });
  } finally {
    bitmap.close();
  }
  return {
    dataUrl: await blobToDataUrl(blob),
    width: g.outWidth,
    height: g.outHeight,
    imageWidth: out.width,
    imageHeight: out.height,
    clipped: g.clipped,
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
