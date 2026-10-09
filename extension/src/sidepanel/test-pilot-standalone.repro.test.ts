// Test Pilot in standalone mode (no companion = no agent): everything that
// needs the agent is hidden instead of left to fail — Details + Re-ask,
// chat, section "Ask all", "Suggest tests", "File failed tests" and
// "Generate missing steps first". Opening a test never asks the agent.
//   npx vitest run --config vitest.repro.config.ts test-pilot-standalone
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
const createObjectURL = vi.fn(() => "blob:pinta");
(URL as any).createObjectURL = createObjectURL;
(URL as any).revokeObjectURL = vi.fn();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function catalog() {
  return {
    docId: "doc-1", filename: "uat.md", importedAt: 0, title: "BCP UAT",
    sections: [{
      title: "1. Common checks",
      tests: [
        { id: "C-09", test: "Pages after a period of inactivity", expected: "Taken to login", status: "untested", detail: { steps: ["Sign in and idle", "Click any menu item"], askedAt: 1 } },
        { id: "C-10", test: "Refresh on any page", expected: "Page reloads", status: "fail" },
      ],
    }],
  } as any;
}

async function mountTab(mode: "standalone" | "connected") {
  const { mount, flushSync, tick } = await import("svelte");
  const { app } = await import("../lib/state.svelte.js");
  const { default: TestPilotTab } = await import("./TestPilotTab.svelte");
  document.body.innerHTML = "";
  const target = document.createElement("div");
  document.body.appendChild(target);
  (app as any).selectedCompanion = mode === "connected" ? { port: 7878, projectRoot: "C:/p", pid: 1 } : null;
  (app as any).scanning = false;
  app.connectionStatus = mode === "connected" ? "connected" : "disconnected";
  (app as any).client = mode === "connected" ? { send: vi.fn() } : null;
  app.modules["chat"] = { enabled: true, settings: {} } as any;
  app.modules["test-pilot"] = { enabled: true, settings: {} } as any;
  app.testerInfo.generateSteps = true;
  app.testPilot.catalog = catalog();
  app.testPilot.error = null;
  mount(TestPilotTab, { target });
  await sleep(50);
  const settle = async () => { flushSync(); await tick(); };
  await settle();
  const has = (sel: string) => !!target.querySelector(sel);
  const btn = (re: RegExp) =>
    [...target.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => re.test(norm(b.textContent)) || re.test(b.getAttribute("aria-label") ?? ""),
    );
  return { app, target, settle, has, btn };
}

