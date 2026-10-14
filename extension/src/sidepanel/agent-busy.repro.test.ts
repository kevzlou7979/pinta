// Report 2026-10-14: the page-edge processing pulse never showed — not
// while annotating, auditing, generating a report or generating variants.
// It followed only the live draft's status, which stopped ever being
// "pending" once sent batches began detaching into the Submitted tray,
// and module runs never touched the draft at all. `app.agentBusy` is the
// one flag the pulse follows now; every agent wait must light it.
import { describe, it, expect, vi, beforeEach } from "vitest";

(globalThis as any).chrome = {
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn() },
  },
  runtime: {
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(),
    getManifest: () => ({ version: "0.10.0" }),
  },
  tabs: {
    onActivated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    query: vi.fn(async () => []),
  },
  notifications: {},
  action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
};

const batch = (status: string) =>
  ({ id: `b-${status}`, url: "http://localhost:5173/", projectRoot: "", startedAt: 1, annotations: [], status, producer: "extension" }) as any;

describe("app.agentBusy — what the processing pulse follows", () => {
  let app: any;
  beforeEach(async () => {
    ({ app } = await import("../lib/state.svelte.js"));
    app.selectedCompanion = { port: 7878, projectRoot: "C:/proj", urlPatterns: [] };
  });

  it("is idle with nothing in flight", () => {
    expect(app.agentBusy).toBe(false);
  });

  it("is never busy with no companion selected", () => {
    // A wait with no timeout of its own must not outlive a disconnect.
    app.chat.pendingGlobal = true;
    app.inFlightBatches = [batch("submitted")];
    expect(app.agentBusy).toBe(true);
    app.selectedCompanion = null;
    expect(app.agentBusy).toBe(false);
    app.chat.pendingGlobal = false;
    app.inFlightBatches = [];
  });

  // Each entry: light one agent wait, expect busy, then put it back.
  const waits: [string, (a: any) => () => void][] = [
    ["a sent batch waiting in the Submitted tray (draft idle)", (a) => {
      a.session = batch("drafting");
      a.inFlightBatches = [batch("submitted")];
      return () => { a.inFlightBatches = []; a.session = null; };
    }],
    ["a batch the agent is applying", (a) => {
      a.inFlightBatches = [batch("done"), batch("applying")];
      return () => { a.inFlightBatches = []; };
    }],
    ["the live draft itself pending", (a) => {
      a.session = batch("applying");
      return () => { a.session = null; };
    }],
    ["an AuditFlow run", (a) => {
      a.audit.pending = { runId: "r", startedAt: 1 };
      return () => { a.audit.pending = null; };
    }],
    ["an AuditFlow per-check fix", (a) => {
      a.audit.pendingCheckFix = { c1: true };
      return () => { a.audit.pendingCheckFix = {}; };
    }],
    ["a Report run", (a) => {
      a.report.pending = { runId: "r", startedAt: 1 };
      return () => { a.report.pending = null; };
    }],
    ["a Design Variants generate", (a) => {
      a.variants.pending = { runId: "r", startedAt: 1, op: "variants-generate", sessionId: null };
      return () => { a.variants.pending = null; };
    }],
    ["a Design Variants discuss", (a) => {
      a.variants.pendingDiscuss = { v1: true };
      return () => { a.variants.pendingDiscuss = {}; };
    }],
    ["a Test Pilot doc op", (a) => {
      a.testPilot.pending = { kind: "doc-generate", startedAt: 1 };
      return () => { a.testPilot.pending = null; };
    }],
    ["a Test Pilot per-row ask", (a) => {
      a.testPilot.pendingChats = { "T-01": { askedAt: 1 } };
      return () => { a.testPilot.pendingChats = {}; };
    }],
    ["a Code Review gather", (a) => {
      a.review.pending = { runId: "r", startedAt: 1 };
      return () => { a.review.pending = null; };
    }],
    ["a Code Review per-card fix", (a) => {
      a.review.pendingFix = { c1: "sess-1" };
      return () => { a.review.pendingFix = {}; };
    }],
    ["a global chat question", (a) => {
      a.chat.pendingGlobal = true;
      return () => { a.chat.pendingGlobal = false; };
    }],
    ["a commit", (a) => {
      a.commit.pending = "commit";
      return () => { a.commit.pending = null; };
    }],
    ["a Drift Check", (a) => {
      a.drift.pending = { sessionId: null, startedAt: 1 };
      return () => { a.drift.pending = null; };
    }],
    ["an imported module's board", (a) => {
      a.moduleBoards = { "acme.tasks": { board: null, pending: { runId: "r", startedAt: 1, op: "x" }, error: null } };
      return () => { a.moduleBoards = {}; };
    }],
    ["an imported module's card steps", (a) => {
      a.moduleBoards = { "acme.tasks": { board: null, pending: null, error: null, cardStepsPending: { c1: true } } };
      return () => { a.moduleBoards = {}; };
    }],
    ["an imported module's card screenshots", (a) => {
      a.moduleBoards = { "acme.tasks": { board: null, pending: null, error: null, cardShotsPending: { c1: true } } };
      return () => { a.moduleBoards = {}; };
    }],
    ["a Report screenshot", (a) => {
      a.report.shotPending = "item-1";
      return () => { a.report.shotPending = null; };
    }],
    ["a Report how-to-test", (a) => {
      a.report.howToPending = "item-1";
      return () => { a.report.howToPending = null; };
    }],
    ["a Report day expansion", (a) => {
      a.report.expandingDate = "2026-10-14";
      return () => { a.report.expandingDate = null; };
    }],
    ["a Test Pilot test detail", (a) => {
      a.testPilot.pendingDetails = { "T-01": { askedAt: 1 } };
      return () => { a.testPilot.pendingDetails = {}; };
    }],
    ["a Test Pilot section suggest", (a) => {
      a.testPilot.pendingSectionSuggest = { "1.1": { askedAt: 1 } };
      return () => { a.testPilot.pendingSectionSuggest = {}; };
    }],
    ["a Test Pilot section chat", (a) => {
      a.testPilot.pendingSectionChats = { "1.1": { askedAt: 1 } };
      return () => { a.testPilot.pendingSectionChats = {}; };
    }],
    ["Test Pilot filing issues", (a) => {
      a.testPilot.pendingFileIssues = true;
      return () => { a.testPilot.pendingFileIssues = false; };
    }],
    ["an AuditFlow suggest", (a) => {
      a.audit.pendingAuditSuggest = { perf: true };
      return () => { a.audit.pendingAuditSuggest = {}; };
    }],
    ["an AuditFlow check chat", (a) => {
      a.audit.pendingCheckChat = { c1: true };
      return () => { a.audit.pendingCheckChat = {}; };
    }],
    ["an AuditFlow file-issue", (a) => {
      a.audit.pendingFileIssue = { c1: true };
      return () => { a.audit.pendingFileIssue = {}; };
    }],
    ["a Code Review learn", (a) => {
      a.review.pendingLearn = { c1: true };
      return () => { a.review.pendingLearn = {}; };
    }],
    ["an annotate-batch chat", (a) => {
      a.chat.pendingAnnotateBatch = { "b-1": true };
      return () => { a.chat.pendingAnnotateBatch = {}; };
    }],
    ["an imported file being sent", (a) => {
      a.importedFilePending = "imp-1";
      return () => { a.importedFilePending = null; };
    }],
  ];

  for (const [name, light] of waits) {
    it(`is busy during ${name}, idle after`, () => {
      const restore = light(app);
      expect(app.agentBusy).toBe(true);
      restore();
      expect(app.agentBusy).toBe(false);
    });
  }

  it("stays idle for finished batches and settled maps", () => {
    app.inFlightBatches = [batch("done"), batch("error")];
    app.variants.pendingDiscuss = { v1: false };
    expect(app.agentBusy).toBe(false);
    app.inFlightBatches = [];
    app.variants.pendingDiscuss = {};
  });
});
