// Device-frame helpers shared by the service worker, the side panel and
// the Devices canvas: canvas-page URL recognition, target-URL
// normalization and the frame screenshot crop geometry. Split out of
// lib/devices.ts so the service worker / App.svelte don't pull in the
// device catalog and layout code. NO imports — keep this file tiny.

// ---------------------------------------------------------------------------
// Canvas relay allowlist

/**
 * What a device frame is allowed to say to the side panel through the
 * Devices canvas relay: panel UI state, nothing more.
 *
 * The relay is a page -> extension privilege boundary. A framed page can't
 * reach `chrome.runtime`, but its MAIN world shares both the
 * `contentWindow` identity and the origin of the overlay's isolated world,
 * so neither an `event.source` match nor an `event.origin` check can tell
 * the two apart. Keeping the relay away from side effects is the actual
 * defence — everything that reaches the agent or spends the user's tokens
 * must arrive over the direct `chrome.runtime.sendMessage` the overlay
 * also makes, which carries a real `sender.frameId` no page can forge.
 */
export const RELAYABLE_FRAME_MESSAGES: ReadonlySet<string> = new Set([
  "overlay.ready",
  "mode.changed",
  "frame.inactive",
  "transform.state",
  "imported.located",
  "variants.pick-cancelled",
  "variants.preview-failed",
  "variants.preview-restored",
]);

/** Messages that must NEVER be accepted from the relay — each one either
 *  reaches the agent or spends the user's tokens. Kept explicit so the
 *  rule is testable rather than implied by an absence. */
export const NEVER_RELAYABLE_FRAME_MESSAGES: readonly string[] = [
  "annotation.target-selected",
  "annotation.draw-committed",
  "variants.picked",
  "variants.verify-result",
  "variants.preview-apply",
  "toolbar.pick-image",
];

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
// Annotating inside device frames. One frame at a time hosts the annotate
// overlay; the side panel treats that frame as "the page".

/** Path of the Devices canvas page inside the extension package. */
export const DEVICES_PAGE_PATH = "src/devices/index.html";

/** True when `url` is the Devices canvas page of the extension whose
 *  root URL is `extRoot` (chrome.runtime.getURL("")). */
export function isDevicesCanvasUrl(url: string, extRoot: string): boolean {
  if (!url || !extRoot) return false;
  return url.startsWith(`${extRoot.replace(/\/?$/, "/")}${DEVICES_PAGE_PATH}`);
}

/** The app URL a Devices canvas page is showing (its `?url=` param),
 *  normalized to http(s). Empty string when absent or unusable. */
export function devicesCanvasTargetUrl(url: string): string {
  try {
    const q = new URL(url).searchParams.get("url");
    return q ? normalizeTargetUrl(q) : "";
  } catch {
    return "";
  }
}

/** Where the annotating frame sits on the canvas, as reported by the
 *  canvas page (CSS px of the canvas viewport). */
export type FrameRectReport = {
  /** iframe.getBoundingClientRect() — includes the scale transform. */
  rect: { x: number; y: number; width: number; height: number };
  /** iframe layout size before the transform = device viewport CSS px. */
  cssWidth: number;
  cssHeight: number;
  /** Canvas window viewport size (CSS px). */
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
};

export type FrameCaptureGeometry = {
  /** Source crop in the captured bitmap (physical px). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination in the output image (device CSS px). */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** Output image size = the device viewport in CSS px. */
  outWidth: number;
  outHeight: number;
  /** Frame scale on the canvas (1 = actual size). */
  scale: number;
  /** True when part of the frame was outside the canvas viewport. */
  clipped: boolean;
};

/**
 * Map a visible-tab capture of the canvas to the annotating frame's own
 * viewport: crop the (possibly scaled, possibly partly off-screen) iframe
 * box out of the bitmap and place it at its position inside a device-sized
 * output, so annotation coordinates (device CSS px) line up for
 * compositeAnnotationsToViewport. Returns null when no part is visible.
 */
export function frameCaptureGeometry(r: FrameRectReport): FrameCaptureGeometry | null {
  const { rect } = r;
  if (!(r.cssWidth > 0) || !(r.cssHeight > 0) || !(rect.width > 0)) return null;
  const scale = rect.width / r.cssWidth;
  const dpr = r.devicePixelRatio > 0 ? r.devicePixelRatio : 1;
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(r.viewportWidth, rect.x + rect.width);
  const bottom = Math.min(r.viewportHeight, rect.y + rect.height);
  if (right <= left || bottom <= top) return null;
  return {
    sx: Math.round(left * dpr),
    sy: Math.round(top * dpr),
    sw: Math.round((right - left) * dpr),
    sh: Math.round((bottom - top) * dpr),
    dx: (left - rect.x) / scale,
    dy: (top - rect.y) / scale,
    dw: (right - left) / scale,
    dh: (bottom - top) / scale,
    outWidth: Math.round(r.cssWidth),
    outHeight: Math.round(r.cssHeight),
    scale,
    clipped: left > rect.x || top > rect.y || right < rect.x + rect.width || bottom < rect.y + rect.height,
  };
}
