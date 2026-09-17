// Device-frame helpers shared by the service worker, the side panel and
// the Devices canvas: canvas-page URL recognition, target-URL
// normalization and the frame screenshot crop geometry. Split out of
// lib/devices.ts so the service worker / App.svelte don't pull in the
// device catalog and layout code. NO imports — keep this file tiny.

// ---------------------------------------------------------------------------
// Device-frame messaging gates

/**
 * There is NO window.postMessage relay between the side panel and a device
 * frame. A framed page's MAIN world receives every message posted to its
 * window and can post to its parent as that same window, so anything carried
 * that way (annotation outerHTML / comments, variant markup) leaks to the
 * page, and anything read back can be forged. Instead:
 *   panel -> frame:           chrome.tabs.sendMessage(tabId, msg, { frameId })
 *   frame -> panel / canvas:  chrome.runtime.sendMessage from the overlay
 * Both reach a sandboxed http(s) iframe inside the extension canvas tab
 * (verified in Chromium: the frame's runtime messages arrive with its real
 * sender.frameId, and a frame-targeted tabs.sendMessage is delivered).
 * The only window messages left are control pings with no page data:
 * pinta-annotate {on, token}, pinta-nav-start / pinta-nav-stop, pinta-nav.
 */

/** Overlay -> canvas: "annotation is live (or not) in this frame". Sent
 *  over chrome.runtime so a page can't forge it; `token` echoes the canvas
 *  frame id from the activation ping so the canvas knows which frame. */
export const ANNOTATE_ACK_MESSAGE = "devices.annotate-ack";

/** Minimal shape of chrome.runtime.MessageSender the gates need. */
export type FrameSenderLike =
  | { id?: string; frameId?: number; url?: string; tab?: { id?: number } | null }
  | null
  | undefined;

/**
 * True only for a runtime message sent DIRECTLY by this extension's content
 * script in a sub-frame (frameId > 0) of tab `tabId`. A copy forwarded by an
 * extension page has no frameId; a page script can't send one at all.
 */
export function isDirectSubframeSender(
  sender: FrameSenderLike,
  extId: string,
  tabId: number | null | undefined,
): boolean {
  return (
    !!sender &&
    !!extId &&
    sender.id === extId &&
    typeof tabId === "number" &&
    sender.tab?.id === tabId &&
    typeof sender.frameId === "number" &&
    Number.isInteger(sender.frameId) &&
    sender.frameId > 0
  );
}

/**
 * The page URL a device frame's `overlay.ready` may adopt: http(s) only, on
 * the same origin as the browser-reported `sender.url` of that frame.
 * Returns "" when the claim is unusable.
 */
export function deviceFrameReadyUrl(url: unknown, senderUrl: string | undefined): string {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url) || !senderUrl) return "";
  try {
    const claimed = new URL(url);
    const actual = new URL(senderUrl);
    if (!/^https?:$/.test(actual.protocol)) return "";
    return claimed.origin === actual.origin ? url : "";
  } catch {
    return "";
  }
}

/** Parse an annotate ack; null when `msg` isn't a well-formed one. */
export function parseAnnotateAck(msg: unknown): { token: string; on: boolean } | null {
  const m = msg as { type?: unknown; token?: unknown; on?: unknown } | null;
  if (!m || m.type !== ANNOTATE_ACK_MESSAGE) return null;
  if (typeof m.token !== "string" || m.token === "" || typeof m.on !== "boolean") return null;
  return { token: m.token, on: m.on };
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
