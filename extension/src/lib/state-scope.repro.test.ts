// Phase 21 — "Work on" scope + saved plans. The getters live on the
// state class, so this runs under vitest.repro.config.ts (state.svelte.ts
// needs the Svelte compiler for its runes):
//   npx vitest run --config vitest.repro.config.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestPilotCatalog, TestPilotStatus } from "./state.svelte.js";

/** chrome.storage.local stub — same shape as state-tester-info.repro.ts. */
function setChrome() {
  const store: Record<string, unknown> = {};
  const set = vi.fn(async (obj: any) => {
    Object.assign(store, obj);
  });
  const remove = vi.fn(async (k: string) => {
    delete store[k];
  });
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (k: any) =>
          typeof k === "string" && k in store ? { [k]: store[k] } : {},
        ),
        set,
        remove,
      },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(),
      getManifest: () => ({ version: "0.9.0" }),
    },
    tabs: { query: vi.fn(async () => []) },
  };
  return { store, set, remove };
}

/** Fresh ExtensionState per test — `app` is a module singleton. */
async function freshApp() {
  vi.resetModules();
  const { app } = await import("./state.svelte.js");
  return app;
}

type Row = {
  id: string;
  status?: TestPilotStatus;
  firstSeenRev?: number;
  lastChangedRev?: number;
};

function catalogOf(sections: Record<string, Row[]>): TestPilotCatalog {
  return {
    docId: "doc-1",
    filename: "uat.md",
    importedAt: 0,
    rev: 3,
    sections: Object.entries(sections).map(([title, rows]) => ({
      title,
      tests: rows.map((r) => ({
        id: r.id,
        test: `does ${r.id}`,
        expected: "ok",
        status: r.status ?? ("untested" as TestPilotStatus),
        ...(r.firstSeenRev !== undefined
          ? { firstSeenRev: r.firstSeenRev }
          : {}),
        ...(r.lastChangedRev !== undefined
          ? { lastChangedRev: r.lastChangedRev }
          : {}),
      })),
    })),
  };
}

/** A three-revision catalog across two sections. */
const SAMPLE = () =>
  catalogOf({
    "1.1 Auth": [
      // Untouched since v1.
      { id: "AUTH-01", status: "pass", firstSeenRev: 1, lastChangedRev: 1 },
      // Reworded in v3.
      { id: "AUTH-02", status: "fail", firstSeenRev: 1, lastChangedRev: 3 },
    ],
    "1.2 Billing": [
      // Added in v2.
      { id: "BILL-01", status: "untested", firstSeenRev: 2, lastChangedRev: 2 },
      // Added in v3.
      { id: "BILL-02", status: "fail", firstSeenRev: 3, lastChangedRev: 3 },
      // Pre-versioning row — no stamps at all, reads as revision 1.
      { id: "BILL-03", status: "untested" },
    ],
  });

