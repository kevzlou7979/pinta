// Runs in the PAGE'S MAIN WORLD at document_start (see manifest) — before
// `@vite/client` opens its HMR socket. Its only job: when Pinta is holding
// reloads for this tab (auto-reload off), swallow the dev server's Vite HMR
// `full-reload` frames so the page can't refresh out from under an
// in-progress annotation. Everything else — partial HMR updates, non-Vite
// sockets, other pages — passes through untouched.
//
// The hold flag is a shared-DOM signal: the side panel writes
// `document.documentElement.dataset.pintaHoldReload = "1"` on the Pinta tab
// (via chrome.scripting) whenever auto-reload is off; we read it live at
// message time. When a full-reload is swallowed we mark
// `dataset.pintaReloadPending` so the UI can hint "reload to see changes".
//
// Scope note: this only affects the Vite HMR socket (subprotocol
// `vite-hmr`). Webpack/Next/Parcel HMR use different transports and are not
// covered here.

(() => {
  const RawWS = window.WebSocket;
  // Guard against double-wrapping (e.g. re-injection) and missing WS.
  if (!RawWS || (RawWS as unknown as { __pintaWrapped?: boolean }).__pintaWrapped)
    return;

  const holding = (): boolean =>
    document.documentElement.dataset.pintaHoldReload === "1";

  const isViteHmr = (protocols?: string | string[]): boolean =>
    protocols === "vite-hmr" ||
    (Array.isArray(protocols) && protocols.includes("vite-hmr"));

  // A Vite HMR frame is JSON; only a `full-reload` frame triggers a page
  // refresh. Cheap substring pre-check before the JSON parse.
  const isFullReload = (data: unknown): boolean => {
    if (typeof data !== "string" || data.indexOf("full-reload") === -1)
      return false;
    try {
      const msg = JSON.parse(data) as { type?: unknown };
      return msg?.type === "full-reload";
    } catch {
      return false;
    }
  };

  const Wrapped = function (
    this: unknown,
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    const ws = new RawWS(url, protocols);
    if (isViteHmr(protocols)) {
      const rawAdd = ws.addEventListener.bind(ws) as WebSocket["addEventListener"];
      // Intercept `message` listeners so we can drop full-reload frames
      // before Vite's own handler ever sees them (its handler is what calls
      // location.reload(), so swallowing the frame is enough).
      (ws as unknown as { addEventListener: WebSocket["addEventListener"] }).addEventListener =
        function (type: string, listener: unknown, opts?: unknown) {
          if (type === "message" && typeof listener === "function") {
            const gate = (ev: MessageEvent) => {
              if (holding() && isFullReload(ev.data)) {
                document.documentElement.dataset.pintaReloadPending = "1";
                return; // swallow — page stays put
              }
              return (listener as (e: MessageEvent) => unknown).call(ws, ev);
            };
            return rawAdd(type as "message", gate as EventListener, opts as never);
          }
          return rawAdd(
            type as keyof WebSocketEventMap,
            listener as EventListener,
            opts as never,
          );
        };
    }
    return ws;
  } as unknown as typeof WebSocket;

  // Preserve the WebSocket surface (instanceof, ready-state constants).
  Wrapped.prototype = RawWS.prototype;
  (Wrapped as unknown as Record<string, unknown>).CONNECTING = RawWS.CONNECTING;
  (Wrapped as unknown as Record<string, unknown>).OPEN = RawWS.OPEN;
  (Wrapped as unknown as Record<string, unknown>).CLOSING = RawWS.CLOSING;
  (Wrapped as unknown as Record<string, unknown>).CLOSED = RawWS.CLOSED;
  (Wrapped as unknown as { __pintaWrapped: boolean }).__pintaWrapped = true;

  try {
    window.WebSocket = Wrapped;
  } catch {
    // If the page froze WebSocket we simply can't guard — leave it be.
  }
})();
