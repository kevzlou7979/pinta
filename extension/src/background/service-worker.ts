/// <reference types="chrome" />

import { captureFullPage } from "./screenshot.js";
import {
  WATCH_PORTS_KEY,
  WATCH_TOASTED_KEY,
  WATCH_PENDING_KEY,
  MODULES_STORE_KEY,
  filterUntoasted,
  appendToasted,
  mergePending,
  moduleWantsToast,
  raiseWatchToast,
  setIconBadge,
  fetchWatchEvents,
  type WatchPending,
} from "../lib/watch-notify.js";

// Always show the side panel button on the extension toolbar action.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[pinta] sidePanel setup failed", err));
});

// ─── Task-watcher background poll ────────────────────────────────────
// The side panel's WS delivers watch nudges instantly while it's OPEN;
// this alarm covers the panel-CLOSED case: poll each known companion's
// `GET /v1/watch/events` and raise the Chrome notification + toolbar
// badge from here. Both paths share the `pinta-watch-toasted` id set so
// an item is toasted exactly once. The poll is a couple of localhost
// GETs a minute — no agent, no tokens, battery-negligible.
const WATCH_ALARM = "pinta-watch-poll";
chrome.alarms?.create(WATCH_ALARM, { periodInMinutes: 1 });

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCH_ALARM) return;
  void pollWatchEvents();
});

async function pollWatchEvents(): Promise<void> {
  try {
    const s = await chrome.storage.local.get([
      WATCH_PORTS_KEY,
      WATCH_TOASTED_KEY,
      WATCH_PENDING_KEY,
      MODULES_STORE_KEY,
    ]);
    const ports = Array.isArray(s[WATCH_PORTS_KEY])
      ? (s[WATCH_PORTS_KEY] as number[])
      : [];
    if (ports.length === 0) return;
    let toasted = Array.isArray(s[WATCH_TOASTED_KEY])
      ? (s[WATCH_TOASTED_KEY] as string[])
      : [];
    let pending = (s[WATCH_PENDING_KEY] ?? null) as WatchPending | null;
    const modules = s[MODULES_STORE_KEY] as
      | Record<string, { enabled?: boolean; settings?: Record<string, string | boolean> }>
      | undefined;

    let dirty = false;
    for (const port of ports) {
      for (const ev of await fetchWatchEvents(port)) {
        // Module-scoped: drop nudges without an installed+enabled owner.
        if (!ev.moduleId || !modules?.[ev.moduleId]?.enabled) continue;
        const fresh = filterUntoasted(ev.items, toasted);
        if (fresh.length === 0) continue;
        toasted = appendToasted(
          toasted,
          fresh.map((i) => i.id),
        );
        pending = mergePending(pending, ev.moduleId, fresh);
        dirty = true;
        if (moduleWantsToast(modules, ev.moduleId)) {
          raiseWatchToast(ev.title, fresh);
        }
      }
    }
    if (dirty) {
      await chrome.storage.local.set({
        [WATCH_TOASTED_KEY]: toasted,
        [WATCH_PENDING_KEY]: pending,
      });
      setIconBadge(pending?.items.length ?? 0);
    }
  } catch (err) {
    console.warn("[pinta] watch poll failed", err);
  }
}

// Clicking the nudge opens the side panel (a notification click is a user
// gesture, which sidePanel.open requires).
chrome.notifications?.onClicked.addListener((id) => {
  if (!id.startsWith("pinta-watch")) return;
  chrome.notifications.clear(id);
  chrome.windows
    .getLastFocused()
    .then((w) => {
      if (w.id != null) return chrome.sidePanel.open({ windowId: w.id });
    })
    .catch(() => {});
});