describe("scopedTestIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChrome();
  });

  it("returns null for the 'all' scope (no filtering at all)", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    expect(app.testPilot.scope).toEqual({ kind: "all" });
    expect(app.scopedTestIds).toBeNull();
  });

  it("returns null when no catalog is loaded, whatever the scope", async () => {
    const app = await freshApp();
    app.setTestPilotScope({ kind: "failed" });
    expect(app.scopedTestIds).toBeNull();
  });

  it("'since' selects only rows changed strictly after the base rev", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "since", rev: 2 });
    expect([...app.scopedTestIds!].sort()).toEqual(["AUTH-02", "BILL-02"]);
  });

  it("'since v1' also picks up the rows added in v2", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "since", rev: 1 });
    expect([...app.scopedTestIds!].sort()).toEqual([
      "AUTH-02",
      "BILL-01",
      "BILL-02",
    ]);
  });

  it("'since' treats an unstamped, pre-versioning row as revision 1", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "since", rev: 0 });
    // BILL-03 has no stamps; rev 1 > 0 so it rides along.
    expect(app.scopedTestIds!.has("BILL-03")).toBe(true);
    app.setTestPilotScope({ kind: "since", rev: 1 });
    expect(app.scopedTestIds!.has("BILL-03")).toBe(false);
  });

  it("'since' at or above the current rev selects nothing", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "since", rev: 3 });
    expect(app.scopedTestIds!.size).toBe(0);
  });

  it("'since' falls back to firstSeenRev when lastChangedRev is absent", async () => {
    const app = await freshApp();
    app.testPilot.catalog = catalogOf({
      S: [{ id: "A-1", firstSeenRev: 4 }],
    });
    app.setTestPilotScope({ kind: "since", rev: 3 });
    expect([...app.scopedTestIds!]).toEqual(["A-1"]);
  });

  it("'failed' selects only the fail rows", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "failed" });
    expect([...app.scopedTestIds!].sort()).toEqual(["AUTH-02", "BILL-02"]);
  });

  it("'untested' selects only the untested rows — not the failures", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "untested" });
    expect([...app.scopedTestIds!].sort()).toEqual(["BILL-01", "BILL-03"]);
  });

  it("an empty scope is an empty Set, not null — the UI must show zero rows", async () => {
    const app = await freshApp();
    app.testPilot.catalog = catalogOf({ S: [{ id: "A-1", status: "pass" }] });
    app.setTestPilotScope({ kind: "failed" });
    expect(app.scopedTestIds).toBeInstanceOf(Set);
    expect(app.scopedTestIds!.size).toBe(0);
  });

  it("a plan scope selects exactly the plan's ids", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.testPilot.plans = [
      { id: "p1", name: "Sprint 12", testIds: ["AUTH-01", "BILL-02"], createdAt: 0 },
    ];
    app.setTestPilotScope({ kind: "plan", id: "p1" });
    expect([...app.scopedTestIds!].sort()).toEqual(["AUTH-01", "BILL-02"]);
  });

  it("a plan whose id vanished falls back to showing everything", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "plan", id: "gone" });
    expect(app.scopedTestIds).toBeNull();
    expect(app.scopeMissingIds).toEqual([]);
  });
});

describe("scopeMissingIds — a plan whose rows partly vanished", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChrome();
  });

  it("names only the plan ids the catalog no longer has", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.testPilot.plans = [
      {
        id: "p1",
        name: "Sprint 12",
        testIds: ["AUTH-01", "GONE-01", "BILL-02", "GONE-02"],
        createdAt: 0,
      },
    ];
    app.setTestPilotScope({ kind: "plan", id: "p1" });
    expect(app.scopeMissingIds).toEqual(["GONE-01", "GONE-02"]);
    // scopedTestIds is the raw plan membership — dead ids included. It
    // is only ever used as a filter, so they cost nothing…
    expect([...app.scopedTestIds!].sort()).toEqual([
      "AUTH-01",
      "BILL-02",
      "GONE-01",
      "GONE-02",
    ]);
    // …and the view only renders the survivors.
    const view = app.scopedCatalogView()!;
    expect(view.sections.flatMap((s) => s.tests.map((t) => t.id))).toEqual([
      "AUTH-01",
      "BILL-02",
    ]);
  });

  it("is empty for every non-plan scope", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    for (const scope of [
      { kind: "all" } as const,
      { kind: "failed" } as const,
      { kind: "untested" } as const,
      { kind: "since", rev: 1 } as const,
    ]) {
      app.setTestPilotScope(scope);
      expect(app.scopeMissingIds).toEqual([]);
    }
  });

  it("reports every id when the whole plan went away", async () => {
    const app = await freshApp();
    app.testPilot.catalog = catalogOf({ S: [{ id: "KEEP-1" }] });
    app.testPilot.plans = [
      { id: "p1", name: "Old", testIds: ["A", "B"], createdAt: 0 },
    ];
    app.setTestPilotScope({ kind: "plan", id: "p1" });
    expect(app.scopeMissingIds).toEqual(["A", "B"]);
    expect(app.scopedCatalogView()!.sections).toEqual([]);
  });
});

