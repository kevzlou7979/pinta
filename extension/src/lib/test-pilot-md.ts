// Sign-off round-trip helpers — the frontmatter envelope that makes a
// Test Pilot markdown export re-importable without guesswork, plus the
// merge that overlays a returned tester run onto the developer's
// catalog by test id.
//
// Pure functions, no chrome.* / $state — unit-tested in
// test-pilot-md.test.ts. Frontmatter is parsed with a line-oriented
// regex on purpose: the envelope is a flat `key: value` list we author
// ourselves, so a YAML dependency would be dead weight.

import type {
  ChatMessage,
  TestPilotCatalog,
  TestPilotStatus,
} from "./state.svelte.js";
import { parseTestDocMarkdown } from "./test-pilot-doc.js";

/** Version marker in the frontmatter. Bump only on a breaking envelope
 *  change; the importer rejects files without it (they're plain test
 *  sheets, handled by the frontmatter-less path). */
export const PINTA_TEST_PILOT_MD_VERSION = "1";

/** Compact tester sign-off captured at results-export time. All values
 *  are single-line (newlines in notes are collapsed on compose). */
export type TestPilotSignoff = {
  tester: string;
  email?: string;
  /** YYYY-MM-DD */
  date: string;
  environment: string;
  /** What kind of pass this run was — "Smoke" | "Thorough" |
   *  "Regression" (free text tolerated on import). */
  runType?: string;
  notes?: string;
};

/** One line, frontmatter-safe: newlines collapse to spaces so every
 *  `key: value` stays a single line for the line-oriented parser. */
function flat(s: string): string {
  return s.replace(/\r?\n+/g, " ").trim();
}

/**
 * Compose the frontmatter envelope. Tester-sheet exports pass no
 * signoff (only the docId needs to survive the trip out and back);
 * results exports pass the filled sign-off form.
 */
export function composeFrontmatter(
  docId: string,
  signoff?: TestPilotSignoff,
): string {
  let out = `---\n`;
  out += `pinta-test-pilot: ${PINTA_TEST_PILOT_MD_VERSION}\n`;
  out += `doc-id: ${flat(docId)}\n`;
  if (signoff) {
    if (signoff.tester.trim()) out += `tester: ${flat(signoff.tester)}\n`;
    if (signoff.email?.trim()) out += `email: ${flat(signoff.email)}\n`;
    if (signoff.date.trim()) out += `date: ${flat(signoff.date)}\n`;
    if (signoff.environment.trim())
      out += `environment: ${flat(signoff.environment)}\n`;
    if (signoff.runType?.trim()) out += `run-type: ${flat(signoff.runType)}\n`;
    if (signoff.notes?.trim()) out += `notes: ${flat(signoff.notes)}\n`;
  }
  out += `---\n\n`;
  return out;
}

/**
 * Split a leading frontmatter block off the content. Returns
 * `meta: null` when there is no block (or it isn't `key: value`
 * shaped) — plain tester sheets and hand-written specs flow through
 * with `body === content`. Tolerates a UTF-8 BOM and CRLF endings
 * (files come back from Windows mail clients and Notepad edits).
 */
export function parseFrontmatter(content: string): {
  meta: Record<string, string> | null;
  body: string;
} {
  // Trailing blank lines after the closing fence belong to the
  // envelope (composeFrontmatter emits one), not the body.
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)*/.exec(content);
  if (!m) return { meta: null, body: content };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim();
  }
  if (Object.keys(meta).length === 0) return { meta: null, body: content };
  return { meta, body: content.slice(m[0].length) };
}

/** Read a sign-off out of parsed frontmatter, if one was recorded. */
function signoffFromMeta(
  meta: Record<string, string>,
): TestPilotSignoff | null {
  if (!meta["tester"]) return null;
  return {
    tester: meta["tester"],
    email: meta["email"] || undefined,
    date: meta["date"] ?? "",
    environment: meta["environment"] ?? "",
    runType: meta["run-type"] || undefined,
    notes: meta["notes"] || undefined,
  };
}

/**
 * Parse a Pinta-authored export (tester sheet or signed results) back
 * into a catalog. Returns `null` when the file has no
 * `pinta-test-pilot` frontmatter — the caller falls back to the
 * frontmatter-less import path (local parse or agent doc-parse).
 *
 * The crucial difference from a bare `parseTestDocMarkdown` call: the
 * `doc-id` from the frontmatter replaces the freshly-minted UUID, so
 * a results file can be matched back to the developer's catalog and
 * overlaid instead of replacing it.
 */
export function parsePintaResultsMarkdown(
  filename: string,
  content: string,
): { catalog: TestPilotCatalog; signoff: TestPilotSignoff | null } | null {
  const { meta, body } = parseFrontmatter(content);
  if (!meta || meta["pinta-test-pilot"] !== PINTA_TEST_PILOT_MD_VERSION) {
    return null;
  }
  // The results export leads with a "# Test Pilot results — …" title +
  // meta line; the tester sheet with the catalog title. Both parse.
  const catalog = parseTestDocMarkdown(filename, body);
  if (!catalog) return null;
  if (meta["doc-id"]) catalog.docId = meta["doc-id"];
  return { catalog, signoff: signoffFromMeta(meta) };
}

/**
 * Overlay a returned run's statuses onto the developer's catalog,
 * matching by test id across all sections. ONLY `status` moves — the
 * base catalog's structure, steps, chats, and metadata stay untouched
 * (the run came back through email as a flat sheet; the developer's
 * copy is richer).
 *
 * A matched row takes the run's status even when that status is
 * "untested" — the overlay shows the run as the tester left it, and
 * `clearImportedRun()` restores the developer's own marks from the
 * snapshot taken before the overlay.
 *
 * Returns the ids the run carried that the base doesn't know
 * (renamed/deleted rows, hand-edited files) so the import banner can
 * say so instead of silently dropping them.
 */
