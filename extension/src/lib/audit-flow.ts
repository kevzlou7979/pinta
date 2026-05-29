// Pure helpers for AuditFlow (Phase 15). Extracted from state.svelte.ts
// so they can be unit-tested without booting the chrome.* API surface
// or Svelte's $state runtime. The state class delegates to these for
// score / rating / display computations; the markdown-style helpers
// (composeAuditFixComment) compose prose the agent reads back through
// the Annotate handoff.

import type {
  AuditCategoryId,
  AuditCheck,
  AuditCheckStatus,
} from "@pinta/shared";

/**
 * Deterministic per-category score from a list of checks.
 *
 *     (pass × 1 + warn × 0.5 + fail × 0) / (pass + warn + fail) × 100
 *
 * Info checks are excluded from the denominator — they're observations,
 * not gradable findings. An empty list (or info-only list) returns 100
 * so a category with nothing to grade reads as "fine" rather than
 * "zero / poor" in the rollup. Result is integer-rounded so the UI
 * doesn't render trailing decimals.
 *
 * Mirrors the formula in SKILL.md §7.11 so client-computed scores
 * match agent-computed scores when both are present.
 */
export function computeCategoryScore(checks: AuditCheck[]): number {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const c of checks) {
    if (c.status === "pass") pass++;
    else if (c.status === "warn") warn++;
    else if (c.status === "fail") fail++;
  }
  const denom = pass + warn + fail;
  if (denom === 0) return 100;
  return Math.round(((pass * 1 + warn * 0.5) / denom) * 100);
}

/**
 * Rating string from an overall score. Thresholds locked in
 * SKILL.md §7.11 — kept in sync so the rating the agent emits matches
 * the rating the extension would compute if asked.
 */
export function ratingFromScore(score: number): string {
  if (score >= 90) return "Excellent";
  if (score >= 70) return "Good";
  if (score >= 50) return "Needs work";
  return "Poor";
}

/**
 * Friendly name for a category id. Used when the agent omits the
 * `name` field on a CategoryResult (defensive — SKILL.md says to
 * include it, but a degraded payload shouldn't break the rendered
 * card). Unknown ids fall through to the raw id string.
 */
export function categoryDisplayName(id: AuditCategoryId): string {
  switch (id) {
    case "security":
      return "Security";
    case "performance":
      return "Performance";
    case "accessibility":
      return "Accessibility";
    case "mobile":
      return "Mobile";
    case "cross-browser":
      return "Cross-Browser";
    default:
      return typeof id === "string" ? id : "Unknown";
  }
}

/**
 * Compose a prefilled comment for the Fix-with-agent handoff. Builds
 * a readable prose block that captures the check's full context
 * (category, status, label, value, source pointer, description, fix
 * hint) so the agent can act on the finding even when the synthesized
 * annotation has no DOM target.
 *
 * Field omissions are graceful — missing `value` / `description` /
 * `fixHint` skip their lines entirely; missing `where` falls back
 * cleanly. Output is plain text (no markdown formatting beyond
 * newlines) since this lands in `annotation.comment` which Pinta
 * passes verbatim to the agent.
 */
export function composeAuditFixComment(check: AuditCheck): string {
  const lines: string[] = [];
  lines.push(
    `AuditFlow finding (${check.category} · ${check.status.toUpperCase()}): ${check.label}`,
  );
  if (check.value) lines.push(`Value: ${check.value}`);
  if (check.where?.file) {
    lines.push(
      `Source: ${check.where.file}${check.where.line ? `:${check.where.line}` : ""}`,
    );
  } else if (check.where?.url) {
    lines.push(`Page: ${check.where.url}`);
  }
  if (check.description) {
    lines.push("");
    lines.push(check.description);
  }
  if (check.fixHint) {
    lines.push("");
    lines.push(`Fix hint: ${check.fixHint}`);
  }
  return lines.join("\n");
}

/**
 * Status tier glyph used in the AuditFlowTab check row. Kept in sync
 * with the UI so the tier is a single source of truth — UI imports
 * this rather than open-coding the switch. Exposed for tests so the
 * mapping doesn't silently drift if a new status lands.
 */
export function statusGlyph(status: AuditCheckStatus): string {
  switch (status) {
    case "pass":
      return "✓";
    case "warn":
      return "!";
    case "fail":
      return "✗";
    case "info":
    default:
      return "i";
  }
}