describe("scopedCatalogView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChrome();
  });

  it("hands back the very same object for the 'all' scope", async () => {
    const app = await freshApp();
    const catalog = SAMPLE();
    app.testPilot.catalog = catalog;
    expect(app.scopedCatalogView()).toBe(app.testPilot.catalog);
  });

  it("returns null when nothing is loaded", async () => {
    const app = await freshApp();
    expect(app.scopedCatalogView()).toBeNull();
  });

  it("drops sections left empty by the filter", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "untested" });
    const view = app.scopedCatalogView()!;
    // 1.1 Auth has no untested rows, so the whole section disappears.
    expect(view.sections.map((s) => s.title)).toEqual(["1.2 Billing"]);
    expect(view.sections[0]!.tests.map((t) => t.id)).toEqual([
      "BILL-01",
      "BILL-03",
    ]);
  });

  it("never mutates the stored catalog", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    const before = JSON.parse(JSON.stringify(app.testPilot.catalog));
    app.setTestPilotScope({ kind: "failed" });
    const view = app.scopedCatalogView()!;
    expect(view.sections).toHaveLength(2);
    // Mutating the view must not reach back into the stored catalog.
    view.sections[0]!.tests.pop();
    view.sections.pop();
    expect(JSON.parse(JSON.stringify(app.testPilot.catalog))).toEqual(before);
    expect(app.testPilot.catalog!.sections).toHaveLength(2);
    expect(app.testPilot.catalog!.sections[1]!.tests).toHaveLength(3);
  });

  it("keeps docId, title and rev so a scoped export still round-trips", async () => {
    const app = await freshApp();
    app.testPilot.catalog = { ...SAMPLE(), title: "MrsM UAT" };
    app.setTestPilotScope({ kind: "failed" });
    const view = app.scopedCatalogView()!;
    expect(view.docId).toBe("doc-1");
    expect(view.title).toBe("MrsM UAT");
    expect(view.rev).toBe(3);
  });

  it("an all-empty filter yields a catalog with zero sections, not null", async () => {
    const app = await freshApp();
    app.testPilot.catalog = catalogOf({ S: [{ id: "A-1", status: "pass" }] });
    app.setTestPilotScope({ kind: "failed" });
    const view = app.scopedCatalogView()!;
    expect(view).not.toBeNull();
    expect(view.sections).toEqual([]);
  });
});

describe("saveCurrentScopeAsPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChrome();
  });

  it("saves just the scoped ids and switches the scope to the new plan", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "failed" });
    const plan = app.saveCurrentScopeAsPlan("  Sprint 12  ")!;
    expect(plan).not.toBeNull();
    expect(plan.name).toBe("Sprint 12");
    expect(plan.testIds).toEqual(["AUTH-02", "BILL-02"]);
    expect(app.testPilot.plans).toEqual([plan]);
    expect(app.testPilot.scope).toEqual({ kind: "plan", id: plan.id });
    // …and the new scope reproduces the same selection.
    expect([...app.scopedTestIds!].sort()).toEqual(["AUTH-02", "BILL-02"]);
  });

  it("saves ids in catalog order, not scope-iteration order", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    const plan = app.saveCurrentScopeAsPlan("Everything")!;
    expect(plan.testIds).toEqual([
      "AUTH-01",
      "AUTH-02",
      "BILL-01",
      "BILL-02",
      "BILL-03",
    ]);
  });

  it("refuses a blank name, a missing catalog and an empty selection", async () => {
    const app = await freshApp();
    expect(app.saveCurrentScopeAsPlan("no catalog")).toBeNull();
    app.testPilot.catalog = catalogOf({ S: [{ id: "A-1", status: "pass" }] });
    expect(app.saveCurrentScopeAsPlan("   ")).toBeNull();
    app.setTestPilotScope({ kind: "failed" });
    expect(app.saveCurrentScopeAsPlan("no failures")).toBeNull();
    expect(app.testPilot.plans).toEqual([]);
  });

  it("refuses a duplicate name (case-insensitively) and says why", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    expect(app.saveCurrentScopeAsPlan("Sprint 12")).not.toBeNull();
    app.testPilot.error = null;
    expect(app.saveCurrentScopeAsPlan("  sprint 12 ")).toBeNull();
    expect(app.testPilot.error).toMatch(/already exists/);
    expect(app.testPilot.plans).toHaveLength(1);
  });

  it("caps the plan name at 60 characters", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    const plan = app.saveCurrentScopeAsPlan("x".repeat(80))!;
    expect(plan.name).toHaveLength(60);
  });

  it("persists a structured-cloneable snapshot, not a Svelte proxy", async () => {
    const { set } = setChrome();
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    const plan = app.saveCurrentScopeAsPlan("Sprint 12")!;
    // saveTestPlans() is fire-and-forget; let the microtask land.
    await Promise.resolve();
    const call = set.mock.calls.find(([obj]: [any]) =>
      Object.keys(obj).some((k) => k.endsWith(":plans")),
    );
    expect(call).toBeTruthy();
    const stored = Object.values(call![0] as Record<string, unknown>)[0];
    expect(JSON.parse(JSON.stringify(stored))).toEqual([
      { id: plan.id, name: "Sprint 12", testIds: plan.testIds, createdAt: plan.createdAt },
    ]);
  });

  it("a second plan is appended, not replaced", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    const a = app.saveCurrentScopeAsPlan("All")!;
    app.setTestPilotScope({ kind: "failed" });
    const b = app.saveCurrentScopeAsPlan("Failures")!;
    expect(app.testPilot.plans.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(a.id).not.toBe(b.id);
  });
});

