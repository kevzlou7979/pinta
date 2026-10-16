// Report module: the report declares its owner. Report settings takes
// the owner's git author name / emails; the request is scoped to them,
// the tab shows whose work is on screen, and the export says it too.
//   npx vitest run --config vitest.repro.config.ts report-owner
import { describe, it, expect, vi } from "vitest";

const store: Record<string, unknown> = {};
const ev = () => ({ addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) });
(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn(async (k: any) => (typeof k === "string" ? { [k]: store[k] } : {})),
      set: vi.fn(async (o: any) => { Object.assign(store, JSON.parse(JSON.stringify(o))); }),
      remove: vi.fn(async (k: string) => { delete store[k]; }),
    },
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: ev(),
  },
  runtime: {
    onMessage: ev(), sendMessage: vi.fn(async () => ({})),
    connect: vi.fn(() => ({ onMessage: ev(), onDisconnect: ev(), postMessage: vi.fn(), disconnect: vi.fn() })),
    getManifest: () => ({ version: "0.10.0" }), getURL: (p: string) => p, id: "t",
  },
  tabs: { onActivated: ev(), onUpdated: ev(), onRemoved: ev(), query: vi.fn(async () => []), sendMessage: vi.fn(async () => ({})), create: vi.fn(async () => ({})) },
  windows: { onFocusChanged: ev(), WINDOW_ID_NONE: -1 },
  notifications: { create: vi.fn(), onClicked: ev(), onClosed: ev(), clear: vi.fn() },
  action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  permissions: { contains: vi.fn(async () => false) },
  commands: { onCommand: ev() },
};
globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as any;
(URL as any).createObjectURL = vi.fn(() => "blob:pinta");
(URL as any).revokeObjectURL = vi.fn();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

async function mountTab() {
  const { mount, flushSync, tick } = await import("svelte");
  const { app } = await import("../lib/state.svelte.js");
  const { default: ReportTab } = await import("./ReportTab.svelte");
  document.body.innerHTML = "";
  const target = document.createElement("div");
  document.body.appendChild(target);
  for (const k of Object.keys(store)) delete store[k];
  const send = vi.fn();
  (app as any).selectedCompanion = { port: 7878, projectRoot: "C:/p/pinta", pid: 1 };
  (app as any).scanning = false;
  app.connectionStatus = "connected";
  (app as any).client = { send };
  app.modules["report"] = { enabled: true, settings: {} } as any;
  app.report.owners = [];
  app.report.projects = [];
  app.report.currentRun = null;
  app.report.pending = null;
  app.report.error = null;
  app.report.range = "daily";
  mount(ReportTab, { target });
  await sleep(30);
  const settle = async () => { flushSync(); await tick(); };
  await settle();
  const btn = (re: RegExp, root: ParentNode = document.body) =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => re.test(b.getAttribute("aria-label") ?? "") || re.test(norm(b.textContent)),
    );
  const ownerLine = () => norm(target.querySelector("[data-pinta-report-owner]")?.textContent);
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Report settings"]');
  const type = async (value: string) => {
    const input = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Report owner — git author name or email"]')!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    return input;
  };
  /** The op the last Generate sent to the agent. */
  const lastRequest = () => {
    const call = [...send.mock.calls].reverse().find((c) => c[0]?.type === "module.query.submit");
    return call ? JSON.parse(call[0].queryComment) : null;
  };
  /** Finish the in-flight report the way the agent's reply does. */
  const finish = async (payload: Record<string, unknown> = {}) => {
    const pending = app.report.pending!;
    const { parseReportPayload } = await import("../lib/report.js");
    app.report.currentRun = parseReportPayload(
      { type: "report", days: [{ date: pending.since, items: [{ id: "a1", title: "Fix login redirect", category: "bug-fix", source: "git" }] }], ...payload },
      { runId: pending.runId, range: pending.range, anchorDate: pending.anchorDate, since: pending.since, until: pending.until, authors: pending.authors, generatedAt: Date.now() },
    );
    (app as any).clearReportTimeout?.();
    app.report.pending = null;
    await settle();
  };
  return { app, target, settle, btn, ownerLine, dialog, type, send, lastRequest, finish };
}

