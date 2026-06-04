import { describe, expect, it } from "vitest";
import type {
  AuditCategoryId,
  AuditCategoryResult,
  AuditCheck,
  AuditDisposition,
  AuditOverlay,
  AuditRun,
} from "@pinta/shared";
import {
  auditProgress,
  categoryDisplayName,
  composeAuditFixComment,
  computeCategoryScore,
  mergeAuditRun,
  ratingFromScore,
  statusGlyph,
} from "./audit-flow.js";

/** Factory — keeps test-call sites short by defaulting the fields
 *  most tests don't care about. Each test overrides what it needs. */
function check(
  partial: Partial<AuditCheck> & Pick<AuditCheck, "status">,
): AuditCheck {
  return {
    id: partial.id ?? "test-id",
    category: partial.category ?? "security",
    status: partial.status,
    label: partial.label ?? "Test check",
    value: partial.value,
    description: partial.description,
    where: partial.where,
    fixHint: partial.fixHint,
    suggestedAnnotation: partial.suggestedAnnotation,
  };
}

describe("computeCategoryScore", () => {
  it("returns 100 for an empty list (nothing to grade reads as fine, not zero)", () => {
    expect(computeCategoryScore([])).toBe(100);
  });

  it("returns 100 when every check passes", () => {
    expect(
      computeCategoryScore([
        check({ status: "pass" }),
        check({ status: "pass" }),
        check({ status: "pass" }),
      ]),
    ).toBe(100);
  });

  it("returns 0 when every check fails", () => {
    expect(
      computeCategoryScore([
        check({ status: "fail" }),
        check({ status: "fail" }),
      ]),
    ).toBe(0);
  });

  it("warn checks weight half — 1 pass + 1 warn = 75", () => {
    // (1×1 + 1×0.5) / 2 × 100 = 75
    expect(
      computeCategoryScore([
        check({ status: "pass" }),
        check({ status: "warn" }),
      ]),
    ).toBe(75);
  });

  it("mixed grade: 2 pass + 1 warn + 1 fail = 63 (rounded)", () => {
    // (2×1 + 1×0.5 + 1×0) / 4 × 100 = 62.5 → 63
    expect(
      computeCategoryScore([
        check({ status: "pass" }),
        check({ status: "pass" }),
        check({ status: "warn" }),
        check({ status: "fail" }),
      ]),
    ).toBe(63);
  });

  it("info checks are excluded from the denominator", () => {
    // 1 pass + 1 fail = 50; the info should not pull it toward 33.
    expect(
      computeCategoryScore([
        check({ status: "pass" }),
        check({ status: "fail" }),
        check({ status: "info" }),
      ]),
    ).toBe(50);
  });

  it("info-only list returns 100 (treated like empty for scoring)", () => {
    expect(
      computeCategoryScore([
        check({ status: "info" }),
        check({ status: "info" }),
      ]),
    ).toBe(100);
  });

  it("rounds — not floors — half-points (banker's-rounding not required, just stable)", () => {
    // 1 pass + 2 warn = (1 + 1) / 3 × 100 = 66.66… → 67
    expect(
      computeCategoryScore([
        check({ status: "pass" }),
        check({ status: "warn" }),
        check({ status: "warn" }),
      ]),
    ).toBe(67);
  });
});

describe("ratingFromScore", () => {
  it("90+ → Excellent (boundary inclusive)", () => {
    expect(ratingFromScore(100)).toBe("Excellent");
    expect(ratingFromScore(95)).toBe("Excellent");
    expect(ratingFromScore(90)).toBe("Excellent");
  });

  it("70..89 → Good", () => {
    expect(ratingFromScore(89)).toBe("Good");
    expect(ratingFromScore(80)).toBe("Good");
    expect(ratingFromScore(70)).toBe("Good");
  });

  it("50..69 → Needs work", () => {
    expect(ratingFromScore(69)).toBe("Needs work");
    expect(ratingFromScore(60)).toBe("Needs work");
    expect(ratingFromScore(50)).toBe("Needs work");
  });

  it("<50 → Poor", () => {
    expect(ratingFromScore(49)).toBe("Poor");
    expect(ratingFromScore(0)).toBe("Poor");
  });
});

