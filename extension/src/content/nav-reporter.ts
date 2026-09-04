// Phase 24 — Devices nav-sync reporter. Declared in the manifest for
// ALL frames (http/https) but inert everywhere: a single message
// listener that does nothing until the Pinta Devices canvas asks it to
// start — and only a page on OUR extension origin can ask (event.origin
// check). Once started it reports this frame's URL to the parent canvas
// on every navigation (polling catches SPA route changes the isolated
// world can't observe via history patching), addressed ONLY to the
// extension origin so reports can never leak to an arbitrary embedder.

const EXT_ORIGIN = new URL(chrome.runtime.getURL("")).origin;

let started = false;

window.addEventListener("message", (e: MessageEvent) => {
  if (e.origin !== EXT_ORIGIN) return;
  const data = e.data as { type?: unknown } | null;
  if (!data || data.type !== "pinta-nav-start") return;
  // Only meaningful inside a frame whose parent is the canvas page.
  if (window.top === window.self || started) return;
  started = true;

  let last = "";
  const report = (): void => {
    if (location.href === last) return;
    last = location.href;
    window.parent.postMessage(
      { type: "pinta-nav", url: location.href },
      EXT_ORIGIN,
    );
  };
  window.addEventListener("popstate", report);
  window.addEventListener("hashchange", report);
  setInterval(report, 600);
  report();
});
