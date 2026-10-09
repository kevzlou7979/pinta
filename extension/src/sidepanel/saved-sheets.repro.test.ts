// Standalone Test Pilot keeps several tester sheets side by side: the
// one on screen plus a shelf of the others, each with its own marks and
// failure notes, switched from the menu beside the title — no re-import.
//   npx vitest run --config vitest.repro.config.ts saved-sheets
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

function sheetCatalog(docId: string, title: string, prefix: string) {
  return {
    docId, filename: "uat.md", importedAt: 0, title,
    sections: [{
      title: "1.1 Login",
      tests: [
        { id: `${prefix}-01`, test: `${title} login page`, expected: "Fields show", status: "untested" },
        { id: "AUTH-06", test: `${title} log out`, expected: "Returns to login", status: "untested" },
        { id: `${prefix}-03`, test: `${title} forgot password`, expected: "Form opens", status: "untested" },
      ],
    }],
  } as any;
}

/** A tester sheet file exactly as the developer's Pinta exports it. */
async function testerSheetMd(docId: string, title: string, prefix: string): Promise<string> {
  const { composeFrontmatter } = await import("../lib/test-pilot-md.js");
  const { composeTesterSheetMarkdown } = await import("../lib/test-pilot-doc.js");
  return composeFrontmatter(docId) + composeTesterSheetMarkdown(sheetCatalog(docId, title, prefix));
}

async function mountTab(mode: "standalone" | "connected" = "standalone") {
  const { mount, flushSync, tick } = await import("svelte");
  const { app } = await import("../lib/state.svelte.js");
  const { createMemorySheetShelf } = await import("../lib/sheet-shelf.js");
  const { default: TestPilotTab } = await import("./TestPilotTab.svelte");
  document.body.innerHTML = "";
  const target = document.createElement("div");
  document.body.appendChild(target);
  for (const k of Object.keys(store)) delete store[k];
  const shelf = createMemorySheetShelf();
  app.sheetShelf = shelf;
  (app as any).selectedCompanion = mode === "connected" ? { port: 7878, projectRoot: "C:/p", pid: 1 } : null;
  (app as any).scanning = false;
  app.connectionStatus = mode === "connected" ? "connected" : "disconnected";
  (app as any).client = mode === "connected" ? { send: vi.fn() } : null;
  app.modules["test-pilot"] = { enabled: true, settings: {} } as any;
  app.testPilot.importedRun = null;
  app.testPilot.plans = [];
  app.testPilot.scope = { kind: "all" };
  app.testPilot.savedSheets = [];
  app.testPilot.pendingImportConflict = null;
  app.failureNoteDrafts.clear();
  app.testPilot.catalog = sheetCatalog("doc-bcp", "UAT — Broker Connect Portal (BCP)", "BCP");
  app.testPilot.error = null;
  mount(TestPilotTab, { target });
  await sleep(50);
  const settle = async () => { flushSync(); await tick(); };
  await settle();
  const btn = (re: RegExp, root: ParentNode = target) =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => re.test(b.getAttribute("aria-label") ?? "") || re.test(norm(b.textContent)),
    );
  const ids = () => app.testPilot.catalog?.sections.flatMap((s) => s.tests.map((t) => t.id)) ?? [];
  const row = (id: string) => app.testPilot.catalog!.sections[0]!.tests.find((t) => t.id === id)!;
  const openMenu = async () => { btn(/^Switch test sheet$/)!.click(); await settle(); };
  const awp = () => testerSheetMd("doc-awp", "UAT — Agent Web Portal (AWP)", "AWP");
  return { app, target, settle, btn, ids, row, shelf, openMenu, awp };
}

