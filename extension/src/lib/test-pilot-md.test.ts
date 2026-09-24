import { describe, expect, it } from "vitest";
import {
  composeFrontmatter,
  overlayResults,
  overlayResultsSidecar,
  overlayStatusesById,
  parseFrontmatter,
  parsePintaResultsMarkdown,
  renderSignoffBlock,
  restoreStatuses,
  snapshotStatuses,
  type TestPilotSignoff,
} from "./test-pilot-md.js";
import {
  composeTestDocMarkdown,
  composeTesterSheetMarkdown,
} from "./test-pilot-doc.js";
import type { TestPilotCatalog } from "./state.svelte.js";

function makeCatalog(input: Partial<TestPilotCatalog> = {}): TestPilotCatalog {
  return {
    docId: "doc-abc",
    filename: "uat.md",
    importedAt: 1_700_000_000_000,
    title: "MrsM UAT",
    sections: [
      {
        title: "1.1 Auth",
        tests: [
          { id: "AUTH-01", test: "Login", expected: "Dashboard", status: "pass" },
          { id: "AUTH-02", test: "Bad PIN", expected: "Error", status: "fail" },
        ],
      },
      {
        title: "1.2 Claims",
        tests: [
          { id: "CLM-01", test: "List", expected: "Rows", status: "untested" },
        ],
      },
    ],
    ...input,
  } as TestPilotCatalog;
}

const signoff: TestPilotSignoff = {
  tester: "Jess Reyes",
  email: "jess@example.com",
  date: "2026-09-23",
  environment: "UAT",
  runType: "Regression",
  notes: "Blocked on claims\nfiltering",
};

describe("composeFrontmatter / parseFrontmatter", () => {
  it("round-trips docId + full sign-off, collapsing newlines in notes", () => {
    const fm = composeFrontmatter("doc-abc", signoff);
    const { meta, body } = parseFrontmatter(fm + "# Title\n");
    expect(body).toBe("# Title\n");
    expect(meta).toMatchObject({
      "pinta-test-pilot": "1",
      "doc-id": "doc-abc",
      tester: "Jess Reyes",
      email: "jess@example.com",
      date: "2026-09-23",
      environment: "UAT",
      "run-type": "Regression",
      notes: "Blocked on claims filtering",
    });
  });

  it("emits only version + doc-id without a sign-off", () => {
    const fm = composeFrontmatter("doc-abc");
    expect(fm).toContain("doc-id: doc-abc");
    expect(fm).not.toContain("tester:");
  });

  it("tolerates CRLF line endings and a BOM", () => {
    const fm = composeFrontmatter("doc-abc", signoff).replace(/\n/g, "\r\n");
    const { meta, body } = parseFrontmatter("﻿" + fm + "# T\r\n");
    expect(meta?.["doc-id"]).toBe("doc-abc");
    expect(body).toBe("# T\r\n");
  });

  it("returns meta null for content without frontmatter", () => {
    const content = "# Plain sheet\n\n## S\n";
    const { meta, body } = parseFrontmatter(content);
    expect(meta).toBeNull();
    expect(body).toBe(content);
  });

  it("returns meta null for a --- block that isn't key: value shaped", () => {
    const content = "---\njust a divider\n---\nrest\n";
    expect(parseFrontmatter(content).meta).toBeNull();
  });
});

describe("parsePintaResultsMarkdown", () => {
  it("preserves the doc-id through a tester-sheet round trip", () => {
    const cat = makeCatalog();
    const md = composeFrontmatter(cat.docId) + composeTesterSheetMarkdown(cat);
    const parsed = parsePintaResultsMarkdown("sheet.md", md);
    expect(parsed).not.toBeNull();
    expect(parsed!.catalog.docId).toBe("doc-abc");
    expect(parsed!.signoff).toBeNull();
    // Tester sheet leaves the Result column blank → everything untested.
    for (const s of parsed!.catalog.sections) {
      for (const t of s.tests) expect(t.status).toBe("untested");
    }
  });

  it("reads marks + sign-off from a signed results file", () => {
    const cat = makeCatalog();
    const md = composeFrontmatter(cat.docId, signoff) + composeTestDocMarkdown(cat);
    const parsed = parsePintaResultsMarkdown("results.md", md);
    expect(parsed).not.toBeNull();
    expect(parsed!.signoff).toMatchObject({
      tester: "Jess Reyes",
      environment: "UAT",
      runType: "Regression",
    });
    const [auth] = parsed!.catalog.sections;
    expect(auth!.tests[0]!.status).toBe("pass");
    expect(auth!.tests[1]!.status).toBe("fail");
  });

  it("returns null without the pinta-test-pilot marker", () => {
    const md = "---\ndoc-id: x\n---\n# T\n\n## S\n| ID | Test | Expected | Result |\n|--|--|--|--|\n| A | b | c |  |\n";
    expect(parsePintaResultsMarkdown("x.md", md)).toBeNull();
  });
});

