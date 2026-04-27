/// <reference types="chrome" />

// Captures a full-page screenshot of the given tab by scroll-and-stitch.
// Runs in the background service worker (only it can call captureVisibleTab
// on arbitrary tabs).
//
// Returns a base64 PNG data URL. The image is in CSS pixels — captured
// physical bitmaps are downscaled to viewport dimensions during stitch
// so consumers (the compositor) don't need to track DPR.

export type FullPageCapture = {
  dataUrl: string;
  /** Page dimensions in CSS pixels — same coordinate space as Annotation strokes. */
  pageWidth: number;
  pageHeight: number;
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

export async function captureFullPage(tabId: number): Promise<FullPageCapture> {
  const dims = await measure(tabId);
  const captures: { dataUrl: string; offsetY: number }[] = [];

  let y = 0;
  while (true) {
    const targetY = Math.min(y, Math.max(0, dims.pageHeight - dims.viewportHeight));
    await scrollTo(tabId, targetY);
    await sleep(SETTLE_MS);
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    captures.push({ dataUrl, offsetY: targetY });
    if (targetY + dims.viewportHeight >= dims.pageHeight) break;
    y += dims.viewportHeight;
  }

  // Restore original scroll position.
  await scrollTo(tabId, dims.scrollY);

  const stitched = await stitch(captures, dims);
  return {
    dataUrl: stitched,
    pageWidth: dims.pageWidth,
    pageHeight: dims.pageHeight,
    devicePixelRatio: dims.devicePixelRatio,
  };
}

async function measure(tabId: number): Promise<PageDims> {
  const [{ result }] = await chrome.scripting.executeScript({
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
  if (!result) throw new Error("could not measure page");
  return result;
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
): Promise<string> {
  const blobs = await Promise.all(
    captures.map((c) => fetch(c.dataUrl).then((r) => r.blob())),
  );
  const bitmaps = await Promise.all(blobs.map((b) => createImageBitmap(b)));

  const oc = new OffscreenCanvas(dims.pageWidth, dims.pageHeight);
  const ctx = oc.getContext("2d");
  if (!ctx) throw new Error("no 2d context on OffscreenCanvas");

  for (let i = 0; i < bitmaps.length; i++) {
    const bm = bitmaps[i]!;
    const offsetY = captures[i]!.offsetY;
    // Source = full physical bitmap; destination = scaled to CSS viewport size.
    ctx.drawImage(
      bm,
      0,
      0,
      bm.width,
      bm.height,
      0,
      offsetY,
      dims.viewportWidth,
      dims.viewportHeight,
    );
    bm.close();
  }

  const finalBlob = await oc.convertToBlob({ type: "image/png" });
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
