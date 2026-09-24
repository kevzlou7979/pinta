// Imported-.pinta footer must mirror the draft footer: GitLab filing UI
// (per-annotation checkboxes, "File issues") exists ONLY while the GitLab
// Issues module is enabled and ticked. Regression for 2026-09-24 report
// ("File selected to GitLab" shown with the module off).
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
  tabs: { onActivated: ev(), onUpdated: ev(), onRemoved: ev(), query: vi.fn(async () => []), sendMessage: vi.fn(async () => ({})) },
  windows: { onFocusChanged: ev(), WINDOW_ID_NONE: -1 },
  notifications: { create: vi.fn(), onClicked: ev(), onClosed: ev(), clear: vi.fn() },
  action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  permissions: { contains: vi.fn(async () => false) },
  commands: { onCommand: ev() },
};
// No companion on the network in tests — fail fast instead of scanning ports.
globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as any;

const buttons = (root: HTMLElement) => [...root.querySelectorAll("footer button")].map((b) => b.textContent!.replace(/\s+/g, " ").trim());
const annCheckboxes = (root: HTMLElement) => root.querySelectorAll('input[aria-label^="Include annotation"]').length;

describe("imported viewer footer ↔ GitLab Issues module", () => {
  it("hides GitLab filing when the module is off; mirrors the draft footer when on", async () => {
    const { mount, flushSync, tick } = await import("svelte");
    const { app } = await import("../lib/state.svelte.js");
    const { default: App } = await import("./App.svelte");
    const target = document.createElement("div");
    document.body.appendChild(target);
    mount(App, { target });
    await new Promise((r) => setTimeout(r, 300));

    const ann = (id: string, comment: string) => ({ id, kind: "select", selector: `#${id}`, comment, createdAt: 1 }) as any;
    app.selectedCompanion = { port: 7878, projectRoot: "C:/proj", urlPatterns: [] } as any;
    app.importedSessions = [{
      id: "imp1", importedAt: 1,
      manifest: { title: "Shared", author: "Jeremy", accentColor: "#f00", exportedAt: 1 },
      session: { id: "s", url: "https://x.test/", projectRoot: "", startedAt: 1, status: "drafting", annotations: [ann("a1", "change icon"), ann("a2", "change text")] },
    }] as any;
    app.viewingImportedId = "imp1";
    flushSync(); await tick();

    // 1) GitLab module OFF → no GitLab UI at all.
    expect(app.appMode).toBe("connected");
    let b = buttons(target);
    console.log("OFF:", b);
    expect(b.some((t) => /GitLab|File issues/.test(t))).toBe(false);
    expect(target.textContent).not.toContain("Create GitLab issues");
    expect(annCheckboxes(target)).toBe(0);
    expect(b.some((t) => t.startsWith("Send to agent"))).toBe(true);

    // 2) Module ON but not ticked → checkbox offered, still "Send to agent".
    app.setModuleEnabled("gitlab-issues", true);
    flushSync(); await tick();
    expect(target.textContent).toContain("Create GitLab issues");
    expect(annCheckboxes(target)).toBe(0);
    b = buttons(target);
    expect(b.some((t) => t.startsWith("Send to agent"))).toBe(true);

    // 3) Ticked, no auto-apply → "File issues" primary (same label as the
    // draft footer — the count lives in the hint line) + per-row selection.
    app.setModuleTicked("gitlab-issues", true);
    app.submitOptions.autoApply = false;
    flushSync(); await tick();
    b = buttons(target);
    console.log("TICKED:", b);
    expect(annCheckboxes(target)).toBe(2);
    expect(b).toContain("File issues");
    expect(b.some((t) => t.startsWith("Send to agent"))).toBe(false);
    const hint = () => target.querySelector("footer")!.textContent!.replace(/\s+/g, " ");
    expect(hint()).toContain("2 of 2 selected · Issues only — source code stays untouched");
    expect(hint()).toContain("Untick Create GitLab issues to send to the agent instead.");
    // Same collapsible "Submit options" header as the draft; only GitLab
    // Issues among per-submit modules; Fork hidden in connected mode.
    expect(b.some((t) => t.startsWith("Submit options"))).toBe(true);
    expect(b).not.toContain("Fork");
    // 0 selected → the hint explains why File issues is disabled.
    for (const box of target.querySelectorAll<HTMLInputElement>('input[aria-label^="Include annotation"]')) box.click();
    flushSync(); await tick();
    expect(hint()).toContain("Select at least one annotation to file.");

    // 4) Ticked + auto-apply → "Send to agent" (patches code and files).
    app.submitOptions.autoApply = true;
    flushSync(); await tick();
    b = buttons(target);
    console.log("TICKED+AUTO:", b);
    expect(b.some((t) => t.startsWith("Send to agent"))).toBe(true);
    expect(b.some((t) => /File issues/.test(t))).toBe(false);
  }, 30000);
});
