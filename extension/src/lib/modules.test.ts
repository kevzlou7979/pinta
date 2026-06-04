import { describe, expect, it } from "vitest";
import { manifestToSpec, BUILTIN_MODULES } from "./modules.js";
import type { ModuleManifest } from "@pinta/shared";

/**
 * Phase 19 — `manifestToSpec` adapts an imported module's on-disk
 * manifest into the `ModuleSpec` shape the Settings panel + submit
 * footer already render, so a third-party module needs no bundled code.
 */
describe("manifestToSpec", () => {
  const manifest: ModuleManifest = {
    id: "acme.echo-notes",
    name: "Echo Notes",
    version: "1.0.0",
    author: "Acme",
    description: "Append each annotation comment to NOTES.md.",
    mode: "per-submit",
    sessionCheckboxLabel: "Append to NOTES.md",
    sessionCheckboxHint: "Write each comment to the project's NOTES.md.",
    settings: [{ key: "path", type: "string", label: "Target file" }],
    recommendsScreenshot: true,
    capabilities: ["write-files"],
  };

  it("carries the fields the UI renders", () => {
    const spec = manifestToSpec(manifest);
    expect(spec.id).toBe("acme.echo-notes");
    expect(spec.name).toBe("Echo Notes");
    expect(spec.mode).toBe("per-submit");
    expect(spec.sessionCheckboxLabel).toBe("Append to NOTES.md");
    expect(spec.recommendsScreenshot).toBe(true);
    expect(spec.settings).toHaveLength(1);
  });

  it("defaults settings to an empty array when the manifest omits them", () => {
    const { settings, ...rest } = manifest;
    void settings;
    const spec = manifestToSpec(rest as ModuleManifest);
    expect(spec.settings).toEqual([]);
  });

  it("does not collide with a built-in module id", () => {
    // Sanity: an imported module is expected to be namespaced (dotted),
    // so it can never shadow a built-in like `gitlab-issues`.
    const builtinIds = BUILTIN_MODULES.map((m) => m.id);
    expect(builtinIds).not.toContain(manifest.id);
    expect(manifest.id).toContain(".");
  });
});
