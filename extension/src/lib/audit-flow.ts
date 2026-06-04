// Pure helpers for AuditFlow (Phase 15). Extracted from state.svelte.ts
// so they can be unit-tested without booting the chrome.* API surface
// or Svelte's $state runtime. The state class delegates to these for
// score / rating / display computations; the markdown-style helpers
// (composeAuditFixComment) compose prose the agent reads back through
// the Annotate handoff.

import type {
  AuditCategoryId,
  AuditCategoryResult,
  AuditCheck,
  AuditCheckStatus,
  AuditDisposition,
  AuditOverlay,
  AuditRun,
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
 * Remediation progress over a set of checks, mirroring Test Pilot's
 * pass/fail/untested "% complete" model.
 *
 * Only "actionable" checks (status `fail` or `warn`) count toward
 * progress — `pass` / `info` are observations, not findings to work
 * through. A check is "done" when its disposition is `resolved` or
 * `wont-fix`; `open` / `fixing` (and any check missing from the map,
 * which defaults to `open`) are still outstanding.
 *
 * An empty actionable set returns 100% (nothing to address reads as
 * "complete", not "0%") so a clean category / run shows a full bar.
 * Percent is integer-rounded so the UI doesn't render decimals.
 */
export function auditProgress(
  checks: AuditCheck[],
  dispositions: Record<string, AuditDisposition>,
): { actionable: number; done: number; percent: number } {
  let actionable = 0;
  let done = 0;
  for (const c of checks) {
    if (c.status !== "fail" && c.status !== "warn") continue;
    actionable++;
    const d = dispositions[c.id] ?? "open";
    if (d === "resolved" || d === "wont-fix") done++;
  }
  const percent = actionable === 0 ? 100 : Math.round((done / actionable) * 100);
  return { actionable, done, percent };
}

/**
 * Merge the user's durable overlay over the AGENT-generated audit run
 * (Phase 15 "Slice 2"). The agent run is recomputed every re-audit, so
 * user edits live in the overlay and are layered back on here. Pure —
 * no side effects, never mutates its inputs.
 *
 * Rules:
 *  - null agent run + empty `addedCategories` → null (nothing to show).
 *  - null agent run + added categories → a synthetic run built from the
 *    overlay alone (runId / timing synthesized).
 *  - Kept agent categories drop any check id in `deleted`, apply
 *    `edits[id]` field-overrides to the survivors, then concat
 *    `addedChecks[categoryId]`.
 *  - Custom `addedCategories` are appended (also minus deleted checks,
 *    plus their own `addedChecks`).
 *  - Every `category.score` is recomputed; `run.overall` is the rounded
 *    average of category scores (matching applyAuditResult).
 */
export function mergeAuditRun(
  agentRun: AuditRun | null,
  overlay: AuditOverlay,
): AuditRun | null {
  const deleted = new Set(overlay.deleted);

  // Build the checks for one category id: keep its non-deleted checks
  // (with agent-check edits applied), then append user-added checks.
  //
  // Dedupe: a user-added check id that ALSO appears in `baseChecks` is
  // dropped from the appended set — the base (agent-returned) copy wins.
  // For built-ins this never collides (agent ids are sha1, user ids are
  // `USER-…`), but a custom category now sends its USER- checks to the
  // agent for evaluation; the agent echoes them back with the SAME id
  // and a real status, so the evaluated copy must override the static
  // overlay one rather than render twice.
  const buildChecks = (
    categoryId: string,
    baseChecks: AuditCheck[],
  ): AuditCheck[] => {
    const kept = baseChecks
      .filter((c) => !deleted.has(c.id))
      .map((c) => {
        const e = overlay.edits[c.id];
        if (!e) return c;
        return {
          ...c,
          ...(e.label !== undefined ? { label: e.label } : {}),
          ...(e.description !== undefined ? { description: e.description } : {}),
          ...(e.fixHint !== undefined ? { fixHint: e.fixHint } : {}),
        };
      });
    const keptIds = new Set(kept.map((c) => c.id));
    const added = (overlay.addedChecks[categoryId] ?? []).filter(
      (c) => !deleted.has(c.id) && !keptIds.has(c.id),
    );
    return [...kept, ...added];
  };

  const baseCategories = agentRun?.categories ?? [];
  // Name overrides for custom categories the user renamed after the last
  // run — the agent echoes back the category name it was given, which may
  // be stale, so the overlay's name takes precedence.
  const overlayNameById = new Map(
    overlay.addedCategories.map((c) => [c.id, c.name]),
  );
  const emittedIds = new Set<string>();
  const mergedCategories: AuditCategoryResult[] = [];

  // 1. Categories the agent returned — built-ins AND any custom category
  //    it evaluated this run.
  for (const cat of baseCategories) {
    if (deleted.has(cat.id)) continue;
    const checks = buildChecks(cat.id, cat.checks ?? []);
    const name = overlayNameById.get(cat.id) ?? cat.name;
    mergedCategories.push({
      ...cat,
      name,
      checks,
      score: computeCategoryScore(checks),
    });
    emittedIds.add(cat.id);
  }

  // 2. Custom categories that exist only in the overlay (just added, not
  //    yet evaluated by the agent). Skip any already emitted above so an
  //    evaluated custom category isn't duplicated.
  for (const cat of overlay.addedCategories) {
    if (deleted.has(cat.id) || emittedIds.has(cat.id)) continue;
    const checks = buildChecks(cat.id, cat.checks ?? []);
    mergedCategories.push({ ...cat, checks, score: computeCategoryScore(checks) });
    emittedIds.add(cat.id);
  }

  if (agentRun === null && overlay.addedCategories.length === 0) {
    return null;
  }

  const overall =
    mergedCategories.length > 0
      ? Math.round(
          mergedCategories.reduce((sum, c) => sum + c.score, 0) /
            mergedCategories.length,
        )
      : 0;

  return {
    runId: agentRun?.runId ?? `overlay-${overall}`,
    startedAt: agentRun?.startedAt ?? Date.now(),
    completedAt: agentRun?.completedAt,
    categories: mergedCategories,
    overall,
    rating: ratingFromScore(overall),
  };
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