describe("categoryDisplayName", () => {
  it("maps each built-in id to its friendly name", () => {
    expect(categoryDisplayName("security")).toBe("Security");
    expect(categoryDisplayName("performance")).toBe("Performance");
    expect(categoryDisplayName("accessibility")).toBe("Accessibility");
    expect(categoryDisplayName("mobile")).toBe("Mobile");
    expect(categoryDisplayName("cross-browser")).toBe("Cross-Browser");
  });

  it("falls through to the raw id for custom-audit category ids (Phase 15c)", () => {
    const customId = "audit-flow-custom:abc-123" as AuditCategoryId;
    expect(categoryDisplayName(customId)).toBe(customId);
  });
});

describe("composeAuditFixComment", () => {
  it("composes the full check with all fields present", () => {
    const text = composeAuditFixComment(
      check({
        category: "security",
        status: "fail",
        label: "eval() in user-input path",
        value: "3 occurrences",
        description: "Inline `eval()` parses user-controlled strings as code — XSS vector.",
        where: { file: "src/lib/parser.ts", line: 42 },
        fixHint: "Replace with JSON.parse + a schema validator.",
      }),
    );
    // Header line carries category + status + label.
    expect(text).toContain("AuditFlow finding (security · FAIL): eval() in user-input path");
    expect(text).toContain("Value: 3 occurrences");
    expect(text).toContain("Source: src/lib/parser.ts:42");
    expect(text).toContain("Inline `eval()` parses user-controlled strings");
    expect(text).toContain("Fix hint: Replace with JSON.parse");
  });

  it("omits Value line when value is absent", () => {
    const text = composeAuditFixComment(
      check({
        status: "warn",
        label: "Missing alt text",
        where: { file: "src/components/Hero.svelte", line: 12 },
      }),
    );
    expect(text).not.toContain("Value:");
  });

  it("uses Page: line when where has url instead of file", () => {
    const text = composeAuditFixComment(
      check({
        status: "fail",
        label: "Heading hierarchy skip",
        where: { url: "http://localhost:5173/dashboard" },
      }),
    );
    expect(text).toContain("Page: http://localhost:5173/dashboard");
    expect(text).not.toContain("Source:");
  });

  it("omits Source / Page when where is missing entirely", () => {
    const text = composeAuditFixComment(
      check({
        status: "fail",
        label: "Bundle size > 3MB",
      }),
    );
    expect(text).not.toContain("Source:");
    expect(text).not.toContain("Page:");
  });

  it("omits Source's line suffix when only file is set (no line number)", () => {
    const text = composeAuditFixComment(
      check({
        status: "warn",
        label: "Deprecated dep",
        where: { file: "package.json" },
      }),
    );
    expect(text).toContain("Source: package.json");
    expect(text).not.toContain("package.json:");
  });

  it("preserves blank line before description and before fix hint for readability", () => {
    const text = composeAuditFixComment(
      check({
        status: "fail",
        label: "Test",
        description: "DESCRIPTION",
        fixHint: "FIXHINT",
      }),
    );
    // Expect each prose block separated by a blank line.
    expect(text).toMatch(/\n\nDESCRIPTION/);
    expect(text).toMatch(/\n\nFix hint: FIXHINT/);
  });

  it("handles a degenerate check with only label + status (no extras)", () => {
    const text = composeAuditFixComment(
      check({ status: "info", label: "Note" }),
    );
    // Should still produce a parseable single-line header.
    expect(text).toBe("AuditFlow finding (security · INFO): Note");
  });

  it("uppercases the status in the header regardless of input casing", () => {
    // Status is typed but defensive against future enum drift.
    const text = composeAuditFixComment(
      check({ status: "fail", label: "X" }),
    );
    expect(text).toContain("FAIL");
    expect(text).not.toContain("fail)");
  });
});

