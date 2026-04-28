// Bundles companion entries into self-contained CJS files so the published
// npm package has zero npm dependencies to resolve at install time.
//
// Inputs:  src/cli.ts, src/mcp-stdio.ts (TS, ESM source)
// Outputs: dist/cli.cjs, dist/mcp-stdio.cjs (CJS, all deps inlined except
//          node built-ins)

import { build } from "esbuild";
import { rmSync, mkdirSync, readFileSync } from "node:fs";

const outdir = "dist";
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  // node built-ins stay external; everything else (ws, MCP SDK, shared
  // workspace types, zod) gets inlined.
  external: [],
  sourcemap: "linked",
  legalComments: "none",
  minify: false,
  // Inject the package version so registry entries can advertise it
  // for skew detection. Stays a `typeof` guard at the source level so
  // dev (tsx) runs as "dev" until the bundle ships.
  define: {
    __PINTA_VERSION__: JSON.stringify(pkg.version),
  },
  // (source files already start with `#!/usr/bin/env node` — esbuild
  // preserves it, so no banner needed.)
  logLevel: "info",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/cli.ts"],
    outfile: `${outdir}/cli.cjs`,
  }),
  build({
    ...shared,
    entryPoints: ["src/mcp-stdio.ts"],
    outfile: `${outdir}/mcp-stdio.cjs`,
  }),
]);

console.log(`\nbundled → ${outdir}/cli.cjs, ${outdir}/mcp-stdio.cjs`);