describe("Test Pilot — standalone hides agent-only features", () => {
  beforeEach(() => createObjectURL.mockClear());

  it("catalog view: no Ask-all, no chat, no File failed tests, no Suggest tests", async () => {
    const t = await mountTab("standalone");
    expect(t.app.appMode).toBe("standalone");
    expect(t.btn(/^Ask for steps on every test in/)).toBeUndefined();
    expect(t.btn(/^Open chat for /)).toBeUndefined();
    expect(t.btn(/^File failed tests as issues$/)).toBeUndefined();
    // Row entry stays, worded as "open", not "ask".
    const open = t.btn(/^Open C-10$/)!;
    expect(open).toBeTruthy();
    expect(open.title).toBe("Open this test");
    // Section kebab has no agent item.
    t.target.querySelector<HTMLButtonElement>("[data-pinta-kebab-trigger]")!.click();
    await t.settle();
    const menu = norm(t.target.querySelector("[data-pinta-kebab-menu]")?.textContent);
    expect(menu).toContain("Rename");
    expect(menu).not.toContain("Suggest tests");
  }, 30000);

  it("detail view: no Details / Re-ask / chat, and opening a test never asks the agent", async () => {
    const t = await mountTab("standalone");
    const fetchSteps = vi.spyOn(t.app, "fetchDetailSteps");
    fetchSteps.mockClear();
    // A test WITH steps: steps show, Pass/Fail work, no agent controls.
    t.btn(/^Open C-09$/)!.click();
    await t.settle();
    expect(norm(t.target.textContent)).toContain("Sign in and idle");
    expect(t.btn(/^Re-ask$/)).toBeUndefined();
    expect([...t.target.querySelectorAll("label")].some((l) => norm(l.textContent) === "Details")).toBe(false);
    expect(t.btn(/^Open chat with agent$/)).toBeUndefined();
    expect(t.btn(/^View chat history$/)).toBeUndefined();
    expect(t.btn(/^Pass$/)).toBeTruthy();
    t.btn(/Back to catalog/)!.click();
    await t.settle();
    // A test WITHOUT steps: honest empty copy, no agent call, no error.
    t.btn(/^Open C-10$/)!.click();
    await t.settle();
    expect(fetchSteps).not.toHaveBeenCalled();
    expect(t.app.testPilot.error).toBeNull();
    const text = norm(t.target.textContent);
    expect(text).toContain("No steps for this test.");
    expect(text).not.toContain("Re-ask");
    expect(t.btn(/^Fail$/)).toBeTruthy();
  }, 30000);

  it("export: no 'Generate missing steps first', and the tester sheet downloads as-is", async () => {
    const t = await mountTab("standalone");
    t.btn(/^Export catalog$/)!.click();
    await t.settle();
    expect(t.has("[data-pinta-generate-steps]")).toBe(false);
    const group = t.target.querySelector('[aria-label="Export options"]')!;
    expect(norm(group.textContent)).not.toMatch(/generating any missing steps/i);
    const blk = [...group.querySelectorAll("div")].find((d) => d.firstElementChild?.textContent?.trim() === "Tester sheet")!;
    const md = [...blk.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.trim() === ".md")!;
    expect(md.title).not.toMatch(/generates/);
    md.click();
    await sleep(30); await t.settle();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(t.has("[data-pinta-step-prep-note]")).toBe(false);
  }, 30000);

  it("a row with an existing chat thread keeps its chat button so the history stays readable", async () => {
    const t = await mountTab("standalone");
    t.app.testPilot.catalog!.sections[0]!.tests[0]!.chat = [{ role: "user", text: "hi", at: 1 }] as any;
    await t.settle();
    expect(t.btn(/^View chat for C-09$/)).toBeTruthy();
    expect(t.btn(/^Open chat for C-10$/)).toBeUndefined();
  }, 30000);

  it("connected: the same controls are all present", async () => {
    const t = await mountTab("connected");
    expect(t.app.appMode).toBe("connected");
    expect(t.btn(/^Ask for steps on every test in/)).toBeTruthy();
    expect(t.btn(/^Open chat for C-10$/)).toBeTruthy();
    expect(t.btn(/^File failed tests as issues$/)).toBeTruthy();
    expect(t.btn(/^Ask for steps for C-10$/)).toBeTruthy();
    t.btn(/^Open C-09$/)!.click();
    await t.settle();
    expect(t.btn(/^Re-ask$/)).toBeTruthy();
    expect(norm(t.target.textContent)).toContain("Details");
    expect(t.btn(/^Open chat with agent$/)).toBeTruthy();
  }, 30000);
  it("companion scan (appMode 'discovering') never flashes the agent controls back on", async () => {
    const t = await mountTab("standalone");
    (t.app as any).scanning = true; // rescan fires on every tab switch / navigation
    await t.settle();
    expect(t.app.appMode).toBe("discovering");
    expect(t.btn(/^Ask for steps on every test in/)).toBeUndefined();
    expect(t.btn(/^File failed tests as issues$/)).toBeUndefined();
    expect(t.btn(/^Ask for steps for C-10$/)).toBeUndefined();
    const fetchSteps = vi.spyOn(t.app, "fetchDetailSteps");
    fetchSteps.mockClear();
    t.btn(/^Open C-10$/)!.click();
    await t.settle();
    expect(fetchSteps).not.toHaveBeenCalled();
    expect(t.app.testPilot.error).toBeNull();
    (t.app as any).scanning = false;
  }, 30000);

  it("no catalog while scanning: the import state stays, no Generate button", async () => {
    const t = await mountTab("standalone");
    t.app.testPilot.catalog = null;
    (t.app as any).scanning = true;
    await t.settle();
    expect(t.btn(/^Import tester sheet$/)).toBeTruthy();
    expect(t.btn(/^Generate .* catalog$/)).toBeUndefined();
    (t.app as any).scanning = false;
  }, 30000);

  it("switching live: controls vanish when the companion goes and return when it is back", async () => {
    const t = await mountTab("connected");
    expect(t.btn(/^File failed tests as issues$/)).toBeTruthy();
    (t.app as any).selectedCompanion = null;
    await t.settle();
    expect(t.btn(/^File failed tests as issues$/)).toBeUndefined();
    expect(t.btn(/^Ask for steps on every test in/)).toBeUndefined();
    (t.app as any).selectedCompanion = { port: 7878, projectRoot: "C:/p", pid: 1 };
    await t.settle();
    expect(t.btn(/^File failed tests as issues$/)).toBeTruthy();
    expect(t.btn(/^Ask for steps on every test in/)).toBeTruthy();
  }, 30000);

  it("a history-only chat is read-only: no composer, no agent call, and Clear closes it", async () => {
    const t = await mountTab("standalone");
    const send = vi.spyOn(t.app, "sendChatMessage");
    send.mockClear();
    t.app.testPilot.catalog!.sections[0]!.tests[0]!.chat = [{ role: "user", text: "why does this fail?", at: 1 }] as any;
    await t.settle();
    t.btn(/^View chat for C-09$/)!.click();
    // ChatSheet is lazy-loaded.
    for (let i = 0; i < 100 && !t.has("[data-pinta-chat-readonly]"); i++) { await sleep(50); await t.settle(); }
    expect(t.has("[data-pinta-chat-readonly]")).toBe(true);
    const text = norm(t.target.textContent);
    expect(text).toContain("why does this fail?");
    expect(text).not.toContain("Companion disconnected");
    expect(t.target.querySelector("textarea")).toBeNull();
    expect(send).not.toHaveBeenCalled();
    t.app.clearChat("C-09");
    await t.settle();
  }, 30000);

  it("Clear marks keeps the sheet's steps in standalone (they cannot be re-asked)", async () => {
    const t = await mountTab("standalone");
    t.app.setTestStatus("C-09", "pass");
    t.app.clearTestPilotMarks();
    const row = t.app.testPilot.catalog!.sections[0]!.tests[0]!;
    expect(row.status).toBe("untested");
    expect(row.detail?.steps).toEqual(["Sign in and idle", "Click any menu item"]);
  }, 30000);

  it("connected: Clear marks still drops cached steps (they can be re-asked)", async () => {
    const t = await mountTab("connected");
    t.app.setTestStatus("C-09", "pass");
    t.app.clearTestPilotMarks();
    expect(t.app.testPilot.catalog!.sections[0]!.tests[0]!.detail).toBeUndefined();
  }, 30000);

  it("a detail cached with zero steps reads as 'no steps', not a blank list", async () => {
    const t = await mountTab("standalone");
    t.app.testPilot.catalog!.sections[0]!.tests[1]!.detail = { steps: [], askedAt: 1 };
    await t.settle();
    t.btn(/^Open C-10$/)!.click();
    await t.settle();
    const text = norm(t.target.textContent);
    expect(text).toContain("No steps for this test.");
    expect(text).not.toContain("0 total");
  }, 30000);

  it("export says how many tests go out without steps", async () => {
    const t = await mountTab("standalone");
    t.btn(/^Export catalog$/)!.click();
    await t.settle();
    expect(norm(t.target.querySelector("[data-pinta-stepless-note]")?.textContent)).toBe("1 test has no steps — exported as is.");
  }, 30000);

  it("connected: Ask for steps on a row does call the agent (the open-test gate is standalone-only)", async () => {
    const t = await mountTab("connected");
    const fetchSteps = vi.spyOn(t.app, "fetchDetailSteps").mockImplementation(async () => {});
    fetchSteps.mockClear();
    t.btn(/^Ask for steps for C-10$/)!.click();
    await t.settle();
    expect(fetchSteps).toHaveBeenCalledWith("C-10");
    // Re-ask stays reachable even with no cached steps (e.g. after Cancel).
    expect(t.btn(/^Re-ask$/)).toBeTruthy();
    fetchSteps.mockRestore();
  }, 30000);
  it("connected but the socket is down: Ask-all says the companion disconnected, not silence or 'agent errored'", async () => {
    const t = await mountTab("connected");
    t.app.connectionStatus = "disconnected"; // companion restarting
    await t.settle();
    t.btn(/^Ask for steps on every test in/)!.click();
    for (let i = 0; i < 40 && !t.app.testPilot.error; i++) { await sleep(25); await t.settle(); }
    expect(t.app.testPilot.error).toMatch(/companion disconnected before every test was asked/);
    expect(t.app.testPilot.error).not.toMatch(/agent errored/);
    t.app.testPilot.error = null;
  }, 30000);

  it("companion deselected mid Ask-all: no 'agent errored' banner lands in the standalone view", async () => {
    const t = await mountTab("connected");
    t.btn(/^Ask for steps on every test in/)!.click();
    for (let i = 0; i < 40 && !t.app.testPilot.pendingDetails["C-10"]; i++) { await sleep(25); }
    expect(t.app.testPilot.pendingDetails["C-10"]).toBeTruthy();
    // A rescan finds no companion: back to standalone, in-flight ask dropped.
    (t.app as any).selectedCompanion = null;
    t.app.connectionStatus = "disconnected";
    t.app.cancelDetailFetch("C-10");
    await sleep(200); await t.settle();
    expect(t.app.testPilot.error).toBeNull();
    expect(t.btn(/^Ask for steps on every test in/)).toBeUndefined();
  }, 30000);
  it("companion dropped mid tester-sheet prep with a fully-stepped standalone sheet: nothing is exported", async () => {
    const t = await mountTab("connected");
    t.btn(/^Export catalog$/)!.click();
    await t.settle();
    const group = t.target.querySelector('[aria-label="Export options"]')!;
    const blk = [...group.querySelectorAll("div")].find((d) => d.firstElementChild?.textContent?.trim() === "Tester sheet")!;
    [...blk.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent!.trim() === ".md")!.click();
    for (let i = 0; i < 40 && !t.app.testPilot.pendingDetails["C-10"]; i++) { await sleep(25); }
    expect(t.app.testPilot.pendingDetails["C-10"]).toBeTruthy();
    // The companion goes away and the standalone slot's sheet (every row
    // has steps) becomes the loaded catalog.
    const other = catalog();
    other.docId = "doc-S";
    other.sections[0].tests[1].detail = { steps: ["x"], askedAt: 1 };
    (t.app as any).selectedCompanion = null;
    t.app.connectionStatus = "disconnected";
    t.app.testPilot.catalog = other;
    t.app.cancelDetailFetch("C-10");
    await sleep(250); await t.settle();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(t.app.testPilot.error).toBeNull();
    expect(t.has("[data-pinta-step-prep]")).toBe(false);
  }, 30000);

  it("catalog cleared mid Ask-all: no 'agent errored' banner", async () => {
    const t = await mountTab("connected");
    t.btn(/^Ask for steps on every test in/)!.click();
    for (let i = 0; i < 40 && !t.app.testPilot.pendingDetails["C-10"]; i++) { await sleep(25); }
    expect(t.app.testPilot.pendingDetails["C-10"]).toBeTruthy();
    t.app.clearTestPilot();
    await sleep(250); await t.settle();
    expect(t.app.testPilot.error).toBeNull();
  }, 30000);

  it("project switched mid Ask-all: the run stops, no banner on the new project", async () => {
    const t = await mountTab("connected");
    t.btn(/^Ask for steps on every test in/)!.click();
    for (let i = 0; i < 40 && !t.app.testPilot.pendingDetails["C-10"]; i++) { await sleep(25); }
    const send = (t.app as any).client.send as ReturnType<typeof vi.fn>;
    const sentBefore = send.mock.calls.length;
    (t.app as any).selectedCompanion = { port: 7879, projectRoot: "C:/other", pid: 2 };
    t.app.testPilot.catalog = catalog();
    t.app.cancelDetailFetch("C-10");
    await sleep(300); await t.settle();
    expect(send.mock.calls.length).toBe(sentBefore);
    expect(t.app.testPilot.error).toBeNull();
  }, 30000);
  it("a job still QUEUED when the project switches never runs against the new project", async () => {
    const t = await mountTab("connected");
    // Two sections so a second Ask-all waits in the queue behind the first.
    t.app.testPilot.catalog!.sections.push({
      title: "2. Two",
      tests: [{ id: "A-02", test: "Second section row", expected: "ok", status: "untested" }],
    } as any);
    await t.settle();
    const asks = [...t.target.querySelectorAll<HTMLButtonElement>("button")].filter((b) => /^Ask for steps on every test in/.test(b.getAttribute("aria-label") ?? ""));
    expect(asks.length).toBe(2);
    asks[0]!.click();
    asks[1]!.click();
    for (let i = 0; i < 40 && !t.app.testPilot.pendingDetails["C-10"]; i++) { await sleep(25); }
    const send = (t.app as any).client.send as ReturnType<typeof vi.fn>;
    const sentBefore = send.mock.calls.length;
    // Switch to project B (its own catalog) while job 2 is still queued.
    (t.app as any).selectedCompanion = { port: 7879, projectRoot: "C:/other", pid: 2 };
    const b = catalog();
    b.docId = "doc-B";
    t.app.testPilot.catalog = b;
    t.app.cancelDetailFetch("C-10");
    await sleep(400); await t.settle();
    expect(send.mock.calls.length).toBe(sentBefore);
    expect(t.app.testPilot.error).toBeNull();
    expect(t.app.testPilot.pendingDetails).toEqual({});
  }, 30000);
  it("a project switch during a retry backoff ends the wait at once (export unlocks, no banner)", async () => {
    const { bulkRetry } = await import("./TestPilotTab.svelte");
    const saved = { ...bulkRetry };
    bulkRetry.baseMs = 5000; // a long backoff the switch must cut short
    bulkRetry.maxMs = 5000;
    try {
      const t = await mountTab("connected");
      t.btn(/^Ask for steps on every test in/)!.click();
      for (let i = 0; i < 40 && !t.app.testPilot.pendingDetails["C-10"]; i++) { await sleep(25); }
      // The agent errors on the row → the run enters its retry backoff.
      (t.app as any).handleDetailSync({ status: "error", errorMessage: "Test Pilot query failed for C-10." }, "C-10");
      t.app.testPilot.error = null;
      await sleep(150); await t.settle();
      (t.app as any).selectedCompanion = { port: 7879, projectRoot: "C:/other", pid: 2 };
      t.app.testPilot.catalog = catalog();
      const started = Date.now();
      // The section spinner flag clears when the job leaves the queue.
      for (let i = 0; i < 60 && t.btn(/^Ask for steps on every test in/)?.disabled; i++) { await sleep(50); await t.settle(); }
      expect(Date.now() - started).toBeLessThan(2000);
      expect(t.btn(/^Ask for steps on every test in/)?.disabled).toBe(false);
      expect(t.app.testPilot.error).toBeNull();
    } finally {
      Object.assign(bulkRetry, saved);
    }
  }, 30000);
  it("switch to a still-connecting project during a retry round: no banner on the new project", async () => {
    const { bulkRetry } = await import("./TestPilotTab.svelte");
    const saved = { ...bulkRetry };
    bulkRetry.baseMs = 10;
    bulkRetry.maxMs = 20;
    bulkRetry.rounds = 3;
    try {
      const t = await mountTab("connected");
      // Two stepless rows so a retry round has a "next row" after the switch.
      t.app.testPilot.catalog!.sections[0]!.tests.push({ id: "C-11", test: "Third", expected: "ok", status: "untested" } as any);
      await t.settle();
      const failRow = (id: string) => {
        (t.app as any).handleDetailSync({ status: "error", errorMessage: `Test Pilot query failed for ${id}.` }, id);
        t.app.testPilot.error = null;
      };
      const waitPending = async (id: string) => {
        for (let i = 0; i < 80 && !t.app.testPilot.pendingDetails[id]; i++) await sleep(20);
        expect(t.app.testPilot.pendingDetails[id], `pending ${id}`).toBeTruthy();
      };
      t.btn(/^Ask for steps on every test in/)!.click();
      await waitPending("C-10"); failRow("C-10");
      await waitPending("C-11"); failRow("C-11");
      // Retry round 1 asks C-10 again — switch while it is in flight.
      await waitPending("C-10");
      (t.app as any).selectedCompanion = { port: 7879, projectRoot: "C:/other", pid: 2 };
      t.app.connectionStatus = "connecting";
      t.app.testPilot.catalog = catalog();
      t.app.cancelDetailFetch("C-10");
      await sleep(400); await t.settle();
      expect(t.app.testPilot.error).toBeNull();
      t.app.connectionStatus = "connected";
    } finally {
      Object.assign(bulkRetry, saved);
    }
  }, 30000);
  it("a pending 'Suggest tests' is dropped when the catalog is cleared or the project resets (no stuck spinner)", async () => {
    const t = await mountTab("connected");
    t.app.testPilot.pendingSectionSuggest["1. Common checks"] = { askedAt: Date.now() } as any;
    t.app.testPilot.sectionSuggestions["1. Common checks"] = [] as any;
    (t.app as any).resetTestPilotState();
    expect(t.app.testPilot.pendingSectionSuggest).toEqual({});
    expect(t.app.testPilot.sectionSuggestions).toEqual({});
    t.app.testPilot.catalog = catalog();
    t.app.testPilot.pendingSectionSuggest["1. Common checks"] = { askedAt: Date.now() } as any;
    t.app.clearTestPilot();
    expect(t.app.testPilot.pendingSectionSuggest).toEqual({});
  }, 30000);
  it("dropping the companion mid import/generate retires the 'still waiting for an agent' notice", async () => {
    const t = await mountTab("connected");
    t.app.testPilot.pending = { kind: "doc-generate", sessionId: "s1", startedAt: Date.now() } as any;
    (t.app as any).claimNotice = { sessionId: "s1", text: "Still waiting for an agent to pick this up…" };
    (t.app as any).resetTestPilotState();
    expect(t.app.testPilot.pending).toBeNull();
    expect((t.app as any).claimNotice).toBeNull();
    // A notice owned by something else is left alone when nothing was pending.
    (t.app as any).claimNotice = { sessionId: "other", text: "Still waiting…" };
    (t.app as any).resetTestPilotState();
    expect((t.app as any).claimNotice).not.toBeNull();
    (t.app as any).claimNotice = null;
  }, 30000);
});
