// Report owner — Fixer pass 1 (2026-10-16) for QA-B F1/F2/F4/F5 and QA-A
// F7/F9/F13/F14/F15/F16. State-level: the "covers only …" note is a
// NOTICE on a successful run (amber `report.notice`, never `report.error`)
// and is raised only when several identities were asked for and the agent
// echoed fewer; cleared on the next generate. Tab-level: a run stored
// before the owner existed is an every-committer run and is flagged stale
// once a setting exists; the stale line's "regenerate" is a real button;
// the settings dialog opens with focus in the owner input, Esc closes it
// and hands focus back, Tab / Shift+Tab stay inside; the cap reads
// "n of 5"; the per-day export carries the owner only when the run had
// one. report-owner.repro.test.ts (the spec) stays unchanged.
//   npx vitest run --config vitest.repro.config.ts report-owner-state
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
/** Every blob handed to a download `<a>` — the export's markdown. */
const blobs: Blob[] = [];
(URL as any).createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return "blob:pinta"; });
(URL as any).revokeObjectURL = vi.fn();
// Swallow the synthetic download click (happy-dom would try to navigate).
HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {};

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
  blobs.length = 0;
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
  app.report.notice = null;
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
  const stale = () => target.querySelector<HTMLElement>("[data-pinta-report-owner-stale]");
  const notice = () => target.querySelector<HTMLElement>("[data-pinta-report-notice]");
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Report settings"]');
  const ownerInput = () =>
    dialog()!.querySelector<HTMLInputElement>('input[aria-label="Report owner — git author name or email"]')!;
  /** The op the last Generate sent to the agent. */
  const lastRequest = () => {
    const call = [...send.mock.calls].reverse().find((c) => c[0]?.type === "module.query.submit");
    return call ? JSON.parse(call[0].queryComment) : null;
  };
  /** Answer the open run the way the companion relays the agent's reply —
   *  through the same `session.synced` routing the real panel uses, so
   *  handleReportSync (and the mismatch check) runs for real. */
  const reply = async (extra: Record<string, unknown> = {}) => {
    const pending = app.report.pending!;
    const req = lastRequest();
    const raw = JSON.stringify({
      type: "report",
      days: [{ date: pending.since, items: [{ id: "a1", title: "Fix login redirect", category: "bug-fix", source: "git" }] }],
      ...extra,
    });
    (app as any).onMessage({
      type: "session.synced",
      session: {
        id: `t-${pending.runId}`,
        url: "http://localhost:5173/",
        status: "done",
        modules: [{ id: "report" }],
        annotations: [{ id: "q1", kind: "query", comment: JSON.stringify(req) }],
        appliedSummary: raw,
      },
    });
    await settle();
  };
  const generate = async () => {
    btn(/^(Generate|Regenerate) report$/)!.click();
    await settle();
    return lastRequest();
  };
  const keydown = (el: Element, key: string, init: KeyboardEventInit = {}) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  return { app, target, settle, btn, ownerLine, stale, notice, dialog, ownerInput, send, lastRequest, reply, generate, keydown };
}