describe("overlayResults", () => {
  it("copies statuses by id and preserves the base structure", () => {
    const base = makeCatalog();
    base.sections[0]!.tests[0]!.detail = { steps: ["step"], askedAt: 1 };
    base.sections[0]!.tests[0]!.status = "untested";
    const run = makeCatalog({
      sections: [
        {
          title: "renamed section",
          tests: [
            { id: "AUTH-01", test: "Login", expected: "Dashboard", status: "fail" },
            { id: "GONE-99", test: "?", expected: "?", status: "pass" },
          ],
        },
      ],
    });
    const { applied, unknownIds } = overlayResults(base, run);
    expect(applied).toBe(1);
    expect(unknownIds).toEqual(["GONE-99"]);
    expect(base.sections[0]!.tests[0]!.status).toBe("fail");
    // Structure, steps and other rows untouched.
    expect(base.sections[0]!.title).toBe("1.1 Auth");
    expect(base.sections[0]!.tests[0]!.detail?.steps).toEqual(["step"]);
    expect(base.sections[0]!.tests[1]!.status).toBe("fail");
  });

  it("overlays untested too — the run is shown as the tester left it", () => {
    const base = makeCatalog();
    const run = makeCatalog();
    run.sections[0]!.tests[0]!.status = "untested";
    overlayResults(base, run);
    expect(base.sections[0]!.tests[0]!.status).toBe("untested");
  });
});

describe("overlayStatusesById", () => {
  it("applies a flat status map by id and reports unknown ids", () => {
    const base = makeCatalog();
    base.sections[0]!.tests[0]!.detail = { steps: ["step"], askedAt: 1 };
    const { applied, unknownIds } = overlayStatusesById(base, {
      "AUTH-01": "fail",
      "CLM-01": "pass",
      "GONE-99": "pass",
    });
    expect(applied).toBe(2);
    expect(unknownIds).toEqual(["GONE-99"]);
    expect(base.sections[0]!.tests[0]!.status).toBe("fail");
    expect(base.sections[1]!.tests[0]!.status).toBe("pass");
    // Untouched row + structure/steps preserved.
    expect(base.sections[0]!.tests[1]!.status).toBe("fail");
    expect(base.sections[0]!.tests[0]!.detail?.steps).toEqual(["step"]);
  });

  it("applies untested too — the bundle is shown as the tester left it", () => {
    const base = makeCatalog();
    overlayStatusesById(base, { "AUTH-01": "untested" });
    expect(base.sections[0]!.tests[0]!.status).toBe("untested");
  });
});

describe("snapshotStatuses / restoreStatuses", () => {
  it("round-trips the developer's own marks around an overlay", () => {
    const base = makeCatalog();
    const prior = snapshotStatuses(base);
    const run = makeCatalog();
    run.sections[0]!.tests[0]!.status = "fail";
    run.sections[1]!.tests[0]!.status = "pass";
    overlayResults(base, run);
    expect(base.sections[1]!.tests[0]!.status).toBe("pass");
    restoreStatuses(base, prior);
    expect(base.sections[0]!.tests[0]!.status).toBe("pass");
    expect(base.sections[1]!.tests[0]!.status).toBe("untested");
  });
});

// ── Tester gap tests (feat/tester-roundtrip QA pass) ──────────────────

