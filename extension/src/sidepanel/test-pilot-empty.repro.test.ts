// Test Pilot empty state (connected, no catalog): Coverage radio cards
// drive the thorough_tests setting and the CTA label, the import card
// accepts a dropped .md (and explains a non-markdown drop), and the
// footer "How?" discloses the pandoc/.docx instructions.
//   npx vitest run --config vitest.repro.config.ts test-pilot-empty
import { describe, it, expect, vi } from "vitest";

const store: Record<string, unknown> = {};
const ev = () => ({ addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) });
(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn(async (k: any) => (typeof k === "string" ? { [k]: store[k] } : {})),
      set: vi.fn(async (o: any) => Object.assign(store, o)),
      remove: vi.fn(async () => {}),
    },
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: ev(),
  },
  runtime: {
    onMessage: ev(), sendMessage: vi.fn(async () => ({})),
    connect: vi.fn(() => ({ onMessage: ev(), onDisconnect: ev(), postMessage: vi.fn(), disconnect: vi.fn() })),
    getManifest: () => ({ version: "0.9.0" }), getURL: (p: string) => p, id: "t",
  },
  tabs: { onActivated: ev(), onUpdated: ev(), onRemoved: ev(), query: vi.fn(async () => []), sendMessage: vi.fn(async () => ({})), create: vi.fn(async () => ({})) },
  windows: { onFocusChanged: ev(), WINDOW_ID_NONE: -1 },
  notifications: { create: vi.fn(), onClicked: ev(), onClosed: ev(), clear: vi.fn() },
  action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  permissions: { contains: vi.fn(async () => false) },
  commands: { onCommand: ev() },
};
globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

async function mountEmpty() {
  const { mount, flushSync, tick } = await import("svelte");
  const { app } = await import("../lib/state.svelte.js");
  const { default: TestPilotTab } = await import("./TestPilotTab.svelte");
  app.testPilot.catalog = null;
  app.testPilot.pending = null;
  app.testPilot.error = null;
  // Connected empty state (not the standalone "Import tester sheet" one).
  (app as any).selectedCompanion = { port: 7878, projectRoot: "C:/p", pid: 1 };
  app.modules["test-pilot"] = { id: "test-pilot", enabled: true, settings: { thorough_tests: true } } as any;
  const target = document.createElement("div");
  document.body.appendChild(target);
  mount(TestPilotTab, { target });
  await sleep(50);
  const settle = async () => { flushSync(); await tick(); };
  await settle();
  return { app, target, settle };
}

describe("Test Pilot empty state", () => {
  it("renders the onboarding layout and the Coverage radios drive the setting + CTA", async () => {
    const { app, target, settle } = await mountEmpty();
    const root = target.querySelector(".pinta-empty-state")!;
    expect(root.querySelector("h2")?.textContent).toBe("Build your test catalog");
    expect(norm(root.querySelector("legend")?.textContent)).toBe("Coverage");
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"][name="pinta-test-depth"]')];
    expect(radios.map((r) => r.value)).toEqual(["smoke", "thorough"]);
    expect(radios[1]!.checked).toBe(true);
    const chips = (id: string) => [...root.querySelectorAll(`[data-pinta-depth="${id}"] .rounded-md`)].map((c) => norm(c.textContent));
    expect(chips("smoke")).toEqual(["Faster", "Fewer tokens"]);
    expect(chips("thorough")).toEqual(["Slower", "More tokens"]);
    const cta = () => [...root.querySelectorAll("button")].find((b) => /Generate .* catalog/.test(norm(b.textContent)))!;
    expect(norm(cta().textContent)).toBe("Generate thorough catalog");

    const spy = vi.spyOn(app, "setModuleSetting");
    radios[0]!.click();
    await settle();
    expect(spy).toHaveBeenCalledWith("test-pilot", "thorough_tests", false);
    app.modules["test-pilot"]!.settings!.thorough_tests = false;
    await settle();
    expect(norm(cta().textContent)).toBe("Generate smoke catalog");
    expect(root.querySelector('[data-pinta-depth="smoke"]')!.getAttribute("data-selected")).toBe("true");

    const gen = vi.spyOn(app, "generateTestDoc").mockImplementation(() => {});
    cta().click();
    expect(gen).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain(".pinta/test-docs/");
  }, 30000);

  it("imports a dropped .md, and explains a non-markdown drop", async () => {
    const { app, target, settle } = await mountEmpty();
    const zone = target.querySelector<HTMLButtonElement>("[data-pinta-spec-drop]")!;
    const imp = vi.spyOn(app, "importTestDoc").mockResolvedValue(undefined as any);
    const drop = (file: File) => {
      const e = new Event("drop", { bubbles: true, cancelable: true }) as any;
      e.dataTransfer = { files: [file], types: ["Files"] };
      zone.dispatchEvent(e);
      return e as Event;
    };
    // Drag over highlights the card and swaps the title.
    const over = new Event("dragover", { bubbles: true, cancelable: true }) as any;
    over.dataTransfer = { types: ["Files"], dropEffect: "none" };
    zone.dispatchEvent(over);
    await settle();
    expect(over.defaultPrevented).toBe(true);
    expect(norm(zone.textContent)).toContain("Drop to import");

    const bad = drop(new File(["x"], "notes.txt", { type: "text/plain" }));
    await sleep(20); await settle();
    expect(bad.defaultPrevented).toBe(true);
    expect(imp).not.toHaveBeenCalled();
    expect(target.textContent).toContain("notes.txt isn't a markdown file");
    expect(norm(zone.textContent)).toContain("Import a markdown spec");

    // The note is dismissible.
    [...target.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss"]')].at(-1)!.click();
    await settle();
    expect(target.textContent).not.toContain("isn't a markdown file");

    // Several files: the first markdown one wins.
    const e = new Event("drop", { bubbles: true, cancelable: true }) as any;
    e.dataTransfer = { files: [new File(["x"], "notes.txt"), new File(["# Spec\n"], "spec.md")], types: ["Files"] };
    zone.dispatchEvent(e);
    await sleep(30); await settle();
    expect(imp).toHaveBeenCalledWith("spec.md", "# Spec\n");
    expect(target.textContent).not.toContain("isn't a markdown file");

    // Radio names are just the titles; hint + chips are the description.
    const smoke = target.querySelector<HTMLInputElement>('input[value="smoke"]')!;
    expect(document.getElementById(smoke.getAttribute("aria-labelledby")!)!.textContent).toBe("Smoke test");
  }, 30000);

  it("a file dropped outside the card does not navigate the panel", async () => {
    await mountEmpty();
    const e = new Event("drop", { bubbles: true, cancelable: true }) as any;
    e.dataTransfer = { files: [new File(["x"], "spec.md")], types: ["Files"], dropEffect: "copy" };
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(e.dataTransfer.dropEffect).toBe("none");
  }, 30000);

  it("footer How? discloses the export instructions", async () => {
    const { target, settle } = await mountEmpty();
    const how = [...target.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "How?")!;
    expect(how.getAttribute("aria-label")).toBe("How? Export instructions");
    expect(how.getAttribute("aria-expanded")).toBe("false");
    expect(target.querySelector("#pinta-pandoc-how")).toBeNull();
    how.click();
    await settle();
    expect(how.getAttribute("aria-expanded")).toBe("true");
    expect(target.querySelector("#pinta-pandoc-how")?.textContent).toContain("pandoc results.md -o results.pdf");
    expect(how.textContent).toBe("Hide");
  }, 30000);
});
