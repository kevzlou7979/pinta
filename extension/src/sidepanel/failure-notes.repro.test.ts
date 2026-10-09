// Test Pilot failure notes: a failed row gets an inline "Add failure
// note" composer (description + steps to reproduce + screenshots), a row
// can carry several notes, and the results exports name the test id +
// title next to each note.
//   npx vitest run --config vitest.repro.config.ts failure-notes
import { describe, it, expect, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";

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

// 1×1 PNG — what the downscaler hands back for a picked / pasted file.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const downscaleImage = vi.fn(async () => ({ dataUrl: PNG, mediaType: "image/png" }));
vi.mock("../lib/downscale-image.js", () => ({ downscaleImage: (...a: unknown[]) => (downscaleImage as any)(...a) }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function catalog() {
  return {
    docId: "doc-1", filename: "uat.md", importedAt: 0, title: "Portal UAT",
    sections: [{
      title: "1.1 Authentication",
      tests: [
        { id: "AUTH-05", test: "Deep link without permission", expected: "Unauthorized page", status: "pass" },
        { id: "AUTH-06", test: "Log out from the user menu", expected: "Returns to /login", status: "fail" },
        { id: "AUTH-07", test: "Forgot password", expected: "Recovery form opens", status: "untested" },
      ],
    }],
  } as any;
}

async function mountTab() {
  const { mount, flushSync, tick } = await import("svelte");
  const { app } = await import("../lib/state.svelte.js");
  const { default: TestPilotTab } = await import("./TestPilotTab.svelte");
  document.body.innerHTML = "";
  const target = document.createElement("div");
  document.body.appendChild(target);
  (app as any).selectedCompanion = null; // the tester persona: standalone
  (app as any).scanning = false;
  app.connectionStatus = "disconnected";
  (app as any).client = null;
  app.modules["test-pilot"] = { enabled: true, settings: {} } as any;
  app.testPilot.importedRun = null;
  app.failureNoteDrafts.clear();
  app.testPilot.catalog = catalog();
  app.testPilot.error = null;
  mount(TestPilotTab, { target });
  await sleep(50);
  const settle = async () => { flushSync(); await tick(); };
  await settle();
  const btn = (re: RegExp, root: ParentNode = target) =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => re.test(b.getAttribute("aria-label") ?? "") || re.test(norm(b.textContent)),
    );
  const notes = (id: string) => target.querySelector<HTMLElement>(`[data-pinta-fail-notes="${id}"]`);
  const type = async (el: HTMLTextAreaElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  };
  const row = (id: string) => app.testPilot.catalog!.sections[0]!.tests.find((t) => t.id === id)!;
  return { app, target, settle, btn, notes, type, row };
}

describe("Test Pilot — failure notes", () => {
  it("only a failed row offers 'Add failure note'", async () => {
    const t = await mountTab();
    expect(t.btn(/^Add failure note for AUTH-06$/)).toBeTruthy();
    expect(t.btn(/^Add failure note for AUTH-05$/)).toBeUndefined(); // passed
    expect(t.btn(/^Add failure note for AUTH-07$/)).toBeUndefined(); // untested
    // Marking a row failed brings the affordance; un-failing it takes it away.
    t.app.setTestStatus("AUTH-07", "fail");
    await t.settle();
    expect(t.btn(/^Add failure note for AUTH-07$/)).toBeTruthy();
    t.app.setTestStatus("AUTH-07", "pass");
    await t.settle();
    expect(t.btn(/^Add failure note for AUTH-07$/)).toBeUndefined();
  });

  it("saves a note with description, steps and a screenshot, and shows it under the row", async () => {
    const t = await mountTab();
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    const box = t.notes("AUTH-06")!;
    const save = t.btn(/^Save note$/, box)!;
    expect(save.disabled).toBe(true); // nothing typed yet
    await t.type(box.querySelector<HTMLTextAreaElement>('textarea[aria-label="Failure description for AUTH-06"]')!, "Stays on the dashboard after Log out.");
    await t.type(box.querySelector<HTMLTextAreaElement>('textarea[aria-label="Steps to reproduce for AUTH-06"]')!, "1. Sign in\nOpen the user menu\n- Click Log out");
    // Attach a screenshot through the file picker.
    const input = box.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "logout.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 40 && !box.querySelector("img"); i++) { await sleep(10); await t.settle(); }
    expect(downscaleImage).toHaveBeenCalledTimes(1);
    expect(box.querySelector("img")!.getAttribute("src")).toBe(PNG);
    expect(save.disabled).toBe(false);
    save.click();
    await t.settle();

    const saved = t.row("AUTH-06").failNotes!;
    expect(saved).toHaveLength(1);
    expect(saved[0]!.description).toBe("Stays on the dashboard after Log out.");
    expect(saved[0]!.images).toEqual([{ dataUrl: PNG, mediaType: "image/png", name: "logout.png" }]);
    // Rendered card: description, renumbered steps, thumbnail; composer gone.
    const text = norm(t.notes("AUTH-06")!.textContent);
    expect(text).toContain("Stays on the dashboard after Log out.");
    expect([...t.notes("AUTH-06")!.querySelectorAll("ol li")].map((li) => norm(li.textContent))).toEqual(["Sign in", "Open the user menu", "Click Log out"]);
    expect(t.notes("AUTH-06")!.querySelector("[data-pinta-fail-note-composer]")).toBeNull();
    expect(t.notes("AUTH-06")!.querySelectorAll("img")).toHaveLength(1);
    // Persisted with the catalog.
    expect(JSON.stringify(store)).toContain("Stays on the dashboard after Log out.");
  });

  it("a row can carry several notes; each can be edited and deleted", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "First problem" });
    await t.settle();
    t.btn(/^Add failure note for AUTH-06$/)!.click(); // now reads "Add another note"
    await t.settle();
    await t.type(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!, "Second problem");
    t.btn(/^Save note$/, t.notes("AUTH-06")!)!.click();
    await t.settle();
    expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["First problem", "Second problem"]);
    expect(norm(t.notes("AUTH-06")!.textContent)).toContain("Failure note 2");

    // Edit note 1 in place.
    t.btn(/^Edit failure note 1 for AUTH-06$/)!.click();
    await t.settle();
    const ta = t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(ta.value).toBe("First problem");
    await t.type(ta, "First problem, reworded");
    t.btn(/^Save note$/, t.notes("AUTH-06")!)!.click();
    await t.settle();
    expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["First problem, reworded", "Second problem"]);

    // Delete note 2 (confirm dialog → accept).
    const { confirmService } = await import("../lib/confirm.svelte.js");
    t.btn(/^Delete failure note 2 for AUTH-06$/)!.click();
    await t.settle();
    expect(confirmService.pending?.title).toBe("Delete this failure note?");
    // Declining keeps the note.
    confirmService.answer(false);
    await sleep(0); await t.settle();
    expect(t.row("AUTH-06").failNotes).toHaveLength(2);
    t.btn(/^Delete failure note 2 for AUTH-06$/)!.click();
    await t.settle();
    confirmService.answer(true);
    await sleep(0); await t.settle();
    expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["First problem, reworded"]);
    expect(t.btn(/^Delete failure note 2 for AUTH-06$/)).toBeUndefined();
  });

  it("a section finished with a failure stays open so the note can be added; an all-pass section still folds", async () => {
    const t = await mountTab();
    t.app.testPilot.catalog!.sections.push({
      title: "1.2 Profile",
      tests: [{ id: "PRO-01", test: "Open profile", expected: "Profile shows", status: "untested" }],
    } as any);
    await t.settle();
    // Last unmarked row of 1.1 is failed → section complete, but open.
    t.app.setTestStatus("AUTH-07", "fail");
    await t.settle();
    expect(t.btn(/^Add failure note for AUTH-07$/)).toBeTruthy();
    // 1.2 completes with a pass → folds as before.
    expect(t.target.querySelector('[data-test-row="PRO-01"]')).toBeTruthy();
    t.app.setTestStatus("PRO-01", "pass");
    await t.settle();
    expect(t.target.querySelector('[data-test-row="PRO-01"]')).toBeNull();
  });

  it("Cancel discards the draft; an empty note is never saved", async () => {
    const t = await mountTab();
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    await t.type(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!, "typed then dropped");
    t.btn(/^Cancel$/, t.notes("AUTH-06")!)!.click();
    await t.settle();
    expect(t.row("AUTH-06").failNotes).toBeUndefined();
    expect(t.app.saveFailureNote("AUTH-06", { description: "   ", steps: "\n" })).toBe(false);
    expect(t.app.saveFailureNote("NOPE-1", { description: "x" })).toBe(false);
  });

  it("the detail view of a failed test shows the same notes", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "Stays on the dashboard after Log out." });
    await t.settle();
    t.btn(/^Open AUTH-06$/)!.click();
    await t.settle();
    expect(t.btn(/Back to catalog/)).toBeTruthy();
    expect(norm(t.notes("AUTH-06")!.textContent)).toContain("Stays on the dashboard after Log out.");
    expect(t.btn(/^Add failure note for AUTH-06$/)).toBeTruthy();
  });

  it("results export (.md) names the test id + title beside each note", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", {
      description: "Stays on the dashboard after Log out.",
      steps: "Sign in\nClick Log out",
      images: [{ dataUrl: PNG, mediaType: "image/png", name: "logout.png" }],
    });
    const md = t.app.exportResults();
    expect(md).toContain("| AUTH-06 | Log out from the user menu | Returns to /login | ✗ Fail [notes] |");
    expect(md).toContain("**Failure note — AUTH-06 · Log out from the user menu**");
    expect(md).toContain("> Stays on the dashboard after Log out.");
    expect(md).toContain("> 2. Click Log out");
    expect(md).toContain("> _[image: logout.png]_");
  });

  it("results export (.docx) carries id, title, description, steps and the embedded screenshot", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", {
      description: "Stays on the dashboard after Log out.",
      steps: "Sign in\nClick Log out",
      images: [{ dataUrl: PNG, mediaType: "image/png", name: "logout.png" }],
    });
    const files = unzipSync((await t.app.exportResultsDocx())!);
    const xml = strFromU8(files["word/document.xml"]!);
    expect(xml).toContain("AUTH-06 — Log out from the user menu");
    expect(xml).toContain("Stays on the dashboard after Log out.");
    expect(xml).toContain("2. Click Log out");
    expect(files["word/media/image1.png"]).toBeTruthy();
  });

  it(".pinta bundle: the tester's notes ride back, show read-only, and Clear restores the developer's", async () => {
    const t = await mountTab();
    // The developer's own note before the tester's run comes in.
    t.app.saveFailureNote("AUTH-06", { description: "Dev's own note" });
    const tp = {
      docId: "doc-1",
      signoff: null,
      statuses: { "AUTH-06": "fail", "AUTH-07": "fail" },
      failNotes: {
        "AUTH-06": [{ id: "t1", at: 1, description: "Tester saw the dashboard" }],
        "AUTH-07": [{ id: "t2", at: 1, description: "Recovery form never opens" }],
      },
    };
    (t.app as any).applyBundleTestPilot(tp);
    await t.settle();
    expect(t.app.testPilot.importedRun).toBeTruthy();
    expect(norm(t.notes("AUTH-06")!.textContent)).toContain("Tester saw the dashboard");
    expect(norm(t.notes("AUTH-07")!.textContent)).toContain("Recovery form never opens");
    // Read-only: no add / edit / delete, and the state guards agree.
    expect(t.btn(/^Add failure note for AUTH-06$/)).toBeUndefined();
    expect(t.btn(/^Edit failure note 1 for AUTH-06$/)).toBeUndefined();
    expect(t.btn(/^Delete failure note 1 for AUTH-06$/)).toBeUndefined();
    expect(t.app.saveFailureNote("AUTH-06", { description: "nope" })).toBe(false);
    t.app.deleteFailureNote("AUTH-06", "t1");
    expect(t.row("AUTH-06").failNotes!.map((n) => n.id)).toEqual(["t1"]);

    t.app.clearImportedRun();
    await t.settle();
    expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["Dev's own note"]);
    expect(t.row("AUTH-07").failNotes).toBeUndefined();
  });

  it("a run with no note on a row hides the developer's note there, and Clear brings it back", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "Dev's own note" });
    (t.app as any).applyBundleTestPilot({ docId: "doc-1", signoff: null, statuses: { "AUTH-06": "fail" } });
    await t.settle();
    // Nothing of the developer's is shown (or exported) as the tester's.
    expect(t.row("AUTH-06").failNotes).toBeUndefined();
    expect(t.notes("AUTH-06")).toBeNull();
    expect(t.app.exportResults()).not.toContain("Dev's own note");
    t.app.clearImportedRun();
    await t.settle();
    expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["Dev's own note"]);
  });

  it("a returned results .md (no notes in it) hides the developer's notes the same way", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "Dev's own note" });
    const run = catalog();
    (t.app as any).applyRunOverlay(run, null);
    await t.settle();
    expect(t.app.testPilot.importedRun).toBeTruthy();
    expect(t.row("AUTH-06").failNotes).toBeUndefined();
    t.app.clearImportedRun();
    expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["Dev's own note"]);
  });

  it("importing a second run on top of the first still restores the DEVELOPER's marks and notes on Clear", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "Dev's own note" });
    const bundle = (desc: string) => ({
      docId: "doc-1",
      signoff: null,
      statuses: { "AUTH-05": "fail", "AUTH-06": "fail" },
      failNotes: { "AUTH-06": [{ id: "t1", at: 1, description: desc }] },
    });
    (t.app as any).applyBundleTestPilot(bundle("Tester A"));
    (t.app as any).applyBundleTestPilot(bundle("Tester B"));
    await t.settle();
    expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["Tester B"]);
    t.app.clearImportedRun();
    expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["Dev's own note"]);
    expect(t.row("AUTH-05").status).toBe("pass"); // the developer's mark, not tester A's
  });

  it("storage full while keeping the imported run: the overlay is undone and the tester told why", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "Dev's own note" });
    const set = (globalThis as any).chrome.storage.local.set as ReturnType<typeof vi.fn>;
    const real = set.getMockImplementation()!;
    set.mockImplementation(async (o: any) => {
      if (Object.keys(o).some((k) => k.endsWith(":run"))) throw new Error("QUOTA_BYTES quota exceeded");
      return real(o);
    });
    try {
      (t.app as any).applyBundleTestPilot({
        docId: "doc-1",
        signoff: null,
        statuses: { "AUTH-06": "fail" },
        failNotes: { "AUTH-06": [{ id: "t1", at: 1, description: "Tester note" }] },
      });
      for (let i = 0; i < 40 && t.app.testPilot.importedRun; i++) await sleep(10);
      expect(t.app.testPilot.importedRun).toBeNull();
      expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["Dev's own note"]);
      expect(t.app.testPilot.error).toMatch(/storage is full.*imported run couldn't be kept/i);
    } finally {
      set.mockImplementation(real);
      t.app.testPilot.error = null;
    }
  });

  it("a half-written note survives opening the test's detail view and coming back", async () => {
    const t = await mountTab();
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    await t.type(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!, "half-written");
    t.btn(/^Open AUTH-06$/)!.click(); // the row's component unmounts
    await t.settle();
    expect(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("half-written");
    t.btn(/Back to catalog/)!.click();
    await t.settle();
    const ta = t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(ta.value).toBe("half-written");
    // Escape does not throw typed work away; Cancel does.
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await t.settle();
    expect(t.notes("AUTH-06")!.querySelector("[data-pinta-fail-note-composer]")).toBeTruthy();
    t.btn(/^Cancel$/, t.notes("AUTH-06")!)!.click();
    await t.settle();
    expect(t.notes("AUTH-06")!.querySelector("[data-pinta-fail-note-composer]")).toBeNull();
    // An untouched composer does close on Escape.
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await t.settle();
    expect(t.notes("AUTH-06")!.querySelector("[data-pinta-fail-note-composer]")).toBeNull();
    expect(t.row("AUTH-06").failNotes).toBeUndefined();
  });

  it("Ctrl+Enter saves the note", async () => {
    const t = await mountTab();
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    const ta = t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!;
    await t.type(ta, "saved from the keyboard");
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await t.settle();
    expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["saved from the keyboard"]);
  });

  it("a screenshot still downscaling when the draft is cancelled never lands in the next draft", async () => {
    const t = await mountTab();
    let release!: () => void;
    downscaleImage.mockImplementationOnce(
      () => new Promise((r) => { release = () => r({ dataUrl: PNG, mediaType: "image/png" }); }) as any,
    );
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    const input = t.notes("AUTH-06")!.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "slow.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await t.settle();
    t.btn(/^Cancel$/, t.notes("AUTH-06")!)!.click();
    await t.settle();
    t.btn(/^Add failure note for AUTH-06$/)!.click(); // a fresh draft
    await t.settle();
    release();
    await sleep(20); await t.settle();
    expect(t.notes("AUTH-06")!.querySelectorAll("img")).toHaveLength(0);
    t.btn(/^Cancel$/, t.notes("AUTH-06")!)!.click();
    await t.settle();
  });

  it("notes hidden on an un-marked row can still be cleared (Clear marks stays reachable)", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "kept but hidden" });
    for (const id of ["AUTH-05", "AUTH-06", "AUTH-07"]) t.app.setTestStatus(id, "untested");
    await t.settle();
    expect(t.app.testPilotHasMarks).toBe(false);
    const clear = t.target.querySelector<HTMLButtonElement>('button[title^="Clear marks"]')!;
    expect(clear.disabled).toBe(false);
    clear.click();
    await t.settle();
    const { confirmService } = await import("../lib/confirm.svelte.js");
    expect(confirmService.pending?.message).toContain("Failure notes on 1 test are deleted too.");
    confirmService.answer(true);
    await sleep(0); await t.settle();
    expect(t.row("AUTH-06").failNotes).toBeUndefined();
    expect(t.target.querySelector<HTMLButtonElement>('button[title^="Clear marks"]')!.disabled).toBe(true);
  });

  it("Escape closes a screenshot preview opened from the composer, not the composer", async () => {
    const t = await mountTab();
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    const box = t.notes("AUTH-06")!;
    const input = box.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "a.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 40 && !box.querySelector("img"); i++) { await sleep(10); await t.settle(); }
    const thumb = t.btn(/^View screenshot 1 for AUTH-06$/, box)!;
    thumb.click();
    await t.settle();
    const preview = () => t.target.querySelector('[aria-label="Close image preview"]');
    expect(preview()).toBeTruthy();
    thumb.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await t.settle();
    expect(preview()).toBeNull();
    expect(box.querySelector("[data-pinta-fail-note-composer]")).toBeTruthy();
    expect(box.querySelectorAll("img")).toHaveLength(1);
    t.btn(/^Cancel$/, box)!.click();
    await t.settle();
  });

  it("while a note is being written, Edit / Delete on the other notes wait (no silent discard)", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "One" });
    t.app.saveFailureNote("AUTH-06", { description: "Two" });
    await t.settle();
    t.btn(/^Edit failure note 1 for AUTH-06$/)!.click();
    await t.settle();
    await t.type(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!, "One, rewritten");
    const editTwo = t.btn(/^Edit failure note 2 for AUTH-06$/)!;
    expect(editTwo.disabled).toBe(true);
    expect(t.btn(/^Delete failure note 2 for AUTH-06$/)!.disabled).toBe(true);
    editTwo.click();
    await t.settle();
    expect(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("One, rewritten");
    t.btn(/^Save note$/, t.notes("AUTH-06")!)!.click();
    await t.settle();
    expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["One, rewritten", "Two"]);
    expect(t.btn(/^Edit failure note 2 for AUTH-06$/)!.disabled).toBe(false);
  });

  it("Clear marks drops a half-written note too — it does not come back in the next run", async () => {
    const t = await mountTab();
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    await t.type(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!, "from the old run");
    t.app.clearTestPilotMarks();
    await t.settle();
    t.app.setTestStatus("AUTH-06", "fail");
    await t.settle();
    expect(t.notes("AUTH-06")!.querySelector("[data-pinta-fail-note-composer]")).toBeNull();
    expect(t.btn(/^Add failure note for AUTH-06$/)).toBeTruthy();
  });

  it("only PNG/JPEG data URLs are ever stored on a note", async () => {
    const t = await mountTab();
    const ok = t.app.saveFailureNote("AUTH-06", {
      description: "d",
      images: [
        { dataUrl: "javascript:alert(1)", mediaType: "image/png" },
        { dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", mediaType: "image/svg+xml" },
        { dataUrl: PNG, mediaType: "image/png", name: "ok\n## x.png" },
      ],
    });
    expect(ok).toBe(true);
    expect(t.row("AUTH-06").failNotes![0]!.images).toEqual([{ dataUrl: PNG, mediaType: "image/png", name: "ok ## x.png" }]);
    // A note made of nothing but rejected images is not saved at all.
    expect(t.app.saveFailureNote("AUTH-06", { description: "", images: [{ dataUrl: "https://x/y.png", mediaType: "image/png" }] })).toBe(false);
  });

  it("a row whose id is __proto__ keeps its notes in the exported bundle", async () => {
    const t = await mountTab();
    t.app.testPilot.catalog!.sections[0]!.tests.push({ id: "__proto__", test: "odd id", expected: "ok", status: "fail" } as any);
    expect(t.app.saveFailureNote("__proto__", { description: "odd row note" })).toBe(true);
    const tp = t.app.buildPintaTestPilot(null)!;
    expect(Object.keys(tp.failNotes!)).toEqual(["__proto__"]);
    expect(JSON.stringify(tp)).toContain("odd row note");
  });

  it("storage full on the CATALOG save while a run is overlaid also undoes the overlay", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "Dev's own note" });
    await sleep(0);
    const set = (globalThis as any).chrome.storage.local.set as ReturnType<typeof vi.fn>;
    const real = set.getMockImplementation()!;
    // The run sidecar (small) fits; the catalog with the tester's notes does not.
    set.mockImplementation(async (o: any) => {
      if (JSON.stringify(o).includes("Tester note")) throw new Error("QUOTA_BYTES quota exceeded");
      return real(o);
    });
    try {
      (t.app as any).applyBundleTestPilot({
        docId: "doc-1",
        signoff: null,
        statuses: { "AUTH-06": "fail" },
        failNotes: { "AUTH-06": [{ id: "t1", at: 1, description: "Tester note" }] },
      });
      for (let i = 0; i < 40 && t.app.testPilot.importedRun; i++) await sleep(10);
      expect(t.app.testPilot.importedRun).toBeNull();
      expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["Dev's own note"]);
      expect(t.app.testPilot.error).toMatch(/imported run couldn't be kept/);
    } finally {
      set.mockImplementation(real);
      t.app.testPilot.error = null;
    }
  });

  it("a later storage-full save under a stored run is an ordinary error — the run is NOT thrown away", async () => {
    const t = await mountTab();
    (t.app as any).applyBundleTestPilot({
      docId: "doc-1",
      signoff: null,
      statuses: { "AUTH-06": "fail" },
      failNotes: { "AUTH-06": [{ id: "t1", at: 1, description: "Tester note" }] },
    });
    await sleep(20); // the overlay's own saves land
    const set = (globalThis as any).chrome.storage.local.set as ReturnType<typeof vi.fn>;
    const real = set.getMockImplementation()!;
    set.mockImplementation(async () => { throw new Error("QUOTA_BYTES quota exceeded"); });
    try {
      await (t.app as any).saveTestPilot(); // e.g. a chat screenshot on a row
      await sleep(20);
      expect(t.app.testPilot.importedRun).toBeTruthy();
      expect(t.row("AUTH-06").failNotes!.map((n) => n.description)).toEqual(["Tester note"]);
      expect(t.app.testPilot.error).toMatch(/couldn't save your latest change/);
    } finally {
      set.mockImplementation(real);
      t.app.testPilot.error = null;
    }
  });

  it("no unsaved-note warning under an imported run (the developer's hidden drafts are not part of it)", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "Dev's own note" });
    await t.settle();
    t.btn(/^Edit failure note 1 for AUTH-06$/)!.click(); // open, unchanged
    await t.settle();
    (t.app as any).applyBundleTestPilot({
      docId: "doc-1",
      signoff: null,
      statuses: { "AUTH-06": "fail" },
      failNotes: { "AUTH-06": [{ id: "t1", at: 1, description: "Tester note" }] },
    });
    await t.settle();
    expect(t.app.unsavedFailureNoteCount()).toBe(0);
    t.app.clearImportedRun();
    await t.settle();
    t.btn(/^Cancel$/, t.notes("AUTH-06")!)!.click();
    await t.settle();
  });

  it("exporting results with a note typed but not saved asks first", async () => {
    const t = await mountTab();
    const { confirmService } = await import("../lib/confirm.svelte.js");
    expect(t.app.unsavedFailureNoteCount()).toBe(0);
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    expect(t.app.unsavedFailureNoteCount()).toBe(0); // open but empty
    await t.type(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!, "typed, never saved");
    expect(t.app.unsavedFailureNoteCount()).toBe(1);
    t.btn(/^Export catalog$/)!.click();
    await t.settle();
    const group = t.target.querySelector('[aria-label="Export options"]')!;
    const results = [...group.querySelectorAll("div")].find((d) => d.firstElementChild?.textContent?.trim() === "Results")!;
    [...results.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.trim() === ".docx")!.click();
    await t.settle();
    expect(confirmService.pending?.title).toBe("Unsaved failure notes");
    expect(confirmService.pending?.message).toContain("1 failure note is written but not saved");
    confirmService.answer(false); // Go back
    await sleep(0); await t.settle();
    // The draft is still there to be saved.
    expect(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("typed, never saved");
    t.btn(/^Save note$/, t.notes("AUTH-06")!)!.click();
    await t.settle();
    expect(t.app.unsavedFailureNoteCount()).toBe(0);
    // An edit that changes nothing is not "unsaved"; one that does is.
    t.btn(/^Edit failure note 1 for AUTH-06$/)!.click();
    await t.settle();
    expect(t.app.unsavedFailureNoteCount()).toBe(0);
    await t.type(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!, "typed, then changed");
    expect(t.app.unsavedFailureNoteCount()).toBe(1);
    t.btn(/^Cancel$/, t.notes("AUTH-06")!)!.click();
    await t.settle();
    expect(t.app.unsavedFailureNoteCount()).toBe(0);
  });

  it("two overlapping attaches never exceed the limit, and Save waits for both", async () => {
    const t = await mountTab();
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    const box = t.notes("AUTH-06")!;
    const input = box.querySelector<HTMLInputElement>('input[type="file"]')!;
    const pick = (n: number) => {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: Array.from({ length: n }, (_, i) => new File(["x"], `p${i}.png`, { type: "image/png" })),
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    pick(3);
    for (let i = 0; i < 40 && box.querySelectorAll("img").length < 3; i++) { await sleep(10); await t.settle(); }
    await t.type(box.querySelector<HTMLTextAreaElement>("textarea")!, "d");
    // Two slow attaches in flight at once, each sees room for one.
    const releases: (() => void)[] = [];
    downscaleImage.mockImplementation(
      () => new Promise((r) => { releases.push(() => r({ dataUrl: PNG, mediaType: "image/png" })); }) as any,
    );
    try {
      pick(1);
      pick(1);
      await t.settle();
      const save = t.btn(/^Save note$/, box)!;
      expect(save.disabled).toBe(true);
      releases[0]!();
      await sleep(10); await t.settle();
      expect(save.disabled).toBe(true); // the second is still downscaling
      releases[1]!();
      await sleep(10); await t.settle();
      expect(save.disabled).toBe(false);
      expect(box.querySelectorAll("img")).toHaveLength(4);
      expect(norm(box.textContent)).toContain("1 screenshot left out");
    } finally {
      downscaleImage.mockImplementation(async () => ({ dataUrl: PNG, mediaType: "image/png" }));
    }
    t.btn(/^Cancel$/, box)!.click();
    await t.settle();
  });

  it("an edit in progress survives an imported run replacing the row's notes, and is back after Clear", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "Dev's own note" });
    await t.settle();
    t.btn(/^Edit failure note 1 for AUTH-06$/)!.click();
    await t.settle();
    await t.type(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!, "Dev's note, half reworded");
    (t.app as any).applyBundleTestPilot({
      docId: "doc-1",
      signoff: null,
      statuses: { "AUTH-06": "fail" },
      failNotes: { "AUTH-06": [{ id: "t1", at: 1, description: "Tester note" }] },
    });
    await t.settle();
    expect(t.notes("AUTH-06")!.querySelector("[data-pinta-fail-note-composer]")).toBeNull();
    expect(norm(t.notes("AUTH-06")!.textContent)).toContain("Tester note");
    t.app.clearImportedRun();
    await t.settle();
    expect(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Dev's note, half reworded");
    // Same when the row's component was not mounted during the run.
    (t.app as any).applyBundleTestPilot({ docId: "doc-1", signoff: null, statuses: { "AUTH-06": "pass" } });
    await t.settle();
    expect(t.notes("AUTH-06")).toBeNull();
    t.app.clearImportedRun();
    await t.settle();
    expect(t.notes("AUTH-06")!.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Dev's note, half reworded");
    t.btn(/^Cancel$/, t.notes("AUTH-06")!)!.click();
    await t.settle();
    expect(t.notes("AUTH-06")!.querySelector("[data-pinta-fail-note-composer]")).toBeNull();
  });

  it("a deleted row's half-written note never opens on a new row that reuses its id", async () => {
    const t = await mountTab();
    const tests = t.app.testPilot.catalog!.sections[0]!.tests;
    tests.push({ id: "USER-1", test: "mine", expected: "ok", status: "fail" } as any);
    await t.settle();
    t.btn(/^Add failure note for USER-1$/)!.click();
    await t.settle();
    await t.type(t.notes("USER-1")!.querySelector<HTMLTextAreaElement>("textarea")!, "about the old row");
    t.app.removeTestPilotTest("USER-1");
    await t.settle();
    tests.push({ id: "USER-1", test: "a different test", expected: "ok", status: "fail" } as any);
    await t.settle();
    expect(t.notes("USER-1")!.querySelector("[data-pinta-fail-note-composer]")).toBeNull();
    expect(t.app.unsavedFailureNoteCount()).toBe(0);
  });

  it("claiming a standalone sheet that does not fit in storage keeps it in the standalone slot and says so", async () => {
    const t = await mountTab();
    const local = (globalThis as any).chrome.storage.local;
    const realSet = local.set.getMockImplementation()!;
    const realRemove = local.remove.getMockImplementation()!;
    const SKEY = (t.app.constructor as any).STANDALONE_TEST_PILOT_KEY as string;
    const sheet = catalog();
    sheet.docId = "doc-standalone";
    for (const k of Object.keys(store)) delete store[k];
    store[SKEY] = sheet;
    local.remove.mockImplementation(async (k: string) => { delete store[k]; });
    local.set.mockImplementation(async (o: any) => {
      // Only the standalone slot has room; the project key never fits.
      if (Object.keys(o).some((k) => k !== SKEY && JSON.stringify(o[k]).includes("doc-standalone"))) {
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      return realSet(o);
    });
    try {
      await t.app.loadTestPilot({ port: 7878, projectRoot: "C:/p", pid: 1 } as any);
      // The sheet stays whole in the standalone slot (never memory-only,
      // never half-claimed) and the project adopts nothing.
      expect((store[SKEY] as any)?.docId).toBe("doc-standalone");
      expect(t.app.testPilot.catalog).toBeNull();
      expect(Object.keys(store).filter((k) => k !== SKEY && JSON.stringify(store[k]).includes("doc-standalone"))).toEqual([]);
      expect(t.app.testPilot.error).toMatch(/storage is full.*couldn't be moved into this project/i);
    } finally {
      local.set.mockImplementation(realSet);
      local.remove.mockImplementation(realRemove);
      t.app.testPilot.error = null;
    }
  });

  it("the bundle a tester exports includes notes for failed rows only", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "Stays on the dashboard" });
    t.app.saveFailureNote("AUTH-05", { description: "left over from an earlier fail" }); // row is Pass
    const tp = t.app.buildPintaTestPilot(null)!;
    expect(Object.keys(tp.failNotes!)).toEqual(["AUTH-06"]);
  });

  it("Clear marks deletes the notes with the marks", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "Stays on the dashboard" });
    t.app.clearTestPilotMarks();
    await t.settle();
    expect(t.row("AUTH-06").failNotes).toBeUndefined();
    expect(t.notes("AUTH-06")).toBeNull();
  });

  it("notes survive a row being re-marked, but only show while it is failed", async () => {
    const t = await mountTab();
    t.app.saveFailureNote("AUTH-06", { description: "Stays on the dashboard" });
    t.app.setTestStatus("AUTH-06", "pass"); // mis-click
    await t.settle();
    expect(t.notes("AUTH-06")).toBeNull();
    expect(t.app.exportResults()).not.toContain("Stays on the dashboard");
    t.app.setTestStatus("AUTH-06", "fail");
    await t.settle();
    expect(norm(t.notes("AUTH-06")!.textContent)).toContain("Stays on the dashboard");
  });

  it("more screenshots than a note holds: the extras are left out with a dismissible notice", async () => {
    const t = await mountTab();
    downscaleImage.mockClear();
    t.btn(/^Add failure note for AUTH-06$/)!.click();
    await t.settle();
    const box = t.notes("AUTH-06")!;
    const input = box.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: Array.from({ length: 6 }, (_, i) => new File(["x"], `s${i}.png`, { type: "image/png" })),
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 60 && !/left out/.test(norm(box.textContent)); i++) { await sleep(10); await t.settle(); }
    expect(box.querySelectorAll("img")).toHaveLength(4);
    expect(norm(box.textContent)).toContain("2 screenshots left out — 4 per note. Add another note for more.");
    t.btn(/^Dismiss$/, box)!.click();
    await t.settle();
    expect(norm(box.textContent)).not.toContain("left out");
  });
});
