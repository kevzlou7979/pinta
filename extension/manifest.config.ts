import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "Pinta",
  version: pkg.version || "0.0.1",
  description:
    "Pinta — annotate your running app and hand the changes to a coding agent.",
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_title: "Pinta",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  // Chrome Web Store justification for each permission (keep in sync with the
  // store listing's "Permission justification" fields):
  //   sidePanel  — Pinta's whole UI is a side panel.
  //   tabs       — resolve the active tab + its URL to target the annotated page.
  //   activeTab  — inject the overlay / capture only the tab the user is on.
  //   scripting  — inject the content-script overlay + measure/scroll for capture.
  //   storage    — persist settings, modules, and session cache locally.
  //   offscreen  — Voice Command: hosts the mic + Web Speech recognition in a
  //                single offscreen document (a service worker can't use the
  //                Web Speech API). Opt-in per project in Settings; audio never
  //                leaves the machine.
  permissions: [
    "sidePanel",
    "tabs",
    "activeTab",
    "scripting",
    "storage",
    "offscreen",
    "notifications",
    "alarms",
  ],
  host_permissions: ["<all_urls>"],
  // Extension-page CSP — TIGHTENS the MV3 default (script-src/object-src
  // unchanged). Agent-generated variant markup renders as live DOM in the
  // side panel (shadow-root cards), so remote image / media / font loads
  // are blocked at the platform level as well as by the sanitizer.
  // Allowed image sources: bundled assets, data:/blob: (pasted images,
  // screenshots) and the local companion (report / module-card shots on
  // http://127.0.0.1:<port>). connect-src and frame-src are deliberately
  // NOT set: the companion WS/HTTP and the Devices / Pages-gallery iframes
  // of arbitrary http(s) dev servers must keep working.
  content_security_policy: {
    extension_pages:
      "script-src 'self'; object-src 'self'; " +
      "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*; " +
      "media-src 'self' data: blob:; font-src 'self' data:; " +
      "style-src 'self' 'unsafe-inline'",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/overlay.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
    {
      // Main-world reload guard — must run BEFORE @vite/client connects so it
      // can wrap WebSocket and swallow Vite HMR full-reload frames while Pinta
      // is holding reloads for this tab (auto-reload off). See reload-guard.ts.
      matches: ["<all_urls>"],
      js: ["src/content/reload-guard.ts"],
      run_at: "document_start",
      world: "MAIN",
      all_frames: false,
    },
    {
      // Phase 24 — Devices nav-sync reporter: an inert message listener in
      // every frame, activated only by the Devices canvas (verified by the
      // extension origin of the activation message). Declared here because
      // scripting.executeScript can't target a tab whose TOP frame is the
      // extension's own canvas page. See nav-reporter.ts.
      matches: ["http://*/*", "https://*/*"],
      js: ["src/content/nav-reporter.ts"],
      run_at: "document_idle",
      all_frames: true,
    },
  ],
});
