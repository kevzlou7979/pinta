// Repro 3: stored `pinta-modules` entry WITHOUT a `settings` object
// (legacy / hand-edited / older-build storage). Expanding the Test Pilot
// card while enabled renders the settings form → settingValue() reads
// `entry.settings[field.key]` → TypeError → the rest of Settings blanks.
import { describe, it, expect, vi } from "vitest";

const storageData: Record<string, unknown> = {
  "pinta-modules": { "test-pilot": { enabled: false } }, // no `settings`
};
(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn(async (k: any) => {
        if (typeof k === "string") return { [k]: storageData[k] };
        return {};
      }),
      set: vi.fn(async (obj: any) => {
        Object.assign(storageData, obj);
      }),
      remove: vi.fn(async () => {}),
    },
    onChanged: { addListener: vi.fn() },
  },
  runtime: {
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(),
    getManifest: () => ({ version: "0.9.0" }),
  },
  tabs: { query: vi.fn(async () => []) },
};

describe("corrupt pinta-modules entry (no settings object)", () => {
  it("expand card then enable — does the panel survive?", async () => {
    const { mount, flushSync } = await import("svelte");
    const { app } = await import("../lib/state.svelte.js");
    await app.loadModules();
    const { default: SettingsPanel } = await import("./SettingsPanel.svelte");

    const target = document.createElement("div");
    document.body.appendChild(target);
    let err: unknown = null;
    try {
      mount(SettingsPanel, { target });
      flushSync();

      // Open the Modules accordion.
      const modulesHeader = [...target.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Modules"),
      )!;
      modulesHeader.click();
      flushSync();

      // Expand the Test Pilot card (user reads the description first).
      const expandTp = [...target.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === "Expand Test Pilot",
      )!;
      expect(expandTp).toBeTruthy();
      expandTp.click();
      flushSync();

      // Now flip the enable toggle.
      const tpName = [...target.querySelectorAll("span")].find(
        (s) => s.textContent === "Test Pilot",
      )!;
      const card = tpName.closest("div.rounded-md")!;
      const checkbox = card.querySelector(
        'input[type="checkbox"].sr-only',
      ) as HTMLInputElement;
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      flushSync();
    } catch (e) {
      err = e;
    }

    const backupVisible = [...target.querySelectorAll("button")].some((b) =>
      b.textContent?.includes("Backup & restore"),
    );
    console.log("caught error:", err);
    console.log("Backup accordion still rendered:", backupVisible);
    expect(err).toBeNull();
    expect(backupVisible).toBe(true);
  });
});
