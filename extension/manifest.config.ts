import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "Pinta",
  version: pkg.version || "0.0.1",
  description:
    "Pinta — annotate your running app and hand the changes to a coding agent.",
  action: {
    default_popup: "src/popup/index.html",
    default_title: "Pinta",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  permissions: ["sidePanel", "tabs", "activeTab", "scripting", "storage"],
  host_permissions: ["<all_urls>"],
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/overlay.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
});