describe("auditProgress", () => {
  it("empty list → 0 actionable, 0 done, 100% (nothing to address reads as complete)", () => {
    expect(auditProgress([], {})).toEqual({
      actionable: 0,
      done: 0,
      percent: 100,
    });
  });

  it("pass / info checks are excluded from the actionable set", () => {
    expect(
      auditProgress(
        [
          check({ status: "pass", id: "p1" }),
          check({ status: "info", id: "i1" }),
        ],
        {},
      ),
    ).toEqual({ actionable: 0, done: 0, percent: 100 });
  });

  it("all actionable + no dispositions → defaults to open → 0%", () => {
    expect(
      auditProgress(
        [
          check({ status: "fail", id: "f1" }),
          check({ status: "warn", id: "w1" }),
        ],
        {},
      ),
    ).toEqual({ actionable: 2, done: 0, percent: 0 });
  });

  it("resolved + wont-fix both count as done; open + fixing do not", () => {
    const dispositions: Record<string, AuditDisposition> = {
      f1: "resolved",
      f2: "wont-fix",
      f3: "fixing",
      // f4 absent → open
    };
    expect(
      auditProgress(
        [
          check({ status: "fail", id: "f1" }),
          check({ status: "warn", id: "f2" }),
          check({ status: "fail", id: "f3" }),
          check({ status: "warn", id: "f4" }),
        ],
        dispositions,
      ),
    ).toEqual({ actionable: 4, done: 2, percent: 50 });
  });

  it("mix of actionable + non-actionable: only fail/warn drive the denominator", () => {
    // 2 actionable (1 done) + 2 non-actionable ignored → 1/2 = 50%
    expect(
      auditProgress(
        [
          check({ status: "fail", id: "f1" }),
          check({ status: "warn", id: "w1" }),
          check({ status: "pass", id: "p1" }),
          check({ status: "info", id: "i1" }),
        ],
        { f1: "resolved" },
      ),
    ).toEqual({ actionable: 2, done: 1, percent: 50 });
  });

  it("rounds the percent — 1 of 3 done = 33%", () => {
    expect(
      auditProgress(
        [
          check({ status: "fail", id: "f1" }),
          check({ status: "fail", id: "f2" }),
          check({ status: "fail", id: "f3" }),
        ],
        { f1: "resolved" },
      ).percent,
    ).toBe(33);
  });
});

