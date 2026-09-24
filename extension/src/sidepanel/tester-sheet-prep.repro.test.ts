// Tester-sheet export auto-generates missing steps first. A sheet whose
// "Steps" blocks all read "(no steps generated yet)" is useless to the
// tester, so the .md / .docx / email exports run the same one-at-a-time
// detail fetch the section-level Ask uses, with progress in the popover.
// Mounts TestPilotTab in happy-dom and drives it through the real Export
// popover:
//   npx vitest run --config vitest.repro.config.ts tester-sheet-prep
import { describe, it, expect, vi, beforeEach } from "vitest";

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

// happy-dom has no object URLs; the download helper needs both.
const createObjectURL = vi.fn(() => "blob:pinta");
(URL as any).createObjectURL = createObjectURL;
(URL as any).revokeObjectURL = vi.fn();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function catalog() {
  return {
    docId: "doc-1",
    filename: "uat.md",
    importedAt: 0,
    title: "My Claim 1.0",
    sections: [
      {
        title: "1.1 Auth",
        tests: [
          { id: "AUTH-01", test: "Open a valid deep-link", expected: "lands on claim", status: "untested", detail: { steps: ["Open /claims/1", "See the claim"], askedAt: 1 } },
          { id: "AUTH-02", test: "Submit a valid email", expected: "generic confirmation", status: "untested" },
        ],
      },
      {
        title: "1.2 Billing",
        tests: [
          { id: "BILL-01", test: "Pay an invoice", expected: "receipt shown", status: "untested" },
        ],
      },
    ],
  } as any;
}

async function mountTab() {
  const { mount, flushSync, tick } = await import("svelte");
  const { app } = await import("../lib/state.svelte.js");
  const { default: TestPilotTab } = await import("./TestPilotTab.svelte");
  const target = document.createElement("div");
  document.body.appendChild(target);
  mount(TestPilotTab, { target });
  await sleep(50);
  app.testPilot.catalog = catalog();
  app.testPilot.error = null;
  flushSync(); await tick();
  const settle = async () => { flushSync(); await tick(); };
  const openExport = async () => {
    target.querySelector<HTMLButtonElement>('button[aria-label="Export catalog"]')!.click();
    await settle();
  };
  const fmtBtn = (label: string, block: string) => {
    const group = target.querySelector('[aria-label="Export options"]')!;
    const blk = [...group.querySelectorAll("div")].find((d) => d.firstElementChild?.textContent?.trim() === block)!;
    return [...blk.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.trim() === label)!;
  };
  const note = () => target.querySelector<HTMLElement>("[data-pinta-step-prep-note]");
  const progress = () => target.querySelector<HTMLElement>("[data-pinta-step-prep]");
  const row = (id: string) => {
    for (const s of app.testPilot.catalog!.sections) for (const t of s.tests) if (t.id === id) return t;
    throw new Error(id);
  };
  /** Play the agent: land steps for the pending row and clear its slot. */
  const answer = (id: string) => {
    row(id).detail = { steps: [`step for ${id}`, "verify it"], askedAt: Date.now() };
    app.cancelDetailFetch(id);
  };
  return { app, target, settle, openExport, fmtBtn, note, progress, row, answer };
}

/** Module-scoped prep state persists across tests in this file; make
 *  sure no prep from a previous case is still queued. */
async function drain(app: any) {
  for (let i = 0; i < 40 && Object.keys(app.testPilot.pendingDetails).length; i++) {
    for (const id of Object.keys(app.testPilot.pendingDetails)) app.cancelDetailFetch(id);
    await sleep(60);
  }
  await sleep(120);
}