// ─── Side-panel presence ─────────────────────────────────────────────
// The floating toolbar should only show while the Pinta side panel is open.
// The panel holds a long-lived "pinta-panel" port for its lifetime; when it
// closes the port disconnects. We track that + broadcast it to content
// scripts so they can show/hide the on-page toolbar.
let panelPorts = 0;
function panelOpen(): boolean {
  return panelPorts > 0;
}
function broadcastPanelState(): void {
  const open = panelOpen();
  chrome.tabs.query({}).then((tabs) => {
    for (const t of tabs) {
      if (t.id != null) {
        chrome.tabs
          .sendMessage(t.id, { type: "panel.state", open })
          .catch(() => {});
      }
    }
  });
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pinta-panel") return;
  panelPorts += 1;
  if (panelPorts === 1) broadcastPanelState();
  port.onDisconnect.addListener(() => {
    panelPorts = Math.max(0, panelPorts - 1);
    if (panelPorts === 0) broadcastPanelState();
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "panel.query") {
    sendResponse({ open: panelOpen() });
    return false;
  }
  // Drop messages that didn't originate from this extension. Chrome's
  // default delivery already enforces this, but pin it down explicitly
  // so adding `externally_connectable` later doesn't quietly open up
  // these privileged paths (sidepanel.open, captureFullPage).
  if (sender?.id !== chrome.runtime.id) return false;

  if (msg?.type === "open-side-panel") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (typeof tabId === "number") {
      chrome.sidePanel.open({ tabId }).then(
        () => sendResponse({ ok: true }),
        (err: Error) => sendResponse({ ok: false, error: err.message }),
      );
      return true;
    }
  }

  if (msg?.type === "ensure-content-script") {
    // MV3 only auto-injects content scripts into tabs loaded AFTER the
    // extension starts — a tab that was already open has no overlay until
    // reloaded. Inject it on demand (when Pinta opens / the tab changes) so
    // the floating toolbar + overlay appear without a manual page reload.
    // overlay.ts self-guards on its host tag, so re-injection is idempotent.
    const tabId = msg.tabId ?? sender.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "no tabId" });
      return false;
    }
    const scripts = (chrome.runtime.getManifest().content_scripts ?? []).filter(
      // Skip the MAIN-world reload-guard (document_start, dev-only HMR hold) —
      // only the ISOLATED overlay renders the UI.
      (cs) => cs.world !== "MAIN" && Array.isArray(cs.js) && cs.js.length > 0,
    );
    Promise.all(
      scripts.map((cs) =>
        chrome.scripting
          .executeScript({ target: { tabId }, files: cs.js as string[] })
          .catch(() => {}),
      ),
    ).then(
      () => sendResponse({ ok: true }),
      (err: Error) => sendResponse({ ok: false, error: err.message }),
    );
    return true;
  }

  if (msg?.type === "capture.full-page") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "no tabId" });
      return false;
    }
    captureFullPage(tabId).then(
      (capture) => sendResponse({ ok: true, capture }),
      (err: Error) => {
        console.error("[pinta] capture failed", err);
        sendResponse({ ok: false, error: err.message });
      },
    );
    return true;
  }
});

// ─── Voice Command relay (Phase 20) ──────────────────────────────────
//
// Surfaces (side panel + content scripts) open a long-lived "voice" port
// to dictate. We own ONE offscreen document that holds the mic + Web
// Speech recognition (port name "voice-offscreen"), and route its
// transcripts back down ONLY the surface port that started — so two tabs
// never cross streams. Keeping the offscreen doc warm between utterances
// avoids re-creating it on every mic click.

let offscreenPort: chrome.runtime.Port | null = null;
let activeVoicePort: chrome.runtime.Port | null = null;
let offscreenWaiters: Array<(p: chrome.runtime.Port | null) => void> = [];

async function ensureOffscreenReady(): Promise<chrome.runtime.Port | null> {
  if (offscreenPort) return offscreenPort;
  try {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: "src/offscreen/offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Microphone access for Voice Command speech-to-text.",
      });
    }
  } catch (err) {
    console.error("[pinta] offscreen create failed", err);
    return null;
  }
  if (offscreenPort) return offscreenPort;
  // The offscreen doc connects its port on load; wait for it (bounded).
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      offscreenWaiters = offscreenWaiters.filter((w) => w !== onReady);
      resolve(offscreenPort);
    }, 3000);
    const onReady = (p: chrome.runtime.Port | null) => {
      clearTimeout(timer);
      resolve(p);
    };
    offscreenWaiters.push(onReady);
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "voice-offscreen") {
    offscreenPort = port;
    const waiters = offscreenWaiters;
    offscreenWaiters = [];
    waiters.forEach((w) => w(port));
    // Mic → the surface that started. The offscreen doc only ever has one
    // recognizer running, so a single active port is correct.
    port.onMessage.addListener((msg) => {
      activeVoicePort?.postMessage(msg);
    });
    port.onDisconnect.addListener(() => {
      if (offscreenPort === port) offscreenPort = null;
    });
    return;
  }

  if (port.name === "voice") {
    port.onMessage.addListener((msg) => {
      if (msg?.t === "start") {
        activeVoicePort = port;
        void ensureOffscreenReady().then((op) => {
          if (!op) {
            try {
              port.postMessage({ t: "error", code: "offscreen-failed" });
            } catch {
              /* port already gone */
            }
            return;
          }
          op.postMessage({ t: "start", lang: msg.lang ?? "en-US" });
        });
      } else if (msg?.t === "stop") {
        offscreenPort?.postMessage({ t: "stop" });
      }
    });
    port.onDisconnect.addListener(() => {
      if (activeVoicePort === port) {
        offscreenPort?.postMessage({ t: "stop" });
        activeVoicePort = null;
      }
    });
    return;
  }
});
