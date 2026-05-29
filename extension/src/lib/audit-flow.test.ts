import { describe, expect, it } from "vitest";
import type { AuditCategoryId, AuditCheck } from "@pinta/shared";
import {
  categoryDisplayName,
  composeAuditFixComment,
  computeCategoryScore,
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

describe("statusGlyph", () => {
  it("maps each status to its single-char tier glyph", () => {
    expect(statusGlyph("pass")).toBe("✓");
    expect(statusGlyph("warn")).toBe("!");
    expect(statusGlyph("fail")).toBe("✗");
    expect(statusGlyph("info")).toBe("i");
  });
});