describe("Tester sheet export — auto-generate missing steps", () => {
  beforeEach(async () => {
    createObjectURL.mockClear();
    document.body.innerHTML = "";
    const { app } = await import("../lib/state.svelte.js");
    await drain(app);
  });

  it("standalone: holds the download, explains, and offers download anyway", async () => {
    const t = await mountTab();
    t.app.connectionStatus = "disconnected";
    await t.openExport();
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(20); await t.settle();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(t.note()?.textContent).toMatch(/2 tests have no steps yet/);
    expect(t.note()?.textContent).toMatch(/no companion/);
    // The note sits under the Tester sheet block, not the Email block.
    expect(t.note()!.closest("div.px-3")!.textContent).toContain("Tester sheet");

    // Escape hatch — the sheet still downloads, with the placeholder rows.
    const md = vi.spyOn(t.app, "exportTesterSheetMarkdown");
    md.mockClear(); // spyOn returns the shared spy across tests
    [...t.note()!.querySelectorAll("button")].find((b) => b.textContent === "download anyway")!.click();
    await sleep(20); await t.settle();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(md.mock.results.at(-1)!.value).toContain("no steps generated yet");
    expect(t.note()).toBeNull();
  }, 30000);

  it("connected: generates steps row by row, shows progress, then downloads a complete sheet", async () => {
    const t = await mountTab();
    const send = vi.fn();
    (t.app as any).client = { send };
    t.app.connectionStatus = "connected";
    const md = vi.spyOn(t.app, "exportTesterSheetMarkdown");
    md.mockClear();
    await t.openExport();
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(80); await t.settle();

    // Only the rows without steps are asked, one at a time, in catalog order.
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![0].queryComment).testId).toBe("AUTH-02");
    expect(t.app.testPilot.pendingDetails["AUTH-02"]).toBeTruthy();
    expect(t.app.testPilot.pendingDetails["BILL-01"]).toBeUndefined();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(t.progress()?.textContent).toMatch(/Generating steps 1 of 2/);
    // Buttons lock while the prep runs.
    expect(t.fmtBtn(".md", "Tester sheet").disabled).toBe(true);
    expect(t.fmtBtn(".docx", "Tester sheet").disabled).toBe(true);

    t.answer("AUTH-02");
    await sleep(120); await t.settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1]![0].queryComment).testId).toBe("BILL-01");
    expect(t.progress()?.textContent).toMatch(/Generating steps 2 of 2/);
    expect(createObjectURL).not.toHaveBeenCalled();

    t.answer("BILL-01");
    await sleep(120); await t.settle();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const out = md.mock.results.at(-1)!.value as string;
    expect(out).not.toContain("no steps generated yet");
    expect(out).toContain("1. step for AUTH-02");
    expect(out).toContain("1. step for BILL-01");
    expect(out).toContain("1. Open /claims/1");
    expect(t.progress()).toBeNull();
    expect(t.note()).toBeNull();
  }, 30000);

  it("connected: Cancel stops after the in-flight row and offers download anyway", async () => {
    const t = await mountTab();
    const send = vi.fn();
    (t.app as any).client = { send };
    t.app.connectionStatus = "connected";
    await t.openExport();
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(80); await t.settle();
    expect(send).toHaveBeenCalledTimes(1);

    [...t.progress()!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    await t.settle();
    expect(t.progress()?.textContent).toMatch(/Stopping after the current test/);
    // The in-flight ask still lands (its tokens are already spent)…
    t.answer("AUTH-02");
    await sleep(120); await t.settle();
    // …but nothing further is asked and no file is written.
    expect(send).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(t.note()?.textContent).toMatch(/Stopped — 1 test still has no steps/);
    expect(t.row("AUTH-02").detail?.steps[0]).toBe("step for AUTH-02");
  }, 30000);

  it("connected: an agent error halts the prep and holds the download", async () => {
    const t = await mountTab();
    const send = vi.fn();
    (t.app as any).client = { send };
    t.app.connectionStatus = "connected";
    await t.openExport();
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(80); await t.settle();

    // Agent failed on the first row.
    t.app.testPilot.error = "Test Pilot query failed for AUTH-02.";
    t.app.cancelDetailFetch("AUTH-02");
    await sleep(120); await t.settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(t.note()?.textContent).toMatch(/2 tests still have no steps/);
    expect(t.note()?.textContent).toMatch(/errored or timed out/);
  }, 30000);

  it("email: generates first, then downloads and opens the draft via the tabs API", async () => {
    const t = await mountTab();
    const send = vi.fn();
    (t.app as any).client = { send };
    t.app.connectionStatus = "connected";
    const tabsCreate = (globalThis as any).chrome.tabs.create as ReturnType<typeof vi.fn>;
    tabsCreate.mockClear();
    await t.openExport();
    t.app.testerInfo.recipient = "jeremy@example.com";
    await t.settle();
    const gmail = [...t.target.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.includes("Open Gmail draft"))!;
    expect(gmail.disabled).toBe(false);
    gmail.click();
    await sleep(80); await t.settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(tabsCreate).not.toHaveBeenCalled();
    // Progress lands under the Email block for an email-initiated prep.
    expect(t.progress()!.closest("div.px-3")!.textContent).toContain("Email");

    t.answer("AUTH-02");
    await sleep(120); await t.settle();
    t.answer("BILL-01");
    await sleep(120); await t.settle();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(tabsCreate).toHaveBeenCalledTimes(1);
    expect(tabsCreate.mock.calls[0]![0].url).toMatch(/^https:\/\/mail\.google\.com\/mail\/\?view=cm/);
    expect(tabsCreate.mock.calls[0]![0].url).toContain("to=jeremy%40example.com");
  }, 30000);

  it("skips the prep entirely when every scoped row already has steps", async () => {
    const t = await mountTab();
    t.app.connectionStatus = "disconnected";
    for (const s of t.app.testPilot.catalog!.sections) for (const r of s.tests) r.detail = { steps: ["go", "check"], askedAt: 1 };
    await t.openExport();
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(20); await t.settle();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(t.note()).toBeNull();
  }, 30000);

  it("locks the Email buttons (with an on-page reason) while a .md prep runs, and spins the Export trigger", async () => {
    const t = await mountTab();
    const send = vi.fn();
    (t.app as any).client = { send };
    t.app.connectionStatus = "connected";
    await t.openExport();
    t.app.testerInfo.recipient = "jeremy@example.com";
    await t.settle();
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(80); await t.settle();
    const gmail = [...t.target.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.includes("Open Gmail draft"))!;
    const mailto = [...t.target.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.includes("default mail app"))!;
    expect(gmail.disabled).toBe(true);
    expect(mailto.disabled).toBe(true);
    expect(t.target.textContent).toContain("Waiting for the tester-sheet steps to finish generating");
    const trigger = t.target.querySelector<HTMLButtonElement>('button[aria-label="Export catalog"]')!;
    expect(trigger.querySelector("svg.animate-spin")).not.toBeNull();
    expect(trigger.title).toMatch(/Generating tester-sheet steps \(1 of 2\)/);

    t.answer("AUTH-02"); await sleep(120); await t.settle();
    t.answer("BILL-01"); await sleep(120); await t.settle();
    expect(gmail.disabled).toBe(false);
    expect(trigger.querySelector("svg.animate-spin")).toBeNull();
  }, 30000);

  it("keeps the outcome note when the popover is closed and reopened, and Retry asks again", async () => {
    const t = await mountTab();
    const send = vi.fn();
    (t.app as any).client = { send };
    t.app.connectionStatus = "connected";
    await t.openExport();
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(80); await t.settle();
    t.app.testPilot.error = "Test Pilot query failed for AUTH-02.";
    t.app.cancelDetailFetch("AUTH-02");
    await sleep(120); await t.settle();
    expect(t.note()).not.toBeNull();
    // Close (outside click) and reopen — the note must survive.
    document.body.click();
    await t.settle();
    expect(t.target.querySelector('[aria-label="Export options"]')).toBeNull();
    await t.openExport();
    expect(t.note()?.textContent).toMatch(/2 tests still have no steps/);
    // Retry re-asks for what is still missing (not a forced download).
    [...t.note()!.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click();
    await sleep(80); await t.settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1]![0].queryComment).testId).toBe("AUTH-02");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(t.progress()?.textContent).toMatch(/Generating steps 1 of 2/);
  }, 30000);
  it("re-asks a row whose cached detail has zero steps (the sheet would still show the placeholder)", async () => {
    const t = await mountTab();
    const send = vi.fn();
    (t.app as any).client = { send };
    t.app.connectionStatus = "connected";
    t.row("AUTH-02").detail = { steps: [], askedAt: 1 };
    t.row("BILL-01").detail = { steps: ["ok"], askedAt: 1 };
    await t.openExport();
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(80); await t.settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![0].queryComment).testId).toBe("AUTH-02");
    expect(t.progress()?.textContent).toMatch(/Generating steps 1 of 1/);
    t.answer("AUTH-02"); await sleep(120); await t.settle();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  }, 30000);

  it("clearing the catalog mid-prep stops the loop and writes nothing", async () => {
    const t = await mountTab();
    const send = vi.fn();
    (t.app as any).client = { send };
    t.app.connectionStatus = "connected";
    const md = vi.spyOn(t.app, "exportTesterSheetMarkdown");
    md.mockClear();
    await t.openExport();
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(80); await t.settle();
    expect(send).toHaveBeenCalledTimes(1);
    t.app.clearTestPilot();
    await sleep(150); await t.settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(md).not.toHaveBeenCalled();
    expect(t.app.testPilot.pendingDetails).toEqual({});
  }, 30000);

  it("Stop now drops the in-flight ask and unlocks the popover immediately", async () => {
    const t = await mountTab();
    const send = vi.fn();
    (t.app as any).client = { send };
    t.app.connectionStatus = "connected";
    await t.openExport();
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(80); await t.settle();
    [...t.progress()!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    await t.settle();
    const stopNow = [...t.progress()!.querySelectorAll("button")].find((b) => b.textContent === "Stop now");
    expect(stopNow).toBeTruthy();
    stopNow!.click();
    await sleep(120); await t.settle();
    expect(t.app.testPilot.pendingDetails["AUTH-02"]).toBeUndefined();
    expect(t.progress()).toBeNull();
    expect(t.note()?.textContent).toMatch(/Stopped — 2 tests still have no steps/);
    expect(t.fmtBtn(".md", "Tester sheet").disabled).toBe(false);
    expect(createObjectURL).not.toHaveBeenCalled();
  }, 30000);

  it("survives a tab switch: a remounted tab shows the live prep and cannot start a second one", async () => {
    const { unmount, mount, flushSync, tick } = await import("svelte");
    const { app } = await import("../lib/state.svelte.js");
    const { default: TestPilotTab } = await import("./TestPilotTab.svelte");
    const t = await mountTab();
    const send = vi.fn();
    (t.app as any).client = { send };
    t.app.connectionStatus = "connected";
    await t.openExport();
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(80); await t.settle();
    expect(send).toHaveBeenCalledTimes(1);

    // User switches to Annotate and back — App.svelte unmounts/remounts.
    document.body.innerHTML = "";
    const target2 = document.createElement("div");
    document.body.appendChild(target2);
    const inst = mount(TestPilotTab, { target: target2 });
    flushSync(); await tick();
    target2.querySelector<HTMLButtonElement>('button[aria-label="Export catalog"]')!.click();
    flushSync(); await tick();
    const progress = target2.querySelector("[data-pinta-step-prep]");
    expect(progress?.textContent).toMatch(/Generating steps 1 of 2/);
    const group = target2.querySelector('[aria-label="Export options"]')!;
    const blk = [...group.querySelectorAll("div")].find((d) => d.firstElementChild?.textContent?.trim() === "Tester sheet")!;
    const mdBtn = [...blk.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.trim() === ".md")!;
    expect(mdBtn.disabled).toBe(true);
    mdBtn.click();
    await sleep(60);
    expect(send).toHaveBeenCalledTimes(1);

    // Finish the prep — exactly one sheet downloads.
    t.answer("AUTH-02"); await sleep(120); flushSync(); await tick();
    t.answer("BILL-01"); await sleep(120); flushSync(); await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(target2.querySelector("[data-pinta-step-prep]")).toBeNull();
    unmount(inst);
    void app;
  }, 30000);
  it("unticking 'Generate missing steps first' exports the sheet as-is and is remembered", async () => {
    const t = await mountTab();
    const send = vi.fn();
    (t.app as any).client = { send };
    t.app.connectionStatus = "connected";
    t.app.testerInfo.generateSteps = true;
    const md = vi.spyOn(t.app, "exportTesterSheetMarkdown");
    md.mockClear();
    await t.openExport();
    const box = t.target.querySelector<HTMLInputElement>("[data-pinta-generate-steps]")!;
    expect(box.checked).toBe(true);
    expect(box.closest("label")!.textContent).toMatch(/2 tests have none/);
    box.click();
    await t.settle();
    expect(t.app.testerInfo.generateSteps).toBe(false);
    expect((globalThis as any).chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ "pinta-tester-info": expect.objectContaining({ generateSteps: false }) }),
    );
    t.fmtBtn(".md", "Tester sheet").click();
    await sleep(40); await t.settle();
    expect(send).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(md.mock.results.at(-1)!.value).toContain("no steps generated yet");
    expect(t.progress()).toBeNull();
    expect(t.note()).toBeNull();
    t.app.testerInfo.generateSteps = true;
  }, 30000);

  it("email (Gmail): the download click leaves the popover open so the confirmation is seen", async () => {
    const t = await mountTab();
    t.app.connectionStatus = "disconnected";
    // Every row has steps — no prep, the download + draft fire straight away.
    for (const s of t.app.testPilot.catalog!.sections) for (const r of s.tests) r.detail = { steps: ["go", "check"], askedAt: 1 };
    const tabsCreate = (globalThis as any).chrome.tabs.create as ReturnType<typeof vi.fn>;
    tabsCreate.mockClear();
    await t.openExport();
    t.app.testerInfo.recipient = "jeremy@example.com";
    await t.settle();
    [...t.target.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.includes("Open Gmail draft"))!.click();
    await sleep(80); await t.settle();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(tabsCreate).toHaveBeenCalledTimes(1);
    // The synthetic <a download> click used to count as an outside click
    // and close the popover before the confirmation could render.
    expect(t.target.querySelector('[aria-label="Export options"]')).not.toBeNull();
    expect(t.target.textContent).toContain("attach it to the draft that just opened");
  }, 30000);

  it("email (mailto): keeps the popover open and 'Open the draft again' re-opens the same draft", async () => {
    const t = await mountTab();
    t.app.connectionStatus = "disconnected";
    for (const s of t.app.testPilot.catalog!.sections) for (const r of s.tests) r.detail = { steps: ["go", "check"], askedAt: 1 };
    const open = vi.spyOn(window, "open").mockImplementation((() => ({ opener: {} })) as any);
    try {
      await t.openExport();
      t.app.testerInfo.recipient = "jeremy@example.com";
      await t.settle();
      [...t.target.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.includes("default mail app"))!.click();
      await sleep(80); await t.settle();
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]![0]).toMatch(/^mailto:jeremy%40example\.com\?subject=/);
      // No "noopener" feature — that form returns null by spec.
      expect(open.mock.calls[0]!.slice(1)).toEqual(["_blank"]);
      expect(t.target.querySelector('[aria-label="Export options"]')).not.toBeNull();
      expect(t.target.textContent).toContain("attach it if your mail app opened a draft");
      const again = [...t.target.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.trim() === "Open the draft again");
      expect(again).toBeTruthy();
      again!.click();
      await sleep(20); await t.settle();
      expect(open).toHaveBeenCalledTimes(2);
      expect(open.mock.calls[1]![0]).toBe(open.mock.calls[0]![0]);
    } finally {
      open.mockRestore();
    }
  }, 30000);
});
