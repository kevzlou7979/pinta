import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config.js";

export default defineConfig({
  plugins: [svelte(), crx({ manifest })],
  build: {
    target: "esnext",
    // Keeps <link rel=modulepreload> out of the build. The preload helper
    // itself is still emitted and still imported by nav-reporter.ts (which
    // dynamic-imports the overlay in a Devices frame), but with no deps to
    // preload it never reaches its import.meta branch — that branch parsed
    // as a syntax error when crxjs emitted nav-reporter as a CLASSIC
    // script, which silently disabled nav sync and frame annotation.
    // Extension pages load chunks from local disk, so the hints buy
    // nothing anyway. The staging skill greps built content scripts for
    // import.meta to keep this from regressing.
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: "src/sidepanel/index.html",
        popup: "src/popup/index.html",
        // Offscreen document that owns the mic for Voice Command. Created
        // at runtime via chrome.offscreen.createDocument; listed here so
        // the page + its module script are emitted to the build output.
        offscreen: "src/offscreen/offscreen.html",
        // Full-tab device canvas (Phase 24) — opened by the side panel
        // via chrome.runtime.getURL("src/devices/index.html").
        devices: "src/devices/index.html",
        // Full-screen Design Variants preview — opened by the side panel
        // via chrome.runtime.getURL("src/variant-preview/index.html?k=…");
        // renders the variant in an empty-sandbox srcdoc iframe.
        "variant-preview": "src/variant-preview/index.html",
      },
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    hmr: { port: 5181 },
  },
});