describe("Report — declared owner", () => {
  it("with no owner declared the tab says so and the request covers every committer", async () => {
    const t = await mountTab();
    expect(t.ownerLine()).toBe("Owner All committers");
    t.btn(/^Generate report$/)!.click();
    await t.settle();
    const req = t.lastRequest();
    expect(req.op).toBe("report-generate");
    expect(req.author).toBeNull();
    expect("authors" in req).toBe(false);
    await t.finish();
    expect(t.ownerLine()).toBe("Owner All committers");
    expect(t.target.querySelector("[data-pinta-report-owner-stale]")).toBeNull();
  });

  it("declaring the owner in Report settings scopes the next report to them and labels it", async () => {
    const t = await mountTab();
    t.btn(/^Report owner: All committers — change$/)!.click(); // the owner line opens the settings
    await t.settle();
    expect(t.dialog()).toBeTruthy();
    expect(norm(t.dialog()!.querySelector("[data-pinta-report-owner-settings]")!.textContent)).toContain("All committers");

    const input = await t.type("  Mark   Baldemor ");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); // Enter adds
    await t.settle();
    expect(t.app.report.owners).toEqual(["Mark Baldemor"]);
    expect(input.value).toBe("");
    expect(JSON.stringify(store)).toContain("Mark Baldemor"); // persisted

    t.btn(/^Close$/, t.dialog()!)!.click();
    await t.settle();
    expect(t.ownerLine()).toBe("Owner Mark Baldemor");
    t.btn(/^Generate report$/)!.click();
    await t.settle();
    const req = t.lastRequest();
    expect(req.author).toBe("Mark Baldemor");
    expect("authors" in req).toBe(false); // one identity → the lean, old-skill-compatible shape
    await t.finish({ author: "whatever the agent echoed" });
    expect(t.app.report.currentRun!.authors).toEqual(["Mark Baldemor"]);
    expect(t.ownerLine()).toBe("Owner Mark Baldemor");
  });

  it("an owner who commits under several identities sends them all", async () => {
    const t = await mountTab();
    expect(t.app.addReportOwner("Mark Baldemor")).toBeNull();
    expect(t.app.addReportOwner("mark.baldemor@insclix.com")).toBeNull();
    expect(t.app.addReportOwner("kevzlou7979")).toBeNull();
    await t.settle();
    t.btn(/^Generate report$/)!.click();
    await t.settle();
    const req = t.lastRequest();
    expect(req.author).toBe("Mark Baldemor");
    expect(req.authors).toEqual(["Mark Baldemor", "mark.baldemor@insclix.com", "kevzlou7979"]);
    await t.finish();
    expect(t.ownerLine()).toBe("Owner Mark Baldemor, mark.baldemor@insclix.com, kevzlou7979");
    // "Fetch more commits" for a day stays scoped to the same owner(s).
    t.send.mockClear();
    void t.app.fetchMoreDay(t.app.report.currentRun!.days[0]!.date);
    const more = t.lastRequest();
    expect(more.op).toBe("report-day-expand");
    expect(more.author).toBe("Mark Baldemor");
    expect(more.authors).toEqual(["Mark Baldemor", "mark.baldemor@insclix.com", "kevzlou7979"]);
    (t.app as any).clearReportExpandTimeout?.();
    t.app.report.expandingDate = null;
  });

  it("an unusable name is refused with a reason that can be dismissed; repeats and the limit too", async () => {
    const t = await mountTab();
    t.btn(/^Report settings$/)!.click();
    await t.settle();
    await t.type("--all; rm -rf .");
    t.btn(/^Add owner$/, t.dialog()!)!.click();
    await t.settle();
    expect(t.app.report.owners).toEqual([]);
    expect(norm(t.dialog()!.textContent)).toContain("Use a git author name or email");
    t.btn(/^Dismiss$/, t.dialog()!)!.click();
    await t.settle();
    expect(norm(t.dialog()!.textContent)).not.toContain("Use a git author name or email");

    expect(t.app.addReportOwner("Mark Baldemor")).toBeNull();
    expect(t.app.addReportOwner("mark baldemor")).toMatch(/already listed/);
    for (const n of ["a1", "a2", "a3", "a4"]) expect(t.app.addReportOwner(n)).toBeNull();
    expect(t.app.addReportOwner("a5")).toMatch(/Up to 5 names or emails/);
    await t.settle();
    expect(t.dialog()!.querySelector<HTMLInputElement>('input[aria-label="Report owner — git author name or email"]')!.disabled).toBe(true);
    // Removing one frees a slot.
    t.btn(/^Remove owner a4$/, t.dialog()!)!.click();
    await t.settle();
    expect(t.app.report.owners).toEqual(["Mark Baldemor", "a1", "a2", "a3"]);
  });

  it("changing the owner after a report was generated flags the report until it is regenerated", async () => {
    const t = await mountTab();
    t.app.addReportOwner("Mark Baldemor");
    await t.settle();
    t.btn(/^Generate report$/)!.click();
    await t.settle();
    await t.finish();
    t.app.addReportOwner("Dana Cruz");
    await t.settle();
    // The line keeps naming who the report ON SCREEN covers…
    expect(t.ownerLine()).toContain("Owner Mark Baldemor");
    // …and says the setting has moved on.
    expect(norm(t.target.querySelector("[data-pinta-report-owner-stale]")!.textContent)).toBe("— now set to Mark Baldemor, Dana Cruz; regenerate to apply");
    t.btn(/^Regenerate report$/)!.click();
    await t.settle();
    expect(t.lastRequest().authors).toEqual(["Mark Baldemor", "Dana Cruz"]);
    await t.finish();
    expect(t.target.querySelector("[data-pinta-report-owner-stale]")).toBeNull();
  });

  it("the markdown export carries the owner", async () => {
    const t = await mountTab();
    t.app.addReportOwner("Mark Baldemor");
    t.btn(/^Generate report$/)!.click();
    await t.settle();
    await t.finish();
    const { renderReportMarkdown } = await import("../lib/report.js");
    expect(renderReportMarkdown(t.app.report.currentRun!)).toContain("\nOwner: Mark Baldemor\n");
  });

  it("a tampered stored owner list never reaches the agent", async () => {
    const t = await mountTab();
    store["pinta-report-owners"] = ["Mark Baldemor", "--all", "$(whoami)", 7, "mark baldemor"];
    await t.app.loadReportRun();
    await t.settle();
    expect(t.app.report.owners).toEqual(["Mark Baldemor"]);
    // Even if the in-memory list is poisoned later, the request re-validates.
    t.app.report.owners = ["Mark Baldemor", "--all"];
    t.btn(/^Generate report$/)!.click();
    await t.settle();
    const req = t.lastRequest();
    expect(req.author).toBe("Mark Baldemor");
    expect("authors" in req).toBe(false);
  });
});
