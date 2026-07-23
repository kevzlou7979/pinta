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
  ],
  host_permissions: ["<all_urls>"],
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
  ],
});