describe("full tester round-trip: sheet → tester marks → results → overlay", () => {
  it("carries statuses back onto the developer catalog with structure intact", () => {
    const dev = makeCatalog();
    dev.sections[0]!.tests[0]!.status = "untested";
    dev.sections[0]!.tests[1]!.status = "untested";
    dev.sections[0]!.tests[0]!.detail = {
      steps: ["Open the login page.", "Enter the `PIN`."],
      askedAt: 1,
    };

    // 1. Developer exports the tester sheet (pure twin of
    //    exportTesterSheetMarkdown: envelope + sheet body).
    const sheet = composeFrontmatter(dev.docId) + composeTesterSheetMarkdown(dev);

    // 2. Standalone tester imports the sheet.
    const testerSide = parsePintaResultsMarkdown("sheet.md", sheet);
    expect(testerSide).not.toBeNull();
    const run = testerSide!.catalog;
    expect(run.docId).toBe(dev.docId);
    expect(run.sections.map((s) => s.title)).toEqual(["1.1 Auth", "1.2 Claims"]);
    // Steps ride out to the tester too.
    expect(run.sections[0]!.tests[0]!.detail?.steps).toEqual([
      "Open the login page.",
      "Enter the `PIN`.",
    ]);

    // 3. Tester marks every row.
    run.sections[0]!.tests[0]!.status = "pass";
    run.sections[0]!.tests[1]!.status = "fail";
    run.sections[1]!.tests[0]!.status = "pass";

    // 4. Tester exports results (pure twin of exportResults' envelope +
    //    marked table body).
    const results =
      composeFrontmatter(run.docId, signoff) + composeTestDocMarkdown(run);

    // 5. Developer imports the returned file.
    const back = parsePintaResultsMarkdown("results.md", results);
    expect(back).not.toBeNull();
    expect(back!.catalog.docId).toBe(dev.docId);
    expect(back!.signoff).toMatchObject({ tester: "Jess Reyes", runType: "Regression" });

    // 6. Overlay: statuses equal the run, structure/steps stay the dev's.
    const prior = snapshotStatuses(dev);
    const { applied, unknownIds } = overlayResults(dev, back!.catalog);
    expect(applied).toBe(3);
    expect(unknownIds).toEqual([]);
    expect(snapshotStatuses(dev)).toEqual(snapshotStatuses(run));
    expect(dev.sections[0]!.tests[0]!.detail?.steps).toEqual([
      "Open the login page.",
      "Enter the `PIN`.",
    ]);

    // 7. Clear restores the developer's own marks exactly.
    restoreStatuses(dev, prior);
    expect(snapshotStatuses(dev)).toEqual(prior);
  });

  it("round-trips pipes and newlines in cells without breaking id matching", () => {
    const dev = makeCatalog({
      sections: [
        {
          title: "1.1 Escapes",
          tests: [
            {
              id: "ESC-01",
              test: "click | submit\nthen wait",
              expected: "shows | toast",
              status: "untested",
            },
          ],
        },
      ],
    });
    const sheet = composeFrontmatter(dev.docId) + composeTesterSheetMarkdown(dev);
    const run = parsePintaResultsMarkdown("sheet.md", sheet)!.catalog;
    expect(run.sections[0]!.tests[0]!.id).toBe("ESC-01");
    expect(run.sections[0]!.tests[0]!.test).toBe("click | submit then wait");
    expect(run.sections[0]!.tests[0]!.expected).toBe("shows | toast");
    run.sections[0]!.tests[0]!.status = "fail";
    const results = composeFrontmatter(run.docId) + composeTestDocMarkdown(run);
    const back = parsePintaResultsMarkdown("results.md", results)!.catalog;
    const { applied, unknownIds } = overlayResults(dev, back);
    expect(applied).toBe(1);
    expect(unknownIds).toEqual([]);
    expect(dev.sections[0]!.tests[0]!.status).toBe("fail");
  });

  it("parses an exportResults-shaped body (meta line, ⚠ Untested, [chat] suffix)", () => {
    // Mirror of ExtensionState.exportResults()'s body — the state method
    // itself needs $state, so the shape is pinned here and parsed back.
    const body = [
      "# Test Pilot results — MrsM UAT",
      "_Run on 2026-09-23, by Jess Reyes, 1/3 passed, 1 failed, 1 untested_",
      "",
      "**Sign-off** — Jess Reyes · UAT · Regression run · 2026-09-23",
      "",
      "## 1.1 Auth",
      "",
      "| ID | Test | Expected | Result |",
      "|----|------|----------|--------|",
      "| AUTH-01 | Login | Dashboard | ✓ Pass [chat] |",
      "| AUTH-02 | Bad PIN | Error | ✗ Fail |",
      "",
      "## 1.2 Claims",
      "",
      "| ID | Test | Expected | Result |",
      "|----|------|----------|--------|",
      "| CLM-01 | List | Rows | ⚠ Untested |",
      "",
    ].join("\n");
    const md = composeFrontmatter("doc-abc", signoff) + body;
    const parsed = parsePintaResultsMarkdown("results.md", md);
    expect(parsed).not.toBeNull();
    expect(parsed!.catalog.docId).toBe("doc-abc");
    const statuses = snapshotStatuses(parsed!.catalog);
    expect(statuses).toEqual({
      "AUTH-01": "pass",
      "AUTH-02": "fail",
      "CLM-01": "untested",
    });
    // Overlays cleanly onto the developer catalog.
    const dev = makeCatalog();
    const { applied, unknownIds } = overlayResults(dev, parsed!.catalog);
    expect(applied).toBe(3);
    expect(unknownIds).toEqual([]);
  });

  it("returns null for a future envelope version", () => {
    const md =
      "---\npinta-test-pilot: 999\ndoc-id: doc-abc\n---\n\n" +
      composeTestDocMarkdown(makeCatalog());
    expect(parsePintaResultsMarkdown("x.md", md)).toBeNull();
  });

  it("returns null when the envelope is valid but the body isn't a Pinta doc", () => {
    const md = composeFrontmatter("doc-abc") + "just prose, no heading\n";
    expect(parsePintaResultsMarkdown("x.md", md)).toBeNull();
  });
});

