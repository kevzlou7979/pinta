import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config.js";

export default defineConfig({
  plugins: [svelte(), crx({ manifest })],
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        sidepanel: "src/sidepanel/index.html",
        popup: "src/popup/index.html",
      },
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    hmr: { port: 5181 },
  },
});