describe("deleteTestPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChrome();
  });

  it("removes the plan and resets an active scope back to 'all'", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    const plan = app.saveCurrentScopeAsPlan("Sprint 12")!;
    app.deleteTestPlan(plan.id);
    expect(app.testPilot.plans).toEqual([]);
    expect(app.testPilot.scope).toEqual({ kind: "all" });
    expect(app.scopedTestIds).toBeNull();
  });

  it("leaves a different active scope alone", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    const keep = app.saveCurrentScopeAsPlan("Keep")!;
    app.setTestPilotScope({ kind: "failed" });
    const doomed = app.saveCurrentScopeAsPlan("Doomed")!;
    app.setTestPilotScope({ kind: "plan", id: keep.id });
    app.deleteTestPlan(doomed.id);
    expect(app.testPilot.plans.map((p) => p.id)).toEqual([keep.id]);
    expect(app.testPilot.scope).toEqual({ kind: "plan", id: keep.id });
  });

  it("deleting an unknown id is a no-op", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    const plan = app.saveCurrentScopeAsPlan("Sprint 12")!;
    app.deleteTestPlan("nope");
    expect(app.testPilot.plans.map((p) => p.id)).toEqual([plan.id]);
    expect(app.testPilot.scope).toEqual({ kind: "plan", id: plan.id });
  });

  it("clears the stored key once the last plan is gone", async () => {
    const { remove } = setChrome();
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    const plan = app.saveCurrentScopeAsPlan("Sprint 12")!;
    app.deleteTestPlan(plan.id);
    await Promise.resolve();
    expect(
      remove.mock.calls.some(([k]: [string]) => k.endsWith(":plans")),
    ).toBe(true);
  });
});

describe("scope labels + export token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChrome();
  });

  it("maps every scope kind to a label and a frontmatter token", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "all" });
    expect([app.scopeLabel, app.scopeToken]).toEqual(["Everything", "all"]);
    app.setTestPilotScope({ kind: "since", rev: 2 });
    expect([app.scopeLabel, app.scopeToken]).toEqual([
      "New in v3",
      "since-v2",
    ]);
    app.setTestPilotScope({ kind: "failed" });
    expect([app.scopeLabel, app.scopeToken]).toEqual([
      "Failed last run",
      "failed",
    ]);
    app.setTestPilotScope({ kind: "untested" });
    expect([app.scopeLabel, app.scopeToken]).toEqual([
      "Untested when picked",
      "untested",
    ]);
    const plan = app.saveCurrentScopeAsPlan("Sprint 12");
    expect([app.scopeLabel, app.scopeToken]).toEqual([
      "Sprint 12",
      "plan:Sprint 12",
    ]);
    expect(plan).not.toBeNull();
  });

  it("a deleted plan labels as 'Everything', matching its no-op filter", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "plan", id: "gone" });
    expect(app.scopedTestIds).toBeNull();
    expect(app.scopeLabel).toBe("Everything");
    // Known wart: the token still says "plan:" even though nothing is
    // being filtered, so the export frontmatter claims a partial sheet.
    expect(app.scopeToken).toBe("plan:Everything");
  });
});