describe("overlayStatusesById edge cases", () => {
  it("an empty status map is a no-op", () => {
    const base = makeCatalog();
    const before = snapshotStatuses(base);
    const { applied, unknownIds } = overlayStatusesById(base, {});
    expect(applied).toBe(0);
    expect(unknownIds).toEqual([]);
    expect(snapshotStatuses(base)).toEqual(before);
  });

  it("every id is unknown against an empty catalog", () => {
    const base = makeCatalog({ sections: [] });
    const { applied, unknownIds } = overlayStatusesById(base, {
      "AUTH-01": "pass",
      "GONE-99": "fail",
    });
    expect(applied).toBe(0);
    expect(unknownIds.sort()).toEqual(["AUTH-01", "GONE-99"]);
  });
});

describe("snapshot/restore edge cases", () => {
  it("rows added after the snapshot keep their current status on restore", () => {
    const base = makeCatalog();
    const prior = snapshotStatuses(base);
    base.sections[0]!.tests.push({
      id: "USER-1",
      test: "new scenario",
      expected: "works",
      status: "fail",
    });
    restoreStatuses(base, prior);
    expect(base.sections[0]!.tests[0]!.status).toBe("pass"); // restored
    expect(base.sections[0]!.tests.at(-1)!.status).toBe("fail"); // kept
  });
});

describe("composeFrontmatter blank sign-off fields", () => {
  it("skips all-blank sign-off fields entirely", () => {
    const fm = composeFrontmatter("doc-abc", {
      tester: "  ",
      email: "",
      date: "",
      environment: " ",
      runType: "",
      notes: "",
    });
    expect(fm).toBe("---\npinta-test-pilot: 1\ndoc-id: doc-abc\n---\n\n");
  });
});

describe("renderSignoffBlock", () => {
  it("renders tester, environment, run type, date and quoted notes", () => {
    const block = renderSignoffBlock(signoff);
    expect(block).toContain("**Sign-off** — Jess Reyes");
    expect(block).toContain("UAT");
    expect(block).toContain("Regression run");
    expect(block).toContain("2026-09-23");
    expect(block).toContain("> Blocked on claims filtering");
  });
});

describe("snapshot/restore prototype safety", () => {
  it("snapshots and restores a test id literally named __proto__", () => {
    const base = makeCatalog({
      sections: [
        {
          title: "1.1 Hostile ids",
          tests: [
            { id: "__proto__", test: "evil", expected: "safe", status: "pass" },
            { id: "constructor", test: "also evil", expected: "safe", status: "fail" },
          ],
        },
      ],
    });
    const snap = snapshotStatuses(base);
    // Own properties, not prototype mutations / Object.prototype reads.
    expect(Object.prototype.hasOwnProperty.call(snap, "__proto__")).toBe(true);
    expect(snap["__proto__"]).toBe("pass");
    expect(snap["constructor"]).toBe("fail");
    // Snapshotting must not have re-pointed the object's prototype.
    expect(Object.getPrototypeOf(snap)).toBeNull();

    base.sections[0]!.tests[0]!.status = "fail";
    base.sections[0]!.tests[1]!.status = "untested";
    restoreStatuses(base, snap);
    expect(base.sections[0]!.tests[0]!.status).toBe("pass");
    expect(base.sections[0]!.tests[1]!.status).toBe("fail");
  });

  it("restore ignores Object.prototype members on a plain-object snapshot", () => {
    // A snapshot that round-tripped through JSON/chrome.storage is a
    // plain object again — a row named "constructor" must NOT pick up
    // Object.prototype.constructor as its status.
    const base = makeCatalog({
      sections: [
        {
          title: "1.1",
          tests: [
            { id: "constructor", test: "x", expected: "y", status: "fail" },
          ],
        },
      ],
    });
    restoreStatuses(base, {} as Record<string, "pass" | "fail" | "untested">);
    expect(base.sections[0]!.tests[0]!.status).toBe("fail");
  });
});

