import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Component suite — mounts side-panel components (SettingsPanel,
// TestPilotTab, …) and the runes-based state in happy-dom through the
// svelte plugin. Files are named `*.repro.test.ts`; `npm test` runs this
// alongside the pure-logic suite in vitest.config.ts.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ["browser"],
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.repro.test.ts"],
    // Each file cold-imports state.svelte.ts + Svelte components; with the
    // files running in parallel that alone can pass 5s. Seen 2026-09-24.
    testTimeout: 30000,
  },
});
