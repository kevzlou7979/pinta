// GitLab Issues footer row: no Will-run badge; gear popover edits assignee + labels.
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

describe("Create GitLab issues — gear settings", () => {
  it("has no Will run badge; the gear edits assignee + labels (default domain:client, bug) and they reach the agent", async () => {
    const { mount, flushSync, tick } = await import("svelte");
    const { app } = await import("../lib/state.svelte.js");
    const { default: App } = await import("./App.svelte");
    const target = document.createElement("div");
    document.body.appendChild(target);
    mount(App, { target });
    await new Promise((r) => setTimeout(r, 300));
    const settle = async () => { flushSync(); await tick(); };

    const ann = (id: string, comment: string) => ({ id, kind: "select", selector: `#${id}`, comment, createdAt: 1 }) as any;
    app.selectedCompanion = { port: 7878, projectRoot: "C:/proj", urlPatterns: [] } as any;
    app.session = { id: "s1", url: "", projectRoot: "", startedAt: 1, status: "drafting", annotations: [ann("a1", "change icon")] } as any;
    // An entry saved before `assignee`/`labels` defaults existed.
    app.modules["gitlab-issues"] = { enabled: true, settings: {} } as any;
    app.setModuleTicked("gitlab-issues", true);
    await settle();

    const footer = () => target.querySelector("footer")!;
    expect(footer().textContent).toContain("Create GitLab issues");
    expect(footer().textContent).not.toMatch(/will run/i);

    const gear = footer().querySelector<HTMLButtonElement>("[data-pinta-gitlab-gear]")!;
    expect(gear).toBeTruthy();
    expect(gear.getAttribute("aria-expanded")).toBe("false");
    gear.click();
    await settle();
    const pop = footer().querySelector<HTMLElement>("[data-pinta-gitlab-prefs]")!;
    expect(pop).toBeTruthy();
    expect(pop.getAttribute("role")).toBe("dialog");
    const assignee = pop.querySelector<HTMLInputElement>("[data-pinta-gitlab-assignee]")!;
    const labels = pop.querySelector<HTMLInputElement>("[data-pinta-gitlab-labels]")!;
    expect(assignee.value).toBe("");
    expect(labels.value).toBe("domain:client, bug");
    // Clicking the checkbox row's gear must not untick the module.
    expect(app.tickedModules["gitlab-issues"]).toBe(true);

    // Focus lands in Assignee on open.
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(assignee);
    // Saved while typing — no blur/change needed, so closing the popover
    // (or submitting) straight after typing can't lose the value.
    assignee.value = " @jeremy.lin ";
    assignee.dispatchEvent(new Event("input", { bubbles: true }));
    labels.value = "domain:server, bug, qa";
    labels.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(app.modules["gitlab-issues"]!.settings.assignee).toBe(" @jeremy.lin ");

    const mods = app.buildSessionModules()!;
    expect(mods.find((m) => m.id === "gitlab-issues")!.settings).toMatchObject({ assignee: " @jeremy.lin ", labels: "domain:server, bug, qa" });
    expect(app.gitlabTarget()).toEqual({ projectId: undefined, labels: "domain:server, bug, qa", assignee: "@jeremy.lin" });

    // Reset labels restores the default.
    [...pop.querySelectorAll("button")].find((b) => b.textContent === "Reset labels")!.click();
    await settle();
    expect(app.gitlabTarget()!.labels).toBe("domain:client, bug");

    // Escape closes; outside press closes too.
    pop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(footer().querySelector("[data-pinta-gitlab-prefs]")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(gear);
    gear.click(); await settle();
    expect(footer().querySelector("[data-pinta-gitlab-prefs]")).toBeTruthy();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();
    expect(footer().querySelector("[data-pinta-gitlab-prefs]")).toBeNull();

    // Explicitly cleared labels stay cleared (no labels on the issue).
    app.setModuleSetting("gitlab-issues", "labels", "");
    expect(app.gitlabTarget()!.labels).toBeUndefined();
  }, 30000);
});