describe("overlayResultsSidecar", () => {
  const sidecar = () => ({
    "AUTH-01": {
      status: "fail" as const,
      chat: [
        { id: "m1", role: "user" as const, text: "why?", at: 1 },
      ] as never,
      detail: { steps: ["do the thing"], askedAt: 2 },
    },
    "CLM-01": { status: "pass" as const },
  });

  it("disk wins on the normal path: statuses, chat and detail all merge", () => {
    const base = makeCatalog();
    const { statusesApplied } = overlayResultsSidecar(base, sidecar());
    expect(statusesApplied).toBeGreaterThan(0);
    expect(base.sections[0]!.tests[0]!.status).toBe("fail");
    expect(base.sections[1]!.tests[0]!.status).toBe("pass");
    expect(base.sections[0]!.tests[0]!.detail?.steps).toEqual(["do the thing"]);
    expect(base.sections[0]!.tests[0]!.chat).toHaveLength(1);
    // Row with no sidecar entry untouched.
    expect(base.sections[0]!.tests[1]!.status).toBe("fail");
  });

  it("skipStatuses keeps the imported run's marks but still merges chat + detail", () => {
    const base = makeCatalog();
    // Pretend a tester run was overlaid: AUTH-01 currently "pass".
    base.sections[0]!.tests[0]!.status = "pass";
    const { statusesApplied } = overlayResultsSidecar(base, sidecar(), {
      skipStatuses: true,
    });
    expect(statusesApplied).toBe(0);
    // Stale sidecar status did NOT clobber the overlaid mark…
    expect(base.sections[0]!.tests[0]!.status).toBe("pass");
    expect(base.sections[1]!.tests[0]!.status).toBe("untested");
    // …but the chat thread and cached steps still hydrated.
    expect(base.sections[0]!.tests[0]!.chat).toHaveLength(1);
    expect(base.sections[0]!.tests[0]!.detail?.steps).toEqual(["do the thing"]);
  });

  it("tolerates malformed sidecar entries and hostile ids", () => {
    const base = makeCatalog({
      sections: [
        {
          title: "1.1",
          tests: [{ id: "AUTH-01", test: "x", expected: "y", status: "pass" }],
        },
      ],
    });
    // null entry + a lookup that would hit Object.prototype if unguarded.
    overlayResultsSidecar(base, {
      "AUTH-01": null as never,
      constructor: { status: "fail" } as never,
    });
    expect(base.sections[0]!.tests[0]!.status).toBe("pass");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 21 — the `scope:` envelope line. A partial export has to say so
// on the file itself, and the developer's importer has to keep working
// on files that carry it (and on every file written before it existed).
// ─────────────────────────────────────────────────────────────────────

describe("composeFrontmatter — scope line", () => {
  const scopeLine = (fm: string) =>
    fm.split("\n").find((l) => l.startsWith("scope:")) ?? null;

  it("omits scope entirely for the default 'all' scope", () => {
    expect(scopeLine(composeFrontmatter("doc-1", undefined, "all"))).toBeNull();
  });

  it("omits scope when the caller passes nothing", () => {
    expect(scopeLine(composeFrontmatter("doc-1"))).toBeNull();
    expect(scopeLine(composeFrontmatter("doc-1", undefined, ""))).toBeNull();
  });

  it("emits scope for every non-'all' token", () => {
    for (const token of ["since-v2", "failed", "untested", "plan:Sprint 12"]) {
      expect(scopeLine(composeFrontmatter("doc-1", undefined, token))).toBe(
        `scope: ${token}`,
      );
    }
  });

  it("keeps scope on one line even if the plan name had a newline", () => {
    const fm = composeFrontmatter("doc-1", undefined, "plan:Sprint\n12");
    expect(scopeLine(fm)).toBe("scope: plan:Sprint 12");
    // Still a well-formed envelope: exactly two fences.
    expect(fm.match(/^---$/gm)).toHaveLength(2);
  });

  it("sits between doc-id and the sign-off block", () => {
    const fm = composeFrontmatter(
      "doc-1",
      {
        tester: "Tess",
        date: "2026-09-24",
        environment: "UAT",
        runType: "Smoke",
      },
      "since-v3",
    );
    const keys = fm
      .split("\n")
      .filter((l) => /^[a-z-]+:/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keys).toEqual([
      "pinta-test-pilot",
      "doc-id",
      "scope",
      "tester",
      "date",
      "environment",
      "run-type",
    ]);
  });

  it("parseFrontmatter reads the scope back", () => {
    const { meta, body } = parseFrontmatter(
      composeFrontmatter("doc-9", undefined, "since-v2") + "# Doc\n",
    );
    expect(meta?.["scope"]).toBe("since-v2");
    expect(meta?.["doc-id"]).toBe("doc-9");
    expect(body).toBe("# Doc\n");
  });

  it("a scope-less file reads back with no scope key at all", () => {
    const { meta } = parseFrontmatter(
      composeFrontmatter("doc-9", undefined, "all") + "# Doc\n",
    );
    expect(meta).not.toBeNull();
    expect("scope" in meta!).toBe(false);
  });

  it("round-trips a scope carrying a colon (plan:Name) without truncating", () => {
    const { meta } = parseFrontmatter(
      composeFrontmatter("doc-9", undefined, "plan:Sprint 12: hotfix") + "#\n",
    );
    expect(meta?.["scope"]).toBe("plan:Sprint 12: hotfix");
  });
});

describe("parsePintaResultsMarkdown on a scoped file", () => {
  const body = [
    "# Test Pilot results — UAT",
    "_Run on 2026-09-24, by Tess, 1/2 passed, 1 failed, 0 untested_",
    "",
    "## 1.1 Auth",
    "",
    "| ID | Test | Expected | Result |",
    "|----|------|----------|--------|",
    "| AUTH-01 | login | dashboard | ✓ Pass |",
    "| AUTH-02 | logout | login page | ✗ Fail |",
    "",
  ].join("\n");

  it("parses marks + sign-off with a scope line present", () => {
    const parsed = parsePintaResultsMarkdown(
      "results.md",
      composeFrontmatter(
        "doc-42",
        {
          tester: "Tess",
          date: "2026-09-24",
          environment: "UAT",
          runType: "Smoke",
        },
        "since-v2",
      ) + body,
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.catalog.docId).toBe("doc-42");
    expect(parsed!.signoff?.tester).toBe("Tess");
    expect(parsed!.signoff?.runType).toBe("Smoke");
    const rows = parsed!.catalog.sections[0]!.tests;
    expect(rows.map((t) => t.status)).toEqual(["pass", "fail"]);
  });

  it("the scope line never leaks into the parsed title or description", () => {
    const parsed = parsePintaResultsMarkdown(
      "results.md",
      composeFrontmatter("doc-42", undefined, "plan:Sprint 12") + body,
    )!;
    expect(parsed.catalog.title).toBe("Test Pilot results — UAT");
    expect(parsed.catalog.description ?? "").not.toContain("scope");
  });

  it("a scoped run overlays onto the full catalog, touching only its rows", () => {
    const base: TestPilotCatalog = {
      docId: "doc-42",
      filename: "uat.md",
      importedAt: 0,
      sections: [
        {
          title: "1.1 Auth",
          tests: [
            { id: "AUTH-01", test: "login", expected: "d", status: "untested" },
            { id: "AUTH-02", test: "logout", expected: "l", status: "untested" },
            { id: "AUTH-03", test: "sso", expected: "s", status: "pass" },
          ],
        },
      ],
    };
    const run = parsePintaResultsMarkdown(
      "results.md",
      composeFrontmatter("doc-42", undefined, "since-v2") + body,
    )!.catalog;
    const { applied, unknownIds } = overlayResults(base, run);
    expect({ applied, unknownIds }).toEqual({ applied: 2, unknownIds: [] });
    // AUTH-03 was out of scope, so the scoped sheet never mentioned it
    // and the developer's own mark is left alone.
    expect(base.sections[0]!.tests.map((t) => t.status)).toEqual([
      "pass",
      "fail",
      "pass",
    ]);
  });

  it("still returns null for a file with no pinta-test-pilot marker, scope or not", () => {
    expect(
      parsePintaResultsMarkdown("x.md", "---\nscope: failed\n---\n\n" + body),
    ).toBeNull();
  });
});
