/// <reference types="chrome" />

// Captures a full-page screenshot of the given tab by scroll-and-stitch.
// Runs in the background service worker (only it can call captureVisibleTab
// on arbitrary tabs).
//
// Returns a base64 JPEG data URL. The image is in CSS pixels — captured
// physical bitmaps are downscaled to viewport dimensions during stitch
// so consumers (the compositor) don't need to track DPR.

export type FullPageCapture = {
  /** Stitched full-page image (JPEG). Used by connected-mode submit so the
   *  agent gets one cohesive screenshot per session. */
  dataUrl: string;
  /** Per-viewport raw captures with their page-Y offsets. Lets a consumer
   *  produce one composited image per scroll position instead of a single
   *  stitched image — avoids fixed/sticky elements appearing duplicated
   *  vertically when stitched. */
  slices: Array<{ dataUrl: string; offsetY: number }>;
  /** Page dimensions in CSS pixels — same coordinate space as Annotation strokes. */
  pageWidth: number;
  pageHeight: number;
  /** Height actually captured. Equal to pageHeight unless the page exceeds
   *  MAX_VIEWPORTS_TALL, in which case the bottom is dropped. */
  capturedHeight: number;
  /** True when the page was taller than MAX_VIEWPORTS_TALL viewports and
   *  the capture was truncated. Surface to the user so they know not all
   *  of the page made it into the screenshot. */
  wasCapped: boolean;
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

// Cap the full-page capture so the MV3 service worker isn't killed by the
// 30s idle-shutdown mid-stitch on monster pages. 30 viewports ≈ 18s of
// settle + capture time, leaving headroom for the streaming stitch.
const MAX_VIEWPORTS_TALL = 30;

// JPEG quality for the stitched output. q=0.85 is roughly 5–10× smaller
// than PNG with no perceptible loss for screenshot content (text +
// rectangles). Annotations are composited later in the side panel, so
// re-encode loss is one generation, not two.
const STITCHED_JPEG_QUALITY = 0.85;

export async function captureFullPage(tabId: number): Promise<FullPageCapture> {
  const dims = await measure(tabId);

  // Truncate over-tall pages — better to ship a partial screenshot than to
  // race the SW idle-kill or OOM the worker mid-stitch.
  const maxHeight = dims.viewportHeight * MAX_VIEWPORTS_TALL;
  const wasCapped = dims.pageHeight > maxHeight;
  const capturedHeight = wasCapped ? maxHeight : dims.pageHeight;
  if (wasCapped) {
    console.warn(
      `[pinta] page is ${dims.pageHeight}px tall (>${MAX_VIEWPORTS_TALL} viewports). ` +
        `Capturing the first ${capturedHeight}px. Consider per-viewport export instead.`,
    );
  }

  const captures: { dataUrl: string; offsetY: number }[] = [];

  let y = 0;
  while (true) {
    const targetY = Math.min(y, Math.max(0, capturedHeight - dims.viewportHeight));
    await scrollTo(tabId, targetY);
    await sleep(SETTLE_MS);
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    captures.push({ dataUrl, offsetY: targetY });
    if (targetY + dims.viewportHeight >= capturedHeight) break;
    y += dims.viewportHeight;
  }

  // Restore original scroll position.
  await scrollTo(tabId, dims.scrollY);

  const stitched = await stitch(captures, dims, capturedHeight);
  return {
    dataUrl: stitched,
    slices: captures,
    pageWidth: dims.pageWidth,
    pageHeight: dims.pageHeight,
    capturedHeight,
    wasCapped,
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

async function stitch(
  captures: { dataUrl: string; offsetY: number }[],
  dims: PageDims,
  capturedHeight: number,
): Promise<string> {
  const oc = new OffscreenCanvas(dims.pageWidth, capturedHeight);
  const ctx = oc.getContext("2d");
  if (!ctx) throw new Error("no 2d context on OffscreenCanvas");

  // Pre-fill so any uncovered pixel encodes as white in JPEG (no alpha).
  // In practice every pixel ends up covered by a slice, but a defensive
  // background avoids black bands if a future change leaves gaps.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, oc.width, oc.height);

  // Stream — fetch → decode → drawImage → close per slice. Holding all
  // bitmaps in memory (Promise.all) was a peak-memory liability on long
  // pages: at 1920×1080 DPR 2 each bitmap is ~16MB raw, so 20 viewports
  // pinned ~320MB and routinely OOM-killed the MV3 worker.
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    const blob = await fetch(cap.dataUrl).then((r) => r.blob());
    const bm = await createImageBitmap(blob);
    // Source = full physical bitmap; destination = scaled to CSS viewport size.
    ctx.drawImage(
      bm,
      0,
      0,
      bm.width,
      bm.height,
      0,
      cap.offsetY,
      dims.viewportWidth,
      dims.viewportHeight,
    );
    bm.close();
  }

  // JPEG over PNG: 5–10× smaller for screenshot content. The agent gets
  // a smaller payload over WS and the vision tokens shrink proportionally.
  const finalBlob = await oc.convertToBlob({
    type: "image/jpeg",
    quality: STITCHED_JPEG_QUALITY,
  });
  return await blobToDataUrl(finalBlob);
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
