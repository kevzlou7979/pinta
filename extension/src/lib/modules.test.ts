import { describe, expect, it } from "vitest";
import {
  manifestToSpec,
  BUILTIN_MODULES,
  sanitizeStoredModules,
} from "./modules.js";
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

/**
 * Regression — 2026-09-24 tester report: a `pinta-modules` entry without a
 * `settings` object crashed the Settings module list (`settings[key]` on
 * undefined) and blanked everything below the Modules accordion. Storage
 * is normalized on load so every entry always carries a settings object.
 */
describe("sanitizeStoredModules", () => {
  it("passes well-formed entries through", () => {
    const clean = sanitizeStoredModules({
      "test-pilot": { enabled: true, settings: { detailed_steps: false } },
    });
    expect(clean).toEqual({
      "test-pilot": { enabled: true, settings: { detailed_steps: false } },
    });
  });

  it("backfills a missing settings object", () => {
    const clean = sanitizeStoredModules({
      "test-pilot": { enabled: true },
      "gitlab-issues": { enabled: false, settings: null },
    });
    expect(clean).toEqual({
      "test-pilot": { enabled: true, settings: {} },
      "gitlab-issues": { enabled: false, settings: {} },
    });
  });

  it("coerces a non-boolean enabled to false and drops junk entries", () => {
    const clean = sanitizeStoredModules({
      chat: { enabled: "yes", settings: {} },
      report: "broken",
      devices: null,
      "audit-flow": [1, 2],
    });
    expect(clean).toEqual({ chat: { enabled: false, settings: {} } });
  });

  it("returns null for unusable payloads", () => {
    expect(sanitizeStoredModules(undefined)).toBeNull();
    expect(sanitizeStoredModules(null)).toBeNull();
    expect(sanitizeStoredModules("nope")).toBeNull();
    expect(sanitizeStoredModules([{ enabled: true }])).toBeNull();
  });
});
