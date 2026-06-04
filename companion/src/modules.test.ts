import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, assertSafeModuleId } from "./store.js";
import type { ModulePackage } from "@pinta/shared";

/**
 * Phase 19 — importable modules. The store installs a `.pinta-module.json`
 * bundle to `.pinta/modules/<id>/`, records the user's capability consent,
 * and refuses anything that could escape that directory or smuggle a
 * capability past the manifest.
 */
describe("SessionStore — importable modules", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinta-modules-"));
    store = new SessionStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function pkg(overrides: Partial<ModulePackage["manifest"]> = {}): ModulePackage {
    return {
      $pintaModule: "1",
      manifest: {
        id: "acme.echo-notes",
        name: "Echo Notes",
        version: "1.0.0",
        author: "Acme",
        description: "Append each annotation comment to NOTES.md.",
        mode: "per-submit",
        sessionCheckboxLabel: "Append to NOTES.md",
        sessionCheckboxHint: "Write each comment to the project's NOTES.md.",
        capabilities: ["write-files"],
        ...overrides,
      },
      agent: "# Echo Notes\n\nAppend each annotation comment to NOTES.md.",
    };
  }

  it("installs, lists, and uninstalls a module round-trip", async () => {
    const installed = await store.installModule(pkg(), ["write-files"]);
    expect(installed.manifest.id).toBe("acme.echo-notes");
    expect(installed.grantedCapabilities).toEqual(["write-files"]);

    // Files landed on disk under the namespaced dir.
    const base = join(dir, ".pinta", "modules", "acme.echo-notes");
    const manifest = JSON.parse(await readFile(join(base, "module.json"), "utf8"));
    expect(manifest.name).toBe("Echo Notes");
    const agent = await readFile(join(base, "agent.md"), "utf8");
    expect(agent).toContain("Append each annotation comment");

    const list = await store.listInstalledModules();
    expect(list).toHaveLength(1);
    expect(list[0]!.grantedCapabilities).toEqual(["write-files"]);

    await store.uninstallModule("acme.echo-notes");
    expect(await store.listInstalledModules()).toHaveLength(0);
  });

  it("defaults to no capabilities when none are granted (default-deny)", async () => {
    const installed = await store.installModule(pkg(), []);
    expect(installed.grantedCapabilities).toEqual([]);
  });

  it("drops a granted capability the manifest never declared", async () => {
    // Module declares only write-files; user (or an attacker) tries to
    // grant run-tool:rm — it must be filtered out.
    const installed = await store.installModule(pkg({ capabilities: ["write-files"] }), [
      "write-files",
      "run-tool:rm",
    ] as never);
    expect(installed.grantedCapabilities).toEqual(["write-files"]);
  });

  it("rejects a path-traversal / non-namespaced id", async () => {
    await expect(
      store.installModule(pkg({ id: "../evil" }), []),
    ).rejects.toThrow(/invalid module id/);
    await expect(
      store.installModule(pkg({ id: "a/b" }), []),
    ).rejects.toThrow(/invalid module id/);
    // No dot → not namespaced → rejected.
    await expect(
      store.installModule(pkg({ id: "nonamespace" }), []),
    ).rejects.toThrow(/invalid module id/);
    // Nothing should have been written.
    expect(await store.listInstalledModules()).toHaveLength(0);
  });

  it("rejects the wrong schema sentinel", async () => {
    const bad = { ...pkg(), $pintaModule: "2" } as unknown as ModulePackage;
    await expect(store.installModule(bad, [])).rejects.toThrow(/unsupported module format/);
  });

  it("rejects a manifest missing required fields", async () => {
    await expect(
      store.installModule(pkg({ name: "" }), []),
    ).rejects.toThrow(/missing required field: name/);
  });

  it("rejects an unknown mode", async () => {
    await expect(
      store.installModule(pkg({ mode: "telepathic" as never }), []),
    ).rejects.toThrow(/unknown mode/);
  });

  it("rejects an oversized agent blob", async () => {
    const big = { ...pkg(), agent: "x".repeat(256 * 1024 + 1) } as ModulePackage;
    await expect(store.installModule(big, [])).rejects.toThrow(/too large/);
  });

  it("rejects an invalid declared capability", async () => {
    await expect(
      store.installModule(pkg({ capabilities: ["wat" as never] }), []),
    ).rejects.toThrow(/invalid capability/);
  });

  it("listInstalledModules tolerates a missing dir", async () => {
    expect(await store.listInstalledModules()).toEqual([]);
  });

  it("uninstall throws on an unsafe id rather than rm-ing a traversal path", async () => {
    await expect(store.uninstallModule("../../etc")).rejects.toThrow(/invalid module id/);
  });
});

describe("assertSafeModuleId", () => {
  it("accepts namespaced ids", () => {
    expect(() => assertSafeModuleId("acme.jira-sync")).not.toThrow();
    expect(() => assertSafeModuleId("a.b.c")).not.toThrow();
  });
  it("rejects unsafe ids", () => {
    for (const bad of ["../evil", "a/b", "a\\b", "no-dot", "UPPER.case", ".leading", "trailing.", "a..b"]) {
      expect(() => assertSafeModuleId(bad)).toThrow();
    }
  });
});
