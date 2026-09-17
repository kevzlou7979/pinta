// Phase 24 — Devices nav-sync reporter. Declared in the manifest for
// ALL frames (http/https) but inert everywhere: a single message
// listener that does nothing until the Pinta Devices canvas asks it to
// start — and only a page on OUR extension origin can ask (event.origin
// check). Once started it reports this frame's URL to the parent canvas
// on every navigation (polling catches SPA route changes the isolated
// world can't observe via history patching), addressed ONLY to the
// extension origin so reports can never leak to an arbitrary embedder.
//
// It is also the gateway for annotating inside a device frame: when the
// canvas marks THIS frame as the annotation target ("pinta-annotate"),
// the annotate overlay is imported on demand. Frames the canvas never
// targets — and every iframe on every other site — never load it.

const EXT_ORIGIN = new URL(chrome.runtime.getURL("")).origin;

let started = false;
let overlayRequested = false;

/** URL of the built overlay module. Resolved from the manifest's web-
 *  accessible resources (the chunk name is content-hashed) and imported
 *  directly — a bundler dynamic import would inject <link rel=modulepreload>
 *  tags into the host page, which strict page CSPs block. */
function overlayModuleUrl(): string | null {
  for (const entry of chrome.runtime.getManifest().web_accessible_resources ?? []) {
    const resources = typeof entry === "string" ? [entry] : (entry.resources ?? []);
    const hit = resources.find((r) => /(^|\/)overlay\.ts[^/]*\.js$/.test(r));
    if (hit) return chrome.runtime.getURL(hit);
  }
  return null;
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.origin !== EXT_ORIGIN || e.source !== window.parent) return;
  const data = e.data as { type?: unknown; on?: unknown; token?: unknown } | null;
  if (data?.type === "pinta-annotate") {
    // First activation loads the overlay; later on/off toggles are handled
    // by the overlay's own listener (overlay.ts).
    if (window.top === window.self || data.on !== true || overlayRequested) return;
    const url = overlayModuleUrl();
    if (!url) {
      console.error("[pinta] annotate overlay module not found in the manifest");
      return;
    }
    overlayRequested = true;
    const g = globalThis as { __pintaFrameAnnotate?: boolean; __pintaFrameToken?: string };
    g.__pintaFrameAnnotate = true;
    // The canvas's id for this frame — the overlay echoes it in its runtime ack.
    g.__pintaFrameToken = typeof data.token === "string" ? data.token : "";
    import(/* @vite-ignore */ url).catch((err: unknown) => {
      overlayRequested = false;
      console.error("[pinta] couldn't load the annotate overlay in this frame", err);
    });
    return;
  }
  if (data?.type === "pinta-nav-stop") {
    stopReporting();
    return;
  }
  if (!data || data.type !== "pinta-nav-start") return;
  // Only meaningful inside a frame whose parent is the canvas page.
  if (window.top === window.self || started) return;
  started = true;
  lastReported = "";
  window.addEventListener("popstate", report);
  window.addEventListener("hashchange", report);
  pollTimer = setInterval(report, 600);
  report();
});

let lastReported = "";
let pollTimer: ReturnType<typeof setInterval> | null = null;

function report(): void {
  if (location.href === lastReported) return;
  lastReported = location.href;
  window.parent.postMessage({ type: "pinta-nav", url: location.href }, EXT_ORIGIN);
}

/** Sync turned off on the canvas: stop polling until the next start ping. */
function stopReporting(): void {
  if (!started) return;
  started = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  window.removeEventListener("popstate", report);
  window.removeEventListener("hashchange", report);
}