describe("Test Pilot — saved sheets (standalone)", () => {
  it("importing a second project's sheet keeps the first one, marks and notes included", async () => {
    const t = await mountTab();
    t.app.setTestStatus("BCP-01", "pass");
    t.app.setTestStatus("AUTH-06", "fail");
    t.app.saveFailureNote("AUTH-06", { description: "BCP: stays signed in" });

    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await t.settle();
    // AWP is on screen, untouched and unmarked…
    expect(t.app.testPilot.catalog!.docId).toBe("doc-awp");
    expect(t.ids()).toEqual(["AWP-01", "AUTH-06", "AWP-03"]);
    expect(t.row("AUTH-06").status).toBe("untested");
    expect(t.app.testPilot.pendingImportConflict).toBeNull(); // no "replace?" prompt
    // …and BCP waits on the shelf exactly as it was left.
    expect(t.app.testPilot.savedSheets.map((s) => [s.docId, s.title, s.pass, s.fail, s.total])).toEqual([
      ["doc-bcp", "UAT — Broker Connect Portal (BCP)", 1, 1, 3],
    ]);
    const shelved = (await t.shelf.get("doc-bcp"))!;
    expect(shelved.catalog.sections[0]!.tests[1]!.failNotes![0]!.description).toBe("BCP: stays signed in");
    // The standalone slot holds AWP — a panel reload opens what was on screen.
    await sleep(10);
    const slot = Object.values(store).find((v: any) => v?.docId) as any;
    expect(slot.docId).toBe("doc-awp");
  });

  it("the switcher beside the title lists the sheets and swaps them without a re-import", async () => {
    const t = await mountTab();
    t.app.setTestStatus("BCP-01", "pass");
    t.app.setTestStatus("AUTH-06", "fail");
    t.app.saveFailureNote("AUTH-06", { description: "BCP: stays signed in" });
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await t.settle();
    t.app.setTestStatus("AWP-03", "fail");
    await t.settle();

    const trigger = t.btn(/^Switch test sheet$/)!;
    expect(norm(trigger.textContent)).toBe("2");
    await t.openMenu();
    const menu = t.target.querySelector('[role="dialog"][aria-label="Your test sheets"]')!;
    expect(norm(menu.querySelector("[data-pinta-sheet-current]")!.textContent)).toContain("UAT — Agent Web Portal (AWP)");
    expect(norm(menu.querySelector("[data-pinta-sheet-current]")!.textContent)).toContain("1 of 3 run · 1 failed · open now");
    expect(norm(menu.querySelector('[data-pinta-sheet="doc-bcp"]')!.textContent)).toContain("2 of 3 run · 1 failed");

    t.btn(/^Open UAT — Broker Connect Portal \(BCP\)$/, menu)!.click();
    for (let i = 0; i < 40 && t.app.testPilot.catalog?.docId !== "doc-bcp"; i++) { await sleep(10); await t.settle(); }
    await t.settle();
    // BCP is back with everything it had.
    expect(t.ids()).toEqual(["BCP-01", "AUTH-06", "BCP-03"]);
    expect(t.row("BCP-01").status).toBe("pass");
    expect(t.row("AUTH-06").failNotes![0]!.description).toBe("BCP: stays signed in");
    expect(norm(t.target.textContent)).toContain("BCP: stays signed in");
    expect(t.target.querySelector('[role="dialog"][aria-label="Your test sheets"]')).toBeNull(); // menu closed
    // AWP took its place on the shelf, with ITS mark.
    expect(t.app.testPilot.savedSheets.map((s) => [s.docId, s.fail])).toEqual([["doc-awp", 1]]);
    expect(t.shelf.size()).toBe(1);

    // And back again — as many times as she likes.
    expect(await t.app.switchTestSheet("doc-awp")).toBe(true);
    await t.settle();
    expect(t.row("AWP-03").status).toBe("fail");
    expect(t.row("AUTH-06").failNotes).toBeUndefined(); // BCP's note did not follow
    expect(t.app.testPilot.savedSheets.map((s) => s.docId)).toEqual(["doc-bcp"]);
  });

  it("re-importing a sheet she already has brings THAT sheet back instead of adding a copy", async () => {
    const t = await mountTab();
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    t.app.setTestStatus("AWP-01", "pass");
    // BCP's sheet again (same doc-id as the shelved one), while AWP is open.
    await t.app.importTestDoc("bcp-uat.md", await testerSheetMd("doc-bcp", "UAT — Broker Connect Portal (BCP)", "BCP"));
    await t.settle();
    expect(t.app.testPilot.catalog!.docId).toBe("doc-bcp");
    expect(t.app.testPilot.savedSheets.map((s) => [s.docId, s.pass])).toEqual([["doc-awp", 1]]);
    expect(t.shelf.size()).toBe(1); // two sheets in total, no duplicate
  });

  it("a sheet with no doc-id is the same sheet only when title AND test ids match", async () => {
    const t = await mountTab();
    const plain = (title: string, ...ids: string[]) =>
      `# ${title}\n\n## 1.1 Login\n\n| ID | Test | Expected Result | Result |\n|----|------|-----------------|--------|\n` +
      ids.map((id) => `| ${id} | Login page | Fields show |  |\n`).join("");
    // Same title, shares BCP-01 with the open sheet → the old in-place re-import.
    await t.app.importTestDoc("uat.md", plain("UAT — Broker Connect Portal (BCP)", "BCP-01", "BCP-99"));
    await t.settle();
    expect(t.app.testPilot.catalog!.docId).toBe("doc-bcp");
    expect(t.ids()).toEqual(["BCP-01", "BCP-99"]);
    expect(t.app.testPilot.savedSheets).toEqual([]);
    // A different project that happens to use the same FILE name → kept beside it.
    await t.app.importTestDoc("uat.md", plain("UAT — Agent Web Portal (AWP)", "AWP-01"));
    await t.settle();
    expect(t.ids()).toEqual(["AWP-01"]);
    expect(t.app.testPilot.catalog!.docId).not.toBe("doc-bcp");
    expect(t.app.testPilot.savedSheets.map((s) => s.docId)).toEqual(["doc-bcp"]);
    // BCP's plain file again → back to the saved BCP, not a third sheet.
    await t.app.importTestDoc("uat.md", plain("UAT — Broker Connect Portal (BCP)", "BCP-01", "BCP-99"));
    await t.settle();
    expect(t.app.testPilot.catalog!.docId).toBe("doc-bcp");
    expect(t.app.testPilot.savedSheets).toHaveLength(1);
    expect(t.shelf.size()).toBe(1);
    // Same generic TITLE as the open sheet but none of its tests (another
    // project's "UAT" sheet) → a sheet of its own, the open one is kept.
    await t.app.importTestDoc("other.md", plain("UAT — Broker Connect Portal (BCP)", "ZZZ-01"));
    await t.settle();
    expect(t.ids()).toEqual(["ZZZ-01"]);
    expect(t.app.testPilot.catalog!.docId).not.toBe("doc-bcp");
    expect(t.app.testPilot.savedSheets.map((s) => s.docId)).toContain("doc-bcp");
    expect(t.shelf.size()).toBe(2);
  });

  it("a Pinta-framed file with headings but no test rows moves nothing", async () => {
    const t = await mountTab();
    t.app.setTestStatus("BCP-01", "pass");
    await t.app.importTestDoc("empty.md", "---\npinta-test-pilot: 1\ndoc-id: doc-empty\n---\n\n# Empty\n\n## Only headings\n");
    await t.settle();
    expect(t.shelf.size()).toBe(0);
    expect(t.app.testPilot.savedSheets).toEqual([]);
    t.app.testPilot.pendingImportConflict = null;
    t.app.testPilot.error = null;
  });

  it("a file Pinta can't read changes nothing", async () => {
    const t = await mountTab();
    t.app.setTestStatus("BCP-01", "pass");
    await t.app.importTestDoc("notes.md", "just some notes, not a test sheet");
    await t.settle();
    expect(t.app.testPilot.catalog!.docId).toBe("doc-bcp");
    expect(t.row("BCP-01").status).toBe("pass");
    expect(t.shelf.size()).toBe(0);
    expect(t.app.testPilot.error).toMatch(/Couldn't read this file/);
    t.app.testPilot.error = null;
  });

  it("a saved sheet can be deleted from the menu, after a confirm", async () => {
    const t = await mountTab();
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await t.settle();
    const { confirmService } = await import("../lib/confirm.svelte.js");
    await t.openMenu();
    t.btn(/^Delete saved sheet UAT — Broker Connect Portal \(BCP\)$/)!.click();
    await t.settle();
    expect(confirmService.pending?.title).toBe("Delete this saved sheet?");
    confirmService.answer(false);
    await sleep(10); await t.settle();
    expect(t.app.testPilot.savedSheets).toHaveLength(1);
    t.btn(/^Delete saved sheet UAT — Broker Connect Portal \(BCP\)$/)!.click();
    await t.settle();
    confirmService.answer(true);
    for (let i = 0; i < 40 && t.app.testPilot.savedSheets.length > 0; i++) { await sleep(10); await t.settle(); }
    expect(t.app.testPilot.savedSheets).toEqual([]);
    expect(t.shelf.size()).toBe(0);
    expect(t.app.testPilot.catalog!.docId).toBe("doc-awp"); // the open sheet is untouched
    expect(norm(t.btn(/^Switch test sheet$/)!.textContent)).toBe("1");
  });

  it("deleting the sheet on screen leaves the others saved and one click away on the empty screen", async () => {
    const t = await mountTab();
    t.app.setTestStatus("BCP-01", "pass");
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await t.settle();
    t.app.clearTestPilot(); // AWP gone
    for (let i = 0; i < 40 && t.app.testPilot.sheetBusy; i++) { await sleep(10); }
    await t.settle();
    // Nothing is opened on her behalf…
    expect(t.app.testPilot.catalog).toBeNull();
    expect(t.btn(/^Import tester sheet$/)).toBeTruthy();
    // …but the saved sheet is listed right there.
    const list = t.target.querySelector("[data-pinta-saved-sheets]")!;
    expect(norm(list.textContent)).toContain("UAT — Broker Connect Portal (BCP)");
    expect(norm(list.textContent)).toContain("1 of 3 run");
    t.btn(/^Open UAT — Broker Connect Portal \(BCP\)$/, list)!.click();
    for (let i = 0; i < 40 && t.app.testPilot.catalog?.docId !== "doc-bcp"; i++) { await sleep(10); await t.settle(); }
    expect(t.row("BCP-01").status).toBe("pass");
    expect(t.app.testPilot.savedSheets).toEqual([]);
    expect(t.shelf.size()).toBe(0); // the deleted AWP did not linger
    // Deleting the last one leaves a plain empty screen.
    t.app.clearTestPilot();
    for (let i = 0; i < 40 && t.app.testPilot.sheetBusy; i++) { await sleep(10); }
    await t.settle();
    expect(t.app.testPilot.catalog).toBeNull();
    expect(t.target.querySelector("[data-pinta-saved-sheets]")).toBeNull();
  });

  it("after a panel reload the open sheet and the saved ones are both still there", async () => {
    const t = await mountTab();
    t.app.setTestStatus("BCP-01", "pass");
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    t.app.setTestStatus("AWP-01", "fail");
    await sleep(20);
    await t.app.loadTestPilot(null); // what a reload does in standalone
    await t.settle();
    expect(t.app.testPilot.catalog!.docId).toBe("doc-awp");
    expect(t.row("AWP-01").status).toBe("fail");
    expect(t.app.testPilot.savedSheets.map((s) => [s.docId, s.pass])).toEqual([["doc-bcp", 1]]);
  });

  it("an empty slot is never filled from the shelf on its own (a connecting project would adopt it)", async () => {
    const t = await mountTab();
    await t.app.importTestDoc("awp-uat.md", await t.awp()); // BCP shelved
    await sleep(20);
    for (const k of Object.keys(store)) delete store[k]; // e.g. a project adopted the open sheet
    await t.app.loadTestPilot(null);
    for (let i = 0; i < 40 && t.app.testPilot.savedSheets.length === 0; i++) { await sleep(10); }
    await t.settle();
    expect(t.app.testPilot.catalog).toBeNull();
    expect(t.app.testPilot.savedSheets.map((s) => s.docId)).toEqual(["doc-bcp"]);
    expect(t.shelf.size()).toBe(1);
    await sleep(20);
    expect(Object.values(store).some((v: any) => v?.docId)).toBe(false); // nothing written to the slot
  });

  it("importing a saved sheet's file from the empty screen brings the saved one back — its marks are not bypassed", async () => {
    const t = await mountTab();
    t.app.setTestStatus("BCP-01", "pass");
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    t.app.clearTestPilot(); // empty screen, BCP still saved
    for (let i = 0; i < 40 && t.app.testPilot.sheetBusy; i++) { await sleep(10); }
    await t.app.importTestDoc("bcp-uat.md", await testerSheetMd("doc-bcp", "UAT — Broker Connect Portal (BCP)", "BCP"));
    await t.settle();
    expect(t.app.testPilot.catalog!.docId).toBe("doc-bcp");
    // The marked saved copy is what is open; the unmarked file waits on
    // the usual "replace?" question instead of silently winning.
    expect(t.row("BCP-01").status).toBe("pass");
    expect(t.app.testPilot.pendingImportConflict).toBeTruthy();
    t.app.resolveImportConflict(false);
    expect(t.row("BCP-01").status).toBe("pass");
    expect(t.shelf.size()).toBe(0);
  });

  it("the open slot is full (10 MB cap): the switch is refused, and BOTH sheets are still exactly where they were", async () => {
    const t = await mountTab();
    t.app.setTestStatus("BCP-01", "pass");
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    t.app.setTestStatus("AWP-01", "fail");
    await sleep(20);
    const set = (globalThis as any).chrome.storage.local.set as ReturnType<typeof vi.fn>;
    const real = set.getMockImplementation()!;
    set.mockImplementation(async (o: any) => {
      if (JSON.stringify(o).includes("doc-bcp")) throw new Error("QUOTA_BYTES quota exceeded");
      return real(o);
    });
    try {
      expect(await t.app.switchTestSheet("doc-bcp")).toBe(false);
      await t.settle();
      // AWP is still on screen and still in the slot…
      expect(t.app.testPilot.catalog!.docId).toBe("doc-awp");
      expect(t.row("AWP-01").status).toBe("fail");
      expect((Object.values(store).find((v: any) => v?.docId) as any).docId).toBe("doc-awp");
      // …BCP is still saved, whole, and listed…
      expect((await t.shelf.get("doc-bcp"))!.catalog.sections[0]!.tests[0]!.status).toBe("pass");
      expect(t.app.testPilot.savedSheets.map((s) => s.docId)).toEqual(["doc-bcp"]);
      // …no stale copy of the open sheet was left on the shelf…
      expect(await t.shelf.get("doc-awp")).toBeNull();
      // …and she is told why.
      expect(t.app.testPilot.error).toMatch(/storage is full.*couldn't be opened\. It is still saved/);
    } finally {
      set.mockImplementation(real);
      t.app.testPilot.error = null;
    }
    // With room again the same switch goes through.
    expect(await t.app.switchTestSheet("doc-bcp")).toBe(true);
    expect(t.row("BCP-01").status).toBe("pass");
  });

  it("while the open sheet is being swapped it is inert, and a save racing the swap cannot put the old sheet back", async () => {
    const t = await mountTab();
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await t.settle();
    await sleep(20);
    const set = (globalThis as any).chrome.storage.local.set as ReturnType<typeof vi.fn>;
    const real = set.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    set.mockImplementation(async (o: any) => {
      if (JSON.stringify(o).includes("doc-bcp")) await held; // the swap's slot write is slow
      return real(o);
    });
    try {
      const switching = t.app.switchTestSheet("doc-bcp");
      for (let i = 0; i < 40 && !t.app.testPilot.sheetSwapping; i++) await sleep(5);
      await t.settle();
      expect(t.app.testPilot.sheetSwapping).toBe(true);
      const section = t.target.querySelector("section[aria-busy]")!;
      expect(section.hasAttribute("inert")).toBe(true);
      // Something still manages to change the old sheet (a keyboard
      // shortcut, a late callback): its save must not reach the slot.
      t.app.setTestStatus("AWP-01", "pass");
      t.app.setTestPilotScope({ kind: "untested" });
      await sleep(20);
      release();
      expect(await switching).toBe(true);
      await sleep(20); await t.settle();
      expect(t.app.testPilot.catalog!.docId).toBe("doc-bcp");
      expect(t.app.testPilot.sheetSwapping).toBe(false);
      expect(t.target.querySelector("section[aria-busy]")!.hasAttribute("inert")).toBe(false);
      const slot = Object.entries(store).filter(([, v]: any) => v?.docId).map(([, v]: any) => v.docId);
      expect(slot).toEqual(["doc-bcp"]); // BCP — not AWP written back over it
      expect(JSON.stringify(Object.entries(store).filter(([k]) => k.endsWith(":scope")).map(([, v]) => v))).toBe("[null]");
    } finally {
      set.mockImplementation(real);
    }
  });

  it("a companion connecting in the middle of a switch never gets a standalone sheet put on its screen", async () => {
    const t = await mountTab();
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await sleep(20);
    const set = (globalThis as any).chrome.storage.local.set as ReturnType<typeof vi.fn>;
    const real = set.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    set.mockImplementation(async (o: any) => {
      if (JSON.stringify(o).includes("doc-bcp")) await held;
      return real(o);
    });
    try {
      const switching = t.app.switchTestSheet("doc-bcp");
      for (let i = 0; i < 40 && !t.app.testPilot.sheetSwapping; i++) await sleep(5);
      // The companion comes up and its project's catalog loads.
      (t.app as any).selectedCompanion = { port: 7878, projectRoot: "C:/p", pid: 1 };
      t.app.testPilot.catalog = sheetCatalog("doc-project", "Project catalog", "PRJ");
      release();
      expect(await switching).toBe(false);
      await sleep(20);
      expect(t.app.testPilot.catalog!.docId).toBe("doc-project");
      expect(t.app.testPilot.sheetSwapping).toBe(false);
      // Both standalone sheets are still saved for the next standalone session.
      expect(await t.shelf.get("doc-awp")).toBeTruthy();
      expect(await t.shelf.get("doc-bcp")).toBeTruthy();
    } finally {
      set.mockImplementation(real);
      (t.app as any).selectedCompanion = null;
    }
  });

  it("one sheet's plans, scope and run banner never show under another after a switch + reload", async () => {
    const t = await mountTab();
    t.app.setTestStatus("BCP-01", "fail");
    t.app.setTestPilotScope({ kind: "failed" });
    t.app.saveCurrentScopeAsPlan("BCP smoke");
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await t.app.switchTestSheet("doc-bcp");
    await t.app.switchTestSheet("doc-awp"); // AWP has no plans, scope or run
    await sleep(20);
    expect(JSON.stringify(store)).not.toContain("BCP smoke");
    await t.app.loadTestPilot(null); // reload
    await t.settle();
    expect(t.app.testPilot.catalog!.docId).toBe("doc-awp");
    expect(t.app.testPilot.plans).toEqual([]);
    expect(t.app.testPilot.scope).toEqual({ kind: "all" });
    expect(t.app.testPilot.importedRun).toBeNull();
  });

  it("a shelf that can't be read is never mistaken for an empty one", async () => {
    const t = await mountTab();
    t.app.setTestStatus("BCP-01", "pass");
    await t.app.importTestDoc("awp-uat.md", await t.awp()); // BCP (marked) saved
    await t.settle();
    const list = vi.spyOn(t.shelf, "list").mockRejectedValue(new Error("database busy"));
    const get = vi.spyOn(t.shelf, "get").mockRejectedValue(new Error("database busy"));
    try {
      // Re-importing BCP's file: without the shelf we can't know a marked
      // copy exists — the import stops instead of opening a blank BCP.
      await t.app.importTestDoc("bcp-uat.md", await testerSheetMd("doc-bcp", "UAT — Broker Connect Portal (BCP)", "BCP"));
      await t.settle();
      expect(t.app.testPilot.catalog!.docId).toBe("doc-awp");
      expect(t.app.testPilot.error).toMatch(/Couldn't check your saved sheets, so nothing was imported.*database busy/);
      t.app.testPilot.error = null;
      // Switching says "couldn't open, still saved" — not "no longer saved" —
      // and the list keeps showing it.
      expect(await t.app.switchTestSheet("doc-bcp")).toBe(false);
      expect(t.app.testPilot.error).toMatch(/couldn't be opened just now — it is still saved.*database busy/);
      expect(t.app.testPilot.savedSheets.map((s) => s.docId)).toEqual(["doc-bcp"]);
    } finally {
      list.mockRestore();
      get.mockRestore();
      t.app.testPilot.error = null;
    }
    expect(await t.app.switchTestSheet("doc-bcp")).toBe(true);
    expect(t.row("BCP-01").status).toBe("pass");
  });

  it("an open test closes when another sheet takes the screen (it never rebinds to the same id there)", async () => {
    const t = await mountTab();
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await t.settle();
    t.btn(/^Open AUTH-06$/)!.click(); // AWP's AUTH-06
    await t.settle();
    expect(t.btn(/Back to catalog/)).toBeTruthy();
    expect(t.target.querySelector("section[aria-busy]")).toBeTruthy(); // the detail view takes the same lock
    await t.app.switchTestSheet("doc-bcp"); // BCP also has an AUTH-06
    await t.settle();
    expect(t.btn(/Back to catalog/)).toBeUndefined();
    expect(t.btn(/^Switch test sheet$/)).toBeTruthy(); // back on the catalog view of BCP
  });

  it("Escape closes the switcher and puts focus back on its button", async () => {
    const t = await mountTab();
    await t.openMenu();
    const menu = t.target.querySelector<HTMLElement>('[role="dialog"][aria-label="Your test sheets"]')!;
    expect(menu).toBeTruthy();
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await t.settle();
    expect(t.target.querySelector('[role="dialog"][aria-label="Your test sheets"]')).toBeNull();
    expect(document.activeElement).toBe(t.btn(/^Switch test sheet$/));
    // Clicking the title to rename it also closes the menu.
    await t.openMenu();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await t.settle();
    expect(t.target.querySelector('[role="dialog"][aria-label="Your test sheets"]')).toBeNull();
  });

  it("saved plans and the working scope travel with their sheet", async () => {
    const t = await mountTab();
    t.app.setTestStatus("BCP-01", "fail");
    t.app.setTestPilotScope({ kind: "failed" });
    const plan = t.app.saveCurrentScopeAsPlan("BCP smoke")!; // scope → that plan
    expect(plan.testIds).toEqual(["BCP-01"]);
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await t.settle();
    // A fresh sheet starts with no plans and the whole catalog in view.
    expect(t.app.testPilot.plans).toEqual([]);
    expect(t.app.testPilot.scope).toEqual({ kind: "all" });
    await sleep(20);
    expect(JSON.stringify(store)).not.toContain("BCP smoke"); // not left in the open slot
    await t.app.switchTestSheet("doc-bcp");
    await t.settle();
    expect(t.app.testPilot.plans.map((p) => p.name)).toEqual(["BCP smoke"]);
    expect(t.app.testPilot.scope).toEqual({ kind: "plan", id: plan.id });
    await sleep(20);
    expect(JSON.stringify(store)).toContain("BCP smoke"); // persisted with the open sheet again
  });

  it("if the open sheet can't be saved, nothing is switched or imported and she is told", async () => {
    const t = await mountTab();
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await t.settle();
    t.app.setTestStatus("AWP-01", "pass");
    const put = vi.spyOn(t.shelf, "put").mockRejectedValue(new Error("disk full"));
    try {
      expect(await t.app.switchTestSheet("doc-bcp")).toBe(false);
      expect(t.app.testPilot.catalog!.docId).toBe("doc-awp");
      expect(t.row("AWP-01").status).toBe("pass");
      expect(t.app.testPilot.error).toMatch(/Couldn't save the sheet you have open.*disk full/);
      expect(await t.shelf.get("doc-bcp")).toBeTruthy(); // still saved
      t.app.testPilot.error = null;
      await t.app.importTestDoc("third.md", await testerSheetMd("doc-third", "Third project", "TP"));
      expect(t.app.testPilot.catalog!.docId).toBe("doc-awp");
      expect(t.app.testPilot.error).toMatch(/nothing was imported/);
    } finally {
      put.mockRestore();
      t.app.testPilot.error = null;
    }
  });

  it("two quick switches never lose or duplicate a sheet", async () => {
    const t = await mountTab();
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await t.app.importTestDoc("third.md", await testerSheetMd("doc-third", "Third project", "TP"));
    await t.settle();
    const a = t.app.switchTestSheet("doc-bcp");
    const b = t.app.switchTestSheet("doc-awp");
    await Promise.all([a, b]);
    await t.settle();
    const all = [t.app.testPilot.catalog!.docId, ...t.app.testPilot.savedSheets.map((s) => s.docId)].sort();
    expect(all).toEqual(["doc-awp", "doc-bcp", "doc-third"]);
    expect(t.app.testPilot.catalog!.docId).toBe("doc-awp");
    expect(t.shelf.size()).toBe(2);
  });

  it("a half-written failure note stays with its own sheet, even when both sheets share a test id", async () => {
    const t = await mountTab();
    t.app.setTestStatus("AUTH-06", "fail");
    await t.settle();
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    const ta = t.target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Failure description for AUTH-06"]')!;
    ta.value = "BCP draft";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await t.settle();
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    t.app.setTestStatus("AUTH-06", "fail"); // AWP also has an AUTH-06
    await t.settle();
    expect(t.target.querySelector("[data-pinta-fail-note-composer]")).toBeNull();
    expect(t.btn(/^Add failure note for AUTH-06$/)).toBeTruthy();
    await t.app.switchTestSheet("doc-bcp");
    await t.settle();
    expect(t.target.querySelector<HTMLTextAreaElement>('textarea[aria-label="Failure description for AUTH-06"]')!.value).toBe("BCP draft");
  });

  it("connected to a project: no switcher, and an import still replaces in place as before", async () => {
    const t = await mountTab("connected");
    expect(t.btn(/^Switch test sheet$/)).toBeUndefined();
    const put = vi.spyOn(t.shelf, "put");
    await t.app.importTestDoc("awp-uat.md", await t.awp());
    await t.settle();
    expect(put).not.toHaveBeenCalled();
    expect(t.app.testPilot.savedSheets).toEqual([]);
    expect(await t.app.switchTestSheet("doc-bcp")).toBe(false);
  });
});