describe("standalone claim keeps the tester's plans + scope (loadTestPilot)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The claim pushes the catalog to the companion; there is none here.
    (globalThis as any).fetch = vi.fn(async () => {
      throw new Error("offline");
    });
  });

  it("moves the standalone :plans / :scope sidecars with the catalog and keeps them in memory", async () => {
    const { store } = setChrome();
    const app = await freshApp();
    const STANDALONE = "pinta-test-pilot:standalone";
    const plan = { id: "p1", name: "Sprint 12", testIds: ["AUTH-01", "BILL-02"], createdAt: 1 };
    store[STANDALONE] = JSON.parse(JSON.stringify(SAMPLE()));
    store[`${STANDALONE}:plans`] = [plan];
    store[`${STANDALONE}:scope`] = { kind: "plan", id: "p1" };

    // First connect to a project whose slot is empty → claim.
    const companion = { port: 7878, projectRoot: "/proj", urlPatterns: [] };
    app.selectedCompanion = companion;
    await app.loadTestPilot(companion);

    const KEY = "pinta-test-pilot:/proj";
    // Sidecars moved under the project key…
    expect(store[`${KEY}:plans`]).toEqual([plan]);
    expect(store[`${KEY}:scope`]).toEqual({ kind: "plan", id: "p1" });
    expect(store[`${STANDALONE}:plans`]).toBeUndefined();
    expect(store[`${STANDALONE}:scope`]).toBeUndefined();
    // …and are what the panel sees (the plans/scope load used to race
    // the claim and land on the still-empty project key).
    expect(app.testPilot.catalog?.docId).toBe("doc-1");
    expect(app.testPilot.plans).toEqual([plan]);
    expect(app.testPilot.scope).toEqual({ kind: "plan", id: "p1" });
    expect([...app.scopedTestIds!].sort()).toEqual(["AUTH-01", "BILL-02"]);

    // A subsequent save appends to the claimed plans instead of wiping them.
    app.setTestPilotScope({ kind: "failed" });
    const second = app.saveCurrentScopeAsPlan("Failures")!;
    expect(second).not.toBeNull();
    expect(app.testPilot.scope).toEqual({ kind: "plan", id: second.id });
    await new Promise((r) => setTimeout(r, 0));
    expect((store[`${KEY}:plans`] as { id: string }[]).map((p) => p.id)).toEqual(["p1", second.id]);
    // …and the scope, once re-persisted, lands under the project key too.
    app.setTestPilotScope({ kind: "plan", id: "p1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(store[`${KEY}:scope`]).toEqual({ kind: "plan", id: "p1" });
    expect(store[`${STANDALONE}:scope`]).toBeUndefined();
  });
});

describe("status scopes are frozen at pick time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setChrome();
  });

  it("marking a failed row keeps it in the 'failed' scope", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "failed" });
    expect([...app.scopedTestIds!].sort()).toEqual(["AUTH-02", "BILL-02"]);
    // The tester fixes one and marks it pass — it must not vanish from
    // the list they are working through.
    app.testPilot.catalog!.sections[0]!.tests[1]!.status = "pass";
    expect([...app.scopedTestIds!].sort()).toEqual(["AUTH-02", "BILL-02"]);
    expect(
      app.scopedCatalogView()!.sections.flatMap((s) => s.tests.map((t) => t.id)),
    ).toEqual(["AUTH-02", "BILL-02"]);
  });

  it("a row that fails after the pick does NOT join the scope", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "untested" });
    const before = [...app.scopedTestIds!].sort();
    app.testPilot.catalog!.sections[0]!.tests[0]!.status = "untested";
    expect([...app.scopedTestIds!].sort()).toEqual(before);
  });

  it("explicit ids override the snapshot (the rehydrate path)", async () => {
    const app = await freshApp();
    app.testPilot.catalog = SAMPLE();
    app.setTestPilotScope({ kind: "failed", ids: ["AUTH-01"] });
    expect([...app.scopedTestIds!]).toEqual(["AUTH-01"]);
  });
});