describe("mergeAuditRun", () => {
  const emptyOverlay = (): AuditOverlay => ({
    addedCategories: [],
    addedChecks: {},
    edits: {},
    deleted: [],
  });

  function run(categories: AuditCategoryResult[]): AuditRun {
    return {
      runId: "agent-run-1",
      startedAt: 1000,
      completedAt: 2000,
      categories,
      overall: 0,
      rating: "Poor",
    };
  }

  it("null agent run + empty overlay → null", () => {
    expect(mergeAuditRun(null, emptyOverlay())).toBeNull();
  });

  it("null agent run + added categories → synthetic run from overlay alone", () => {
    const overlay = emptyOverlay();
    overlay.addedCategories = [
      {
        id: "audit-flow-custom:abc" as AuditCategoryId,
        name: "My Audit",
        score: 100,
        checks: [check({ status: "fail", id: "USER-1" })],
      },
    ];
    const merged = mergeAuditRun(null, overlay);
    expect(merged).not.toBeNull();
    expect(merged?.categories).toHaveLength(1);
    expect(merged?.categories[0].name).toBe("My Audit");
    // single fail → score 0 → overall 0 → Poor
    expect(merged?.categories[0].score).toBe(0);
    expect(merged?.overall).toBe(0);
    expect(merged?.rating).toBe("Poor");
  });

  it("deletes a category whose id is in `deleted`", () => {
    const agentRun = run([
      { id: "security", name: "Security", score: 50, checks: [check({ status: "fail", id: "s1" })] },
      { id: "performance", name: "Performance", score: 50, checks: [check({ status: "fail", id: "p1" })] },
    ]);
    const overlay = emptyOverlay();
    overlay.deleted = ["performance"];
    const merged = mergeAuditRun(agentRun, overlay);
    expect(merged?.categories.map((c) => c.id)).toEqual(["security"]);
  });

  it("drops deleted checks and recomputes the category score", () => {
    const agentRun = run([
      {
        id: "security",
        name: "Security",
        score: 50,
        checks: [
          check({ status: "pass", id: "s1" }),
          check({ status: "fail", id: "s2" }),
        ],
      },
    ]);
    const overlay = emptyOverlay();
    overlay.deleted = ["s2"]; // drop the fail → only pass left → score 100
    const merged = mergeAuditRun(agentRun, overlay);
    expect(merged?.categories[0].checks.map((c) => c.id)).toEqual(["s1"]);
    expect(merged?.categories[0].score).toBe(100);
    expect(merged?.overall).toBe(100);
  });

  it("applies field edits to agent checks without mutating the input", () => {
    const original = check({ status: "warn", id: "s1", label: "Old", description: "OldDesc" });
    const agentRun = run([
      { id: "security", name: "Security", score: 50, checks: [original] },
    ]);
    const overlay = emptyOverlay();
    overlay.edits = { s1: { label: "New", fixHint: "Do this" } };
    const merged = mergeAuditRun(agentRun, overlay);
    const c = merged?.categories[0].checks[0];
    expect(c?.label).toBe("New");
    expect(c?.fixHint).toBe("Do this");
    expect(c?.description).toBe("OldDesc"); // untouched field preserved
    expect(original.label).toBe("Old"); // input not mutated
  });

  it("concats addedChecks onto a built-in category and recomputes score", () => {
    const agentRun = run([
      { id: "security", name: "Security", score: 100, checks: [check({ status: "pass", id: "s1" })] },
    ]);
    const overlay = emptyOverlay();
    overlay.addedChecks = {
      security: [check({ status: "fail", id: "USER-1", label: "User finding" })],
    };
    const merged = mergeAuditRun(agentRun, overlay);
    expect(merged?.categories[0].checks.map((c) => c.id)).toEqual(["s1", "USER-1"]);
    // 1 pass + 1 fail → 50
    expect(merged?.categories[0].score).toBe(50);
    expect(merged?.overall).toBe(50);
  });

  it("computes overall as the rounded average of category scores", () => {
    const agentRun = run([
      { id: "security", name: "Security", score: 0, checks: [check({ status: "pass", id: "s1" })] },
      { id: "performance", name: "Performance", score: 0, checks: [check({ status: "fail", id: "p1" })] },
    ]);
    // security → 100, performance → 0, avg → 50
    const merged = mergeAuditRun(agentRun, emptyOverlay());
    expect(merged?.overall).toBe(50);
    expect(merged?.rating).toBe("Needs work");
  });

  it("preserves runId and timing from the agent run", () => {
    const agentRun = run([
      { id: "security", name: "Security", score: 100, checks: [] },
    ]);
    const merged = mergeAuditRun(agentRun, emptyOverlay());
    expect(merged?.runId).toBe("agent-run-1");
    expect(merged?.startedAt).toBe(1000);
    expect(merged?.completedAt).toBe(2000);
  });

  // ─── Agent-evaluated custom categories ──────────────────────────────
  // After the re-run fix, the agent can return a custom category it
  // evaluated. Its checks include the user's USER- ids (now graded) plus
  // fresh agent findings. The same USER- check still lives in
  // overlay.addedChecks, so the merge must NOT render it twice — the
  // agent's evaluated copy wins.

  const customId = "audit-flow-custom:abc" as AuditCategoryId;

  it("dedupes a USER- check that the agent echoed back (evaluated copy wins, no duplicate)", () => {
    const agentRun = run([
      {
        id: customId,
        name: "Svelte Best Practices",
        score: 0,
        checks: [
          // agent's evaluated copy of the user's check — same id, now pass
          check({ status: "pass", id: "USER-1", label: "Follow svelte skills", value: "conforms" }),
          // a fresh finding the agent added under the theme
          check({ status: "fail", id: "sha1-new", label: "Legacy $: reactive" }),
        ],
      },
    ]);
    const overlay = emptyOverlay();
    // The static, un-evaluated copy still sits in the overlay.
    overlay.addedCategories = [
      { id: customId, name: "Svelte Best Practices", score: 100, checks: [] },
    ];
    overlay.addedChecks = {
      [customId]: [check({ status: "warn", id: "USER-1", label: "Follow svelte skills" })],
    };
    const merged = mergeAuditRun(agentRun, overlay);
    // Only ONE category, and USER-1 appears exactly once with the agent's
    // status (pass), not the overlay's stale warn.
    expect(merged?.categories).toHaveLength(1);
    const checks = merged?.categories[0].checks ?? [];
    expect(checks.map((c) => c.id)).toEqual(["USER-1", "sha1-new"]);
    expect(checks.find((c) => c.id === "USER-1")?.status).toBe("pass");
    // 1 pass + 1 fail → 50
    expect(merged?.categories[0].score).toBe(50);
  });

  it("prefers the overlay name for a custom category the user renamed after the run", () => {
    const agentRun = run([
      { id: customId, name: "Old Name", score: 100, checks: [check({ status: "pass", id: "USER-1" })] },
    ]);
    const overlay = emptyOverlay();
    overlay.addedCategories = [
      { id: customId, name: "Renamed By User", score: 100, checks: [] },
    ];
    const merged = mergeAuditRun(agentRun, overlay);
    expect(merged?.categories).toHaveLength(1);
    expect(merged?.categories[0].name).toBe("Renamed By User");
  });

  it("still renders a custom category the agent has not evaluated yet (never-run)", () => {
    const agentRun = run([
      { id: "security", name: "Security", score: 100, checks: [check({ status: "pass", id: "s1" })] },
    ]);
    const overlay = emptyOverlay();
    overlay.addedCategories = [
      { id: customId, name: "Brand New", score: 100, checks: [] },
    ];
    overlay.addedChecks = {
      [customId]: [check({ status: "warn", id: "USER-1", label: "Todo" })],
    };
    const merged = mergeAuditRun(agentRun, overlay);
    expect(merged?.categories.map((c) => c.id)).toEqual(["security", customId]);
    expect(merged?.categories[1].checks.map((c) => c.id)).toEqual(["USER-1"]);
  });

  it("hides a deleted check inside an agent-evaluated custom category", () => {
    const agentRun = run([
      {
        id: customId,
        name: "Svelte Best Practices",
        score: 0,
        checks: [
          check({ status: "pass", id: "USER-1" }),
          check({ status: "fail", id: "sha1-new" }),
        ],
      },
    ]);
    const overlay = emptyOverlay();
    overlay.addedCategories = [
      { id: customId, name: "Svelte Best Practices", score: 100, checks: [] },
    ];
    overlay.deleted = ["sha1-new"]; // user hid the agent's finding
    const merged = mergeAuditRun(agentRun, overlay);
    expect(merged?.categories[0].checks.map((c) => c.id)).toEqual(["USER-1"]);
    expect(merged?.categories[0].score).toBe(100); // only the pass remains
  });
});

describe("statusGlyph", () => {
  it("maps each status to its single-char tier glyph", () => {
    expect(statusGlyph("pass")).toBe("✓");
    expect(statusGlyph("warn")).toBe("!");
    expect(statusGlyph("fail")).toBe("✗");
    expect(statusGlyph("info")).toBe("i");
  });
});
