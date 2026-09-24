// Real-Chromium layout regression harness (see README.md). Builds a tiny page
// that mounts the REAL SettingsPanel inside a copy of the side-panel shell.
// Run from extension/ so Tailwind's `./src/**/*` content globs resolve.
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: "./",
  plugins: [svelte({ configFile: resolve(here, "../svelte.config.js") })],
  build: {
    target: "esnext",
    modulePreload: false,
    // Outside the repo; override with E2E_LAYOUT_OUT.
    outDir: process.env.E2E_LAYOUT_OUT || resolve(tmpdir(), "pinta-e2e-layout-dist"),
    emptyOutDir: true,
  },
});