describe("Report owner — the mismatch notice (state)", () => {
  it("2+ asked, fewer echoed → an amber notice on a SUCCESSFUL run, not an error (F2, F14)", async () => {
    const t = await mountTab();
    t.app.setReportOwners(["Mark Baldemor", "mark.baldemor@insclix.com", "kevzlou7979"]);
    await t.settle();
    const req = await t.generate();
    expect(req.authors).toHaveLength(3);
    await t.reply({ authors: ["Mark Baldemor"] });
    expect(t.app.report.pending).toBeNull();
    expect(t.app.report.currentRun).not.toBeNull();
    expect(t.app.report.error).toBeNull();
    expect(t.app.report.notice).toBe(
      "This report covers only “Mark Baldemor”. Your Pinta agent is out of date and filters on one name only. " +
        "Update it (npx pinta-companion@latest install-skill), restart it, then regenerate.",
    );
    expect(t.app.report.notice).not.toContain("`");
    // The run keeps the label it was ASKED for.
    expect(t.app.report.currentRun!.authors).toEqual(["Mark Baldemor", "mark.baldemor@insclix.com", "kevzlou7979"]);
    expect(t.ownerLine()).toBe("Owner Mark Baldemor, mark.baldemor@insclix.com, kevzlou7979");
    // Rendered amber as a status (no red alert), with a ✕ that clears it.
    const el = t.notice()!;
    expect(el).toBeTruthy();
    expect(el.getAttribute("role")).toBe("status");
    expect(el.className).toContain("amber");
    expect(el.className).not.toContain("red");
    expect(t.target.querySelector('[role="alert"]')).toBeNull();
    expect(norm(el.textContent)).toContain("This report covers only “Mark Baldemor”.");
    t.btn(/^Dismiss$/, el)!.click();
    await t.settle();
    expect(t.app.report.notice).toBeNull();
    expect(t.notice()).toBeNull();
  });

  it("the notice is cleared by the next generate", async () => {
    const t = await mountTab();
    t.app.setReportOwners(["Mark Baldemor", "kevzlou7979"]);
    await t.settle();
    await t.generate();
    await t.reply({ authors: ["Mark Baldemor"] });
    expect(t.app.report.notice).not.toBeNull();
    await t.generate();
    expect(t.app.report.notice).toBeNull();
    expect(t.notice()).toBeNull();
    await t.reply({ authors: ["Mark Baldemor", "kevzlou7979"] });
    expect(t.app.report.notice).toBeNull();
  });

  it("one identity asked → never a notice, whatever the agent echoes", async () => {
    const t = await mountTab();
    t.app.setReportOwners(["Mark Baldemor"]);
    await t.settle();
    await t.generate();
    await t.reply({ authors: [] });
    expect(t.app.report.notice).toBeNull();
    expect(t.app.report.error).toBeNull();
    await t.generate();
    await t.reply({ author: "someone else" });
    expect(t.app.report.notice).toBeNull();
    await t.generate();
    await t.reply();
    expect(t.app.report.notice).toBeNull();
    // Nobody asked for either.
    t.app.setReportOwners([]);
    await t.generate();
    await t.reply({ authors: [] });
    expect(t.app.report.notice).toBeNull();
  });

  it("a full echo (any order / case), no echo, or a poisoned echo of everyone → never a notice", async () => {
    const t = await mountTab();
    t.app.setReportOwners(["Mark Baldemor", "mark.baldemor@insclix.com", "kevzlou7979"]);
    await t.settle();
    await t.generate();
    await t.reply({ authors: ["KEVZLOU7979", "mark baldemor", "Mark.Baldemor@insclix.com"] });
    expect(t.app.report.notice).toBeNull();
    await t.generate();
    await t.reply(); // older skill: no echo, can't tell
    expect(t.app.report.notice).toBeNull();
    await t.generate();
    await t.reply({ authors: "Mark Baldemor" }); // not an array = no echo
    expect(t.app.report.notice).toBeNull();
    await t.generate();
    await t.reply({ authors: ["Mark Baldemor", 7, "--all", "mark.baldemor@insclix.com", "kevzlou7979", "$(id)"] });
    expect(t.app.report.notice).toBeNull();
    expect(t.app.report.error).toBeNull();
  });

  it("a pending run set up without `authors` (older caller) neither crashes nor notes", async () => {
    const t = await mountTab();
    t.app.setReportOwners(["Mark Baldemor", "kevzlou7979"]);
    await t.generate();
    delete (t.app.report.pending as any).authors;
    await t.settle();
    expect(t.ownerLine()).toBe("Owner Mark Baldemor, kevzlou7979"); // falls back to the setting
    await t.reply({ authors: ["Mark Baldemor"] });
    expect(t.app.report.notice).toBeNull();
    expect(t.app.report.error).toBeNull();
    expect(t.app.report.currentRun).not.toBeNull();
  });
});

