// "Share session as .pinta" export form lives in the footer. With the
// sign-off + email blocks it is taller than a short panel, so while it is
// open it takes over the panel body: <main> hides and the footer becomes the
// single scroll surface. happy-dom has no layout — this is a static class
// check reached through the real UI path (Export menu → "Share file (.pinta)").
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
globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as any;

describe("Share session as .pinta form", () => {
  it("takes over the panel body as one scroll surface (main hidden, footer scrolls)", async () => {
    const { mount, flushSync, tick } = await import("svelte");
    const { app } = await import("../lib/state.svelte.js");
    const { default: App } = await import("./App.svelte");
    const target = document.createElement("div");
    document.body.appendChild(target);
    mount(App, { target });
    await new Promise((r) => setTimeout(r, 300));

    const ann = (id: string, comment: string) => ({ id, kind: "select", selector: `#${id}`, comment, createdAt: 1 }) as any;
    app.session = {
      id: "s1", url: "", projectRoot: "", startedAt: 1, status: "drafting",
      annotations: [ann("a1", "change icon"), ann("a2", "change text")],
    } as any;
    flushSync(); await tick();

    const exportBtn = target.querySelector<HTMLButtonElement>('button[aria-label="Export annotations"]');
    expect(exportBtn, "Export annotations button (needs drafting session with annotations)").not.toBeNull();
    exportBtn!.click();
    flushSync(); await tick();

    const shareBtn = [...target.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find((b) => b.textContent!.includes("Share file (.pinta)"));
    expect(shareBtn, "Share file (.pinta) menu item").toBeTruthy();
    shareBtn!.click();
    flushSync(); await tick();

    const footer = target.querySelector("footer")!;
    expect(footer.classList.contains("hidden")).toBe(false);
    const heading = [...footer.querySelectorAll("span")].find((s) => s.textContent!.trim() === "Share session as .pinta");
    expect(heading, "export form heading in footer").toBeTruthy();
    // Lead decision F9/F10: the form takes over the panel body as ONE
    // scroll surface — <main> hides, the footer grows + scrolls, and the
    // form itself no longer caps/scrolls (no nested scrollbar).
    // Heading → header row → form container.
    const form = heading!.parentElement!.parentElement!;
    const cls = [...form.classList];
    expect(cls).not.toContain("overflow-y-auto");
    expect(cls.some((c) => /^max-h-/.test(c)), `no max-h-* cap in: ${cls.join(" ")}`).toBe(false);
    const fcls = [...footer.classList];
    for (const c of ["flex-1", "min-h-0", "overflow-y-auto"]) expect(fcls, fcls.join(" ")).toContain(c);
    expect(fcls).not.toContain("shrink-0");
    expect(target.querySelector("main")!.classList.contains("hidden")).toBe(true);
    // Draft submit controls are hidden behind the form; ✕ restores them.
    const btnText = () => [...footer.querySelectorAll("button")].map((b) => b.textContent!.replace(/\s+/g, " ").trim());
    expect(btnText().some((t) => t.startsWith("Copy to clipboard"))).toBe(false);
    footer.querySelector<HTMLButtonElement>('button[aria-label="Cancel export"]')!.click();
    flushSync(); await tick();
    expect(target.querySelector("main")!.classList.contains("hidden")).toBe(false);
    expect(footer.classList.contains("shrink-0")).toBe(true);
    expect(btnText().some((t) => t.startsWith("Copy to clipboard"))).toBe(true);
  }, 30000);
});
