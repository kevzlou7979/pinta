// Pure helpers for the "file imported annotations as tracker issues"
// flow (WS3 — `op: "import-file-issues"`). Extracted from
// `ExtensionState.fileImportedToGitLab` / `handleImportedFileIssuesSync`
// so the payload shaping (incl. the token-economy caps) and the
// tolerant result parsing are unit-testable without booting the state
// class or the chrome.* surface.

import type { Annotation } from "@pinta/shared";
import { safeExternalUrl } from "../content/capture.js";

/** Hard cap on the free-text comment each item carries into the agent
 *  query. An imported `.pinta` is untrusted input and can be tens of
 *  MB — without a cap a single giant comment token-bombs the
 *  BYO-Claude run (nearby text is already capped at 200 chars). */
export const IMPORT_ISSUE_COMMENT_CAP = 4000;

/** One annotation flattened into the `import-file-issues` query
 *  payload. Token-lean: no base64, nearby text capped, comment capped. */
export type ImportFileIssueItem = {
  annotationId: string;
  kind: Annotation["kind"];
  comment: string;
  url: string;
  where: { selector?: string; text?: string };
  hasImages: boolean;
};

/** Where a filed annotation landed — mirrors the per-test Filed shape. */
export type ImportedFiledInfo = {
  target: "gitlab" | "local";
  url?: string;
  path?: string;
  title?: string;
  at: number;
};

/**
 * Build the per-annotation items for the `import-file-issues` query
 * comment. `sessionUrl` is the fallback page URL for annotations that
 * don't carry their own. Comments are sliced to
 * `IMPORT_ISSUE_COMMENT_CAP` chars with a visible truncation marker so
 * the agent knows text is missing rather than silently ending.
 */
export function buildImportFileIssueItems(
  annotations: Annotation[],
  sessionUrl: string,
): ImportFileIssueItem[] {
  return annotations.map((a) => {
    const t = a.targets?.[0] ?? a.target;
    const comment = a.comment ?? "";
    return {
      annotationId: a.id,
      kind: a.kind,
      comment:
        comment.length > IMPORT_ISSUE_COMMENT_CAP
          ? `${comment.slice(0, IMPORT_ISSUE_COMMENT_CAP)}…[truncated]`
          : comment,
      url: a.url ?? sessionUrl,
      where: {
        selector: t?.selector || undefined,
        text: t?.nearbyText?.join(" ").slice(0, 200) || undefined,
      },
      // Count only — per-annotation reference images stay out of the
      // query (token economy); noted v1 follow-up.
      hasImages: (a.images?.length ?? 0) > 0,
    };
  });
}

/**
 * Parse the agent's `imported-issues-filed` applied-summary payload
 * into per-annotation Filed markers. Returns `null` when the summary
 * isn't the expected envelope (malformed JSON, wrong `type`, missing
 * results array) — the caller shows the "restart /pinta" recovery
 * message. Individual malformed rows are skipped, valid ones kept.
 *
 * The payload came back from an agent run over untrusted imported
 * data, so every field is re-validated: `target` collapses to the
 * gitlab/local enum, and `url` goes through `safeExternalUrl`.
 */
export function parseImportedIssuesFiled(
  appliedSummary: string | undefined,
  now: number,
): Record<string, ImportedFiledInfo> | null {
  let payload: { [k: string]: unknown } | null = null;
  try {
    payload = JSON.parse(appliedSummary ?? "");
  } catch {
    payload = null;
  }
  const results =
    payload && payload.type === "imported-issues-filed"
      ? (payload.results as unknown)
      : null;
  if (!Array.isArray(results)) return null;
  // Null prototype — annotation ids come from untrusted imported data,
  // so an id like "__proto__" must land as an ordinary own property.
  const filed: Record<string, ImportedFiledInfo> = Object.create(null);
  for (const r of results) {
    if (!r || typeof r !== "object" || typeof r.annotationId !== "string") {
      continue;
    }
    filed[r.annotationId] = {
      target: r.target === "gitlab" ? "gitlab" : "local",
      url: safeExternalUrl(r.url),
      path: typeof r.path === "string" ? r.path : undefined,
      title: typeof r.title === "string" ? r.title : undefined,
      at: now,
    };
  }
  return filed;
}