export function overlayResults(
  base: TestPilotCatalog,
  run: TestPilotCatalog,
): { applied: number; unknownIds: string[] } {
  const baseById = new Map<string, { status: TestPilotStatus }>();
  for (const s of base.sections) {
    for (const t of s.tests) baseById.set(t.id, t);
  }
  let applied = 0;
  const unknownIds: string[] = [];
  for (const s of run.sections) {
    for (const t of s.tests) {
      const target = baseById.get(t.id);
      if (target) {
        target.status = t.status;
        applied++;
      } else {
        unknownIds.push(t.id);
      }
    }
  }
  return { applied, unknownIds };
}

/**
 * Overlay a flat `{testId: status}` map onto the catalog — the `.pinta`
 * bundle variant of `overlayResults` (a bundle carries statuses only,
 * no catalog structure to synthesize). Same contract: statuses move,
 * structure/steps/chats stay, unknown ids are reported not dropped
 * silently.
 */
export function overlayStatusesById(
  base: TestPilotCatalog,
  statuses: Record<string, TestPilotStatus>,
): { applied: number; unknownIds: string[] } {
  const baseById = new Map<string, { status: TestPilotStatus }>();
  for (const s of base.sections) {
    for (const t of s.tests) baseById.set(t.id, t);
  }
  let applied = 0;
  const unknownIds: string[] = [];
  for (const [id, status] of Object.entries(statuses)) {
    const target = baseById.get(id);
    if (target) {
      target.status = status;
      applied++;
    } else {
      unknownIds.push(id);
    }
  }
  return { applied, unknownIds };
}

/**
 * Snapshot every row's status keyed by id — taken before an overlay so
 * Clear can put the developer's own marks back.
 *
 * Prototype-safe: the map is created with a null prototype so a test id
 * like `__proto__` or `constructor` becomes an ordinary own property
 * instead of silently hitting `Object.prototype` (a plain `{}` would
 * drop a `__proto__` assignment entirely).
 */
export function snapshotStatuses(
  catalog: TestPilotCatalog,
): Record<string, TestPilotStatus> {
  const out: Record<string, TestPilotStatus> = Object.create(null);
  for (const s of catalog.sections) {
    for (const t of s.tests) out[t.id] = t.status;
  }
  return out;
}

/** Restore a status snapshot taken by `snapshotStatuses`. Rows added
 *  after the snapshot keep their current status. Reads are guarded with
 *  an own-property check so a snapshot that round-tripped through
 *  JSON/storage (plain prototype again) can't leak `Object.prototype`
 *  members (`constructor`, …) into a row's status. */
export function restoreStatuses(
  catalog: TestPilotCatalog,
  statuses: Record<string, TestPilotStatus>,
): void {
  for (const s of catalog.sections) {
    for (const t of s.tests) {
      if (!Object.prototype.hasOwnProperty.call(statuses, t.id)) continue;
      const prior = statuses[t.id];
      if (prior !== undefined) t.status = prior;
    }
  }
}

/** One row's slice of the per-author `.results.{author}.json` disk
 *  sidecar (status + chat thread + cached detail steps). */
export type ResultsSidecarEntry = {
  status?: TestPilotStatus;
  chat?: ChatMessage[];
  detail?: { steps: string[]; askedAt: number };
};

/**
 * Merge the per-author disk results sidecar onto the catalog — the pure
 * core of `loadResultsFromCompanion`'s "disk wins" overlay.
 *
 * `skipStatuses` is the imported-run guard: while a tester's returned
 * run is overlaid (read-only banner showing), the STATUS portion of a
 * stale sidecar must not clobber the run's marks — only chat threads +
 * cached detail steps merge. With `skipStatuses: false` everything
 * merges (the normal recovery path).
 *
 * Returns how many rows changed status so the caller can decide whether
 * a re-persist is worth it.
 */
export function overlayResultsSidecar(
  catalog: TestPilotCatalog,
  results: Record<string, ResultsSidecarEntry>,
  opts: { skipStatuses?: boolean } = {},
): { statusesApplied: number } {
  let statusesApplied = 0;
  for (const section of catalog.sections) {
    for (const t of section.tests) {
      if (!Object.prototype.hasOwnProperty.call(results, t.id)) continue;
      const r = results[t.id];
      if (!r || typeof r !== "object") continue;
      if (!opts.skipStatuses && r.status) {
        if (t.status !== r.status) statusesApplied++;
        t.status = r.status;
      }
      if (r.chat) t.chat = r.chat;
      if (r.detail) t.detail = r.detail;
    }
  }
  return { statusesApplied };
}

/** Human-readable sign-off block for the results markdown body (the
 *  frontmatter is for machines; this is for the developer reading the
 *  file in a diff / mail preview). */
export function renderSignoffBlock(signoff: TestPilotSignoff): string {
  const bits: string[] = [`**Sign-off** — ${signoff.tester}`];
  if (signoff.email?.trim()) bits.push(signoff.email.trim());
  if (signoff.environment.trim()) bits.push(signoff.environment.trim());
  if (signoff.runType?.trim()) bits.push(`${signoff.runType.trim()} run`);
  if (signoff.date.trim()) bits.push(signoff.date.trim());
  let out = bits.join(" · ") + "\n";
  if (signoff.notes?.trim()) out += `\n> ${flat(signoff.notes)}\n`;
  return out + "\n";
}