describe("Report owner — the tab", () => {
  it("a run stored before the owner existed is an every-committer run: flagged once a setting exists (F1)", async () => {
    const t = await mountTab();
    t.app.report.currentRun = {
      runId: "old-1",
      range: "daily",
      anchorDate: "2026-06-05",
      generatedAt: 1,
      days: [{ date: "2026-06-05", items: [{ id: "o1", title: "Old entry", category: "feature", source: "git" }] }],
    };
    await t.settle();
    // No setting yet: nothing to flag.
    expect(t.ownerLine()).toBe("Owner All committers");
    expect(t.stale()).toBeNull();
    t.app.addReportOwner("Mark Baldemor");
    await t.settle();
    // The line names who the run ON SCREEN covered — everyone — and says
    // the setting has moved on. Never "Owner Mark Baldemor" with no flag.
    expect(t.ownerLine()).toBe("Owner All committers — now set to Mark Baldemor; regenerate to apply");
    expect(norm(t.stale()!.textContent)).toBe("— now set to Mark Baldemor; regenerate to apply");
    // Same for a legacy single `author` the run can't use.
    t.app.report.currentRun = { ...t.app.report.currentRun!, author: "--all" };
    await t.settle();
    expect(t.ownerLine()).toBe("Owner All committers — now set to Mark Baldemor; regenerate to apply");
    // A usable legacy `author` is the owner it was asked for.
    t.app.report.currentRun = { ...t.app.report.currentRun!, author: "Mark Baldemor" };
    await t.settle();
    expect(t.ownerLine()).toBe("Owner Mark Baldemor");
    expect(t.stale()).toBeNull();
  });

  it("the stale line's \"regenerate\" is a button that runs the same generate as the toolbar (F13)", async () => {
    const t = await mountTab();
    t.app.addReportOwner("Mark Baldemor");
    await t.generate();
    await t.reply();
    t.app.addReportOwner("Dana Cruz");
    await t.settle();
    const inline = t.btn(/^Regenerate the report for the new owner$/, t.stale()!)!;
    expect(inline).toBeTruthy();
    expect(inline.tagName).toBe("BUTTON");
    expect(norm(inline.textContent)).toBe("regenerate");
    t.send.mockClear();
    inline.click();
    await t.settle();
    const req = t.lastRequest();
    expect(req.op).toBe("report-generate");
    expect(req.authors).toEqual(["Mark Baldemor", "Dana Cruz"]);
    expect(t.app.report.pending).not.toBeNull();
    expect(t.stale()).toBeNull(); // in flight → the line names the run in flight
    await t.reply({ authors: req.authors });
    expect(t.stale()).toBeNull();
  });

  it("the owner line reads as a control and opens the settings; the gear does too (F12)", async () => {
    const t = await mountTab();
    const line = t.btn(/^Report owner: All committers — change$/)!;
    expect(line.className).toContain("decoration-dotted");
    expect(line.querySelector("svg[aria-hidden='true']")).toBeTruthy(); // the pencil
    expect(norm(line.textContent)).toBe("All committers"); // the glyph adds no text
    line.click();
    await t.settle();
    expect(t.dialog()).toBeTruthy();
  });

  it("the dialog opens with focus in the owner input; Esc closes it and focus returns to the gear (F4, F7)", async () => {
    const t = await mountTab();
    const gear = t.btn(/^Report settings$/)!;
    gear.focus();
    gear.click();
    await t.settle();
    await sleep(5); // the focus action runs on a microtask
    expect(t.dialog()).toBeTruthy();
    expect(document.activeElement).toBe(t.ownerInput());
    t.keydown(t.ownerInput(), "Escape");
    await t.settle();
    await sleep(5);
    expect(t.dialog()).toBeNull();
    expect(document.activeElement).toBe(gear);
    // Esc with text typed still closes (the draft is just a draft).
    gear.click();
    await t.settle();
    await sleep(5);
    t.ownerInput().value = "Mark";
    t.ownerInput().dispatchEvent(new Event("input", { bubbles: true }));
    await t.settle();
    t.keydown(t.ownerInput(), "Escape");
    await t.settle();
    expect(t.dialog()).toBeNull();
    expect(t.app.report.owners).toEqual([]);
  });

  it("Tab and Shift+Tab stay inside the dialog (F7)", async () => {
    const t = await mountTab();
    t.btn(/^Report settings$/)!.click();
    await t.settle();
    await sleep(5);
    const d = t.dialog()!;
    const focusables = [...d.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    expect(first.getAttribute("aria-label")).toBe("Close");
    // Tab from the last control wraps to the first…
    last.focus();
    const tabFwd = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    last.dispatchEvent(tabFwd);
    expect(tabFwd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    // …and Shift+Tab from the first wraps to the last.
    const tabBack = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(tabBack);
    expect(tabBack.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    // A Tab in the middle is left to the browser.
    t.ownerInput().focus();
    const mid = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    t.ownerInput().dispatchEvent(mid);
    expect(mid.defaultPrevented).toBe(false);
    // The Close button hands focus back to the gear too.
    t.btn(/^Close$/, d)!.click();
    await t.settle();
    await sleep(5);
    expect(t.dialog()).toBeNull();
    expect(document.activeElement).toBe(t.btn(/^Report settings$/)!);
  });

  it("the cap reads \"n of 5\" and the placeholder says so at 5; chip × is a real hit target (F8, F9, F16)", async () => {
    const t = await mountTab();
    t.btn(/^Report settings$/)!.click();
    await t.settle();
    const d = t.dialog()!;
    const count = () => norm(d.querySelector("[data-pinta-report-owner-count]")?.textContent);
    expect(count()).toBe("0 of 5");
    expect(norm(d.querySelector("h4")?.textContent)).toBe("Owner"); // the counter is beside, not inside
    expect(t.ownerInput().placeholder).toBe("Git author name or email");
    for (const n of ["Mark Baldemor", "a1", "a2", "a3"]) expect(t.app.addReportOwner(n)).toBeNull();
    await t.settle();
    expect(count()).toBe("4 of 5");
    expect(t.app.addReportOwner("a4")).toBeNull();
    await t.settle();
    expect(count()).toBe("5 of 5");
    expect(t.ownerInput().disabled).toBe(true);
    expect(t.ownerInput().placeholder).toBe("Up to 5 — remove one to add another");
    const x = t.btn(/^Remove owner a4$/, d)!;
    expect(x.className).toMatch(/\bw-5\b/);
    expect(x.className).toMatch(/\bh-5\b/);
    expect(x.className).toContain("inline-flex");
    x.click();
    await t.settle();
    expect(count()).toBe("4 of 5");
    expect(t.ownerInput().placeholder).toBe("Git author name or email");
    // The refusal copy, exactly (F16), and no `break-all` anywhere in the dialog (F10).
    expect(t.app.addReportOwner("--all")).toBe(
      "Use a git author name or email (2–100 characters: letters, numbers, spaces, . _ ' - + @).",
    );
    expect(d.innerHTML).not.toContain("break-all");
    expect(t.target.innerHTML).not.toContain("break-all");
  });

  it("the per-day export carries the owner only when the run had one (F15)", async () => {
    const t = await mountTab();
    // Every committer: no Owner line at all.
    await t.generate();
    await t.reply();
    // The day card's export, not the toolbar's "Export report as markdown".
    const DAY_EXPORT = /^Export (?!report as markdown$).+ as markdown$/;
    let dayBtn = t.btn(DAY_EXPORT)!;
    expect(dayBtn).toBeTruthy();
    dayBtn.click();
    await sleep(20);
    expect(blobs.length).toBeGreaterThan(0);
    expect(await blobs[blobs.length - 1]!.text()).not.toContain("Owner:");
    // Scoped: the owner line right under the day heading.
    t.app.setReportOwners(["Mark Baldemor", "kevzlou7979"]);
    await t.generate();
    await t.reply({ authors: ["Mark Baldemor", "kevzlou7979"] });
    dayBtn = t.btn(DAY_EXPORT)!;
    dayBtn.click();
    await sleep(20);
    const md = await blobs[blobs.length - 1]!.text();
    expect(md).toMatch(/^## [^\n]+\nOwner: Mark Baldemor, kevzlou7979\n\n/);
    // And the whole-report (summary) export opens with it (F6) …
    t.btn(/^Export report as markdown$/)!.click();
    await sleep(40);
    expect((await blobs[blobs.length - 1]!.text()).startsWith("Owner: Mark Baldemor, kevzlou7979\n\n")).toBe(true);
    // … but says nothing about an owner for an every-committer run.
    t.app.setReportOwners([]);
    await t.generate();
    await t.reply();
    t.btn(/^Export report as markdown$/)!.click();
    await sleep(40);
    expect(await blobs[blobs.length - 1]!.text()).not.toContain("Owner:");
  });
});
