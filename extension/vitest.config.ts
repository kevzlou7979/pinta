import { defineConfig } from "vitest/config";

// Standalone vitest config — does NOT extend vite.config.ts because the
// CRX plugin there requires a manifest entry that breaks under Vitest's
// loader. Tests are pure logic for now (no Svelte component rendering),
// so a plain Node environment is enough. If/when we add component tests,
// switch `environment` to "jsdom" and pull in the svelte plugin here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
