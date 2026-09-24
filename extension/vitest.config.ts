import { defineConfig } from "vitest/config";

// Pure-logic suite — a standalone vitest config that does NOT extend
// vite.config.ts because the CRX plugin there requires a manifest entry
// that breaks under Vitest's loader. Tests here run in a plain Node
// environment. The happy-dom component suite (`*.repro.test.ts`) runs
// through `vitest.repro.config.ts`; `npm test` runs both.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "src/**/*.repro.test.ts"],
  },
});
