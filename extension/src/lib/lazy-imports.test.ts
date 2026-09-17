import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source guards for the lazy-loading fixes (P1, P2). The real proof is the
// built dist (checked in staging); these catch a static import creeping
// back in during an edit, which the bundle would silently re-hoist.
const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/** Value (non-type) static import specifiers in a TS/Svelte source. */
function staticImports(code: string): string[] {
  const out: string[] = [];
  const re = /^\s*import\s+(?!type\b)(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (let m = re.exec(code); m; m = re.exec(code)) out.push(m[1]!);
  return out;
}

describe("lazy imports stay lazy", () => {
  it("helper parses static vs type-only vs dynamic imports", () => {
    const code = [
      `import { a } from "x";`,
      `import type { B } from "y";`,
      `import "side-effect";`,
      `const z = await import("z");`,
      `  import * as NS from './ns.js';`,
    ].join("\n");
    expect(staticImports(code)).toEqual(["x", "side-effect", "./ns.js"]);
  });

  it("test-pilot-doc.ts loads fflate only on demand (P1)", () => {
    const code = src("lib/test-pilot-doc.ts");
    expect(staticImports(code)).not.toContain("fflate");
    expect(code).toMatch(/await import\(\s*["']fflate["']\s*\)/);
  });

  it("App.svelte does not statically import ChatSheet or prism-setup (P1)", () => {
    const imports = staticImports(src("sidepanel/App.svelte"));
    expect(imports.filter((s) => /ChatSheet\.svelte$|prism-setup/.test(s))).toEqual([]);
  });

  it("TestPilotTab / DesignVariantsTab load ChatSheet and prism on demand (F44)", () => {
    for (const file of ["sidepanel/TestPilotTab.svelte", "sidepanel/DesignVariantsTab.svelte"]) {
      const imports = staticImports(src(file));
      expect(imports.filter((s) => /ChatSheet\.svelte$|prism-setup/.test(s)), file).toEqual([]);
    }
    const lazy = src("lib/lazy-ui.ts");
    expect(staticImports(lazy)).toEqual([]);
    expect(lazy).toMatch(/import\(\s*["']\.\.\/sidepanel\/ChatSheet\.svelte["']\s*\)/);
    expect(lazy).toMatch(/import\(\s*["']\.\/prism-setup\.js["']\s*\)/);
  });

  it("Overlay.svelte does not statically import design-variants / variants-lib (P2)", () => {
    const imports = staticImports(src("content/Overlay.svelte"));
    expect(imports.filter((s) => /design-variants|variants-lib/.test(s))).toEqual([]);
  });
});
