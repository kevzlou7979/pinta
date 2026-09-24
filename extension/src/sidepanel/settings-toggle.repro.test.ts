// Repro: enabling the Test Pilot module from Settings reportedly blanks
// the Modules accordion (tester screenshot, 2026-09-24). Mounts the real
// SettingsPanel against the real app state with chrome stubbed.
import { describe, it, expect, vi, beforeAll } from "vitest";

// Minimal chrome stub BEFORE any app import.
const storageData: Record<string, unknown> = {};
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
  tabs: {
    onActivated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    query: vi.fn(async () => []),
  },
  notifications: {},
  action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
};

describe("Settings → Modules → enable Test Pilot", () => {
  let errors: unknown[];
  beforeAll(() => {
    errors = [];
    window.addEventListener("error", (e) => errors.push(e.error ?? e.message));
  });

  it("keeps the module cards rendered after the toggle", async () => {
    const { mount, flushSync, unmount } = await import("svelte");
    const { default: SettingsPanel } = await import("./SettingsPanel.svelte");

    const target = document.createElement("div");
    document.body.appendChild(target);
    const cmp = mount(SettingsPanel, { target });
    flushSync();

    // Open the Modules accordion.
    const headers = [...target.querySelectorAll("button")];
    const modulesHeader = headers.find((b) =>
      b.textContent?.includes("Modules"),
    )!;
    expect(modulesHeader).toBeTruthy();
    modulesHeader.click();
    flushSync();

    const cardCountBefore = [...target.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-label")?.startsWith("Expand"),
    ).length;
    expect(cardCountBefore).toBeGreaterThan(5);

    // Find the Test Pilot card's enable checkbox: it is the checkbox
    // inside the same card div as the "Test Pilot" name.
    const tpName = [...target.querySelectorAll("span")].find(
      (s) => s.textContent === "Test Pilot",
    )!;
    expect(tpName).toBeTruthy();
    const card = tpName.closest("div.rounded-md")!;
    const checkbox = card.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox).toBeTruthy();

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    await new Promise((r) => setTimeout(r, 50));
    flushSync();

    const cardCountAfter = [...target.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-label")?.startsWith("Expand") ||
             b.getAttribute("aria-label")?.startsWith("Collapse"),
    ).length;

    console.log("cards before:", cardCountBefore, "after:", cardCountAfter);
    console.log("window errors:", errors);
    expect(errors).toEqual([]);
    expect(cardCountAfter).toBe(cardCountBefore);

    unmount(cmp);
  });
});
