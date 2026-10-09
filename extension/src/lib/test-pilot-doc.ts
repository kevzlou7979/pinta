// Pure helpers for Test Pilot catalog ↔ markdown / docx round-trips.
// Lives outside the state class so it can be unit-tested without
// booting the chrome.* API surface or Svelte's $state runtime.
//
// All functions are referentially transparent — same input, same
// output. The state class wraps them with persistence + companion
// disk-sync side effects.

import type {
  CatalogRevision,
  TestPilotCatalog,
  TestPilotSection,
  TestPilotTest,
} from "./state.svelte.js";
// Type-only — erased at compile time, so no runtime cycle with
// test-pilot-md.ts (which imports parseTestDocMarkdown from here).
import type { TestPilotSignoff } from "./test-pilot-md.js";
import {
  failureNotesDigest,
  isFailureNoteImage,
  notesForExport,
  splitSteps,
} from "./failure-notes.js";

/**
 * Compose a catalog back into the markdown shape the agent emits on
 * `op: "doc-parse"` / `op: "generate-doc"`. The companion writes this
 * to `.pinta/test-docs/{docId}.md` whenever the user edits the catalog
 * (Phase 13). Idempotent — a fresh `doc-parse` of the output should
 * yield an equivalent catalog (id-keyed comparison).
 *
 * Escaping: pipes (`|`) in table cells get backslash-escaped; newlines
 * in test text / expected text collapse to spaces so each row stays
 * one markdown table row.
 */
/** Rows-by-id, flattened across sections. */
function testsById(catalog: TestPilotCatalog | null | undefined) {
  const map = new Map<string, TestPilotTest>();
  for (const section of catalog?.sections ?? []) {
    for (const test of section.tests) map.set(test.id, test);
  }
  return map;
}

/** Wording key for change detection — whitespace-insensitive so a
 *  reflowed cell doesn't read as a rewrite. */
function wordingOf(test: TestPilotTest): string {
  return `${test.test} ${test.expected}`.replace(/\s+/g, " ").trim();
}

/**
 * Phase 21 — what a regenerate actually did to the catalog, computed
 * locally from the two id-keyed row sets. The agent spends no tokens
 * on this: it already returns the whole catalog, and ids are its
 * primary keys (SKILL 7.10.1b).
 */
export function diffCatalogs(
  prior: TestPilotCatalog | null | undefined,
  next: TestPilotCatalog,
): { added: string[]; changed: string[]; removed: string[] } {
  const before = testsById(prior);
  const after = testsById(next);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [id, test] of after) {
    const was = before.get(id);
    if (!was) added.push(id);
    else if (wordingOf(was) !== wordingOf(test)) changed.push(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push(id);
  }
  return { added, changed, removed };
}

/** True when a diff is worth minting a new revision for. */
export function isEmptyDiff(diff: {
  added: string[];
  changed: string[];
  removed: string[];
}): boolean {
  return (
    diff.added.length === 0 &&
    diff.changed.length === 0 &&
    diff.removed.length === 0
  );
}

/** Newest-last revision log, capped so chrome.storage stays small. */
export const REVISION_LOG_LIMIT = 20;

export function appendRevision(
  log: CatalogRevision[] | undefined,
  entry: CatalogRevision,
): CatalogRevision[] {
  return [...(log ?? []), entry].slice(-REVISION_LOG_LIMIT);
}

export function composeTestDocMarkdown(catalog: TestPilotCatalog): string {
  const heading = catalog.title?.trim() || catalog.filename;
  let out = `# ${heading}\n\n`;
  if (catalog.author?.trim()) out += `_By ${catalog.author.trim()}_\n\n`;
  if (catalog.description?.trim()) {
    out += `${catalog.description.trim()}\n\n`;
  }
  for (const section of catalog.sections) {
    out += `## ${section.title}\n\n`;
    // Four columns: the Result column survives a chrome.storage wipe
    // because the disk file IS the recovery path. On re-import, the
    // agent's doc-parse handler (SKILL.md §7.10.1) reads the Result
    // column and restores Pass/Fail marks alongside the structure.
    // Phase 21 — the Rev column carries provenance through the same
    // disk-is-the-recovery-path route as Result. The agent is told to
    // copy it verbatim on rows it leaves alone (SKILL 7.10.1b).
    out += `| ID | Test | Expected Result | Result | Rev |\n`;
    out += `|----|------|-----------------|--------|-----|\n`;
    for (const t of section.tests) {
      const id = t.id.replace(/\|/g, "\\|");
      const test = t.test.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const expected = t.expected
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      // Status glyphs match the in-app legend so the on-disk MD reads
      // naturally as a sign-off artifact (the user can copy / paste
      // / pandoc → PDF without further formatting).
      const result =
        t.status === "pass"
          ? "✓ Pass"
          : t.status === "fail"
            ? "✗ Fail"
            : "";
      const rev = t.lastChangedRev ?? t.firstSeenRev ?? "";
      out += `| ${id} | ${test} | ${expected} | ${result} | ${rev} |\n`;
    }
    out += `\n`;
  }
  return out;
}

/**
 * Compute the next `USER-N` id across the catalog. Walks every section
 * and parses any existing `USER-<digits>` ids — returns one above the
 * max, or `USER-1` for a fresh catalog. Collisions are impossible by
 * construction.
 *
 * The `USER-*` prefix is contractual with the skill's regen logic
 * (SKILL.md §7.10.1b) — the agent preserves these rows verbatim on
 * regenerate so user-added scenarios survive.
 */
export function nextUserTestId(catalog: TestPilotCatalog): string {
  let max = 0;
  for (const section of catalog.sections) {
    for (const t of section.tests) {
      const m = /^USER-(\d+)$/.exec(t.id);
      if (m) {
        const n = parseInt(m[1]!, 10);
        if (n > max) max = n;
      }
    }
  }
  return `USER-${max + 1}`;
}

/** One failed row selected for bulk issue-filing — the flattened shape
 *  `fileFailedTestsToGitLab` ships to the agent per test. */
export type UnfiledFailure = {
  id: string;
  section: string;
  test: string;
  expected: string;
  /** The tester's failure notes as plain text (no screenshots — the
   *  agent run stays cheap). Absent when the row has none. */
  notes?: string;
};

/**
 * Failed rows that don't have an issue filed yet — the universe the
 * bulk "file failed tests" flow operates on. When `selectedIds` is
 * given (the UI's checkbox sheet), only those unfiled failures are
 * kept; omitted → all of them. Pure — extracted from
 * `ExtensionState.fileFailedTestsToGitLab` for direct unit coverage.
 */
export function selectUnfiledFailures(
  catalog: TestPilotCatalog,
  filedIssues: Record<string, unknown>,
  selectedIds?: string[],
): UnfiledFailure[] {
  const failed = catalog.sections.flatMap((s) =>
    s.tests
      .filter((t) => t.status === "fail")
      .map((t) => {
        const notes = failureNotesDigest(t.failNotes ?? []);
        return {
          id: t.id,
          section: s.title,
          test: t.test,
          expected: t.expected,
          ...(notes ? { notes } : {}),
        };
      }),
  );
  let unfiled = failed.filter(
    (t) => !Object.prototype.hasOwnProperty.call(filedIssues, t.id),
  );
  if (selectedIds) {
    const wanted = new Set(selectedIds);
    unfiled = unfiled.filter((t) => wanted.has(t.id));
  }
  return unfiled;
}

// ─────────────────────────────────────────────────────────────────────
// Tester sheet — export with embedded steps, Result column blank
// ─────────────────────────────────────────────────────────────────────

/**
 * Compose a "tester sheet" markdown: catalog structure + the agent's
 * Help-generated steps per test, with the Result column intentionally
 * blank so an external tester (typically running standalone Pinta, or
 * just reading the .md / .docx in Word) fills in Pass/Fail as they go.
 *
 * Differs from `composeTestDocMarkdown` in two ways: (a) the Result
 * column is empty regardless of current `t.status`, and (b) a per-test
 * "Steps" block follows each section table for any row whose detail
 * cache is populated. Rows without cached steps emit a single
 * "_(no steps yet)_" line so the section's appendix structure stays
 * predictable for the local parser on re-import.
 */
export function composeTesterSheetMarkdown(catalog: TestPilotCatalog): string {
  const heading = catalog.title?.trim() || catalog.filename;
  let out = `# ${heading}\n\n`;
  if (catalog.author?.trim()) out += `_By ${catalog.author.trim()}_\n\n`;
  if (catalog.description?.trim()) {
    out += `${catalog.description.trim()}\n\n`;
  }
  out += `> **Tester instructions:** Walk through each test in order. Follow the numbered steps under "Steps" for each row, verify the expected result, then mark the **Result** column with ✓ Pass or ✗ Fail. Save the file and return it when you're done.\n\n`;
  for (const section of catalog.sections) {
    out += `## ${section.title}\n\n`;
    out += `| ID | Test | Expected Result | Result |\n`;
    out += `|----|------|-----------------|--------|\n`;
    for (const t of section.tests) {
      const id = t.id.replace(/\|/g, "\\|");
      const test = t.test.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const expected = t.expected
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
      // Result column intentionally blank — tester fills it.
      out += `| ${id} | ${test} | ${expected} |  |\n`;
    }
    out += `\n### Steps\n\n`;
    for (const t of section.tests) {
      const headerName = t.test.replace(/\n/g, " ").trim() || "(untitled)";
      out += `#### ${t.id} — ${headerName}\n\n`;
      if (t.detail && t.detail.steps.length > 0) {
        t.detail.steps.forEach((step, i) => {
          // Collapse newlines inside a step so each one stays a single
          // numbered list item. Preserves inline markdown (backticks,
          // bold, etc.) for the human reader / pandoc conversion.
          const flat = step.replace(/\r?\n+/g, " ").trim();
          out += `${i + 1}. ${flat}\n`;
        });
      } else {
        out += `_(no steps generated yet — ask the developer to run "Ask for steps" on this row.)_\n`;
      }
      out += `\n`;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// DOCX — hand-rolled OOXML so testers can double-click the file and
// open it in Word without any pandoc / command-line step. Uses the
// already-bundled `fflate` for the zip layer; no new npm deps.
// ─────────────────────────────────────────────────────────────────────

/** Minimum text-escape for XML body content. We first DROP characters
 *  that are illegal in XML 1.0, then escape the five XML metacharacters
 *  (& first so the &amp; we insert doesn't double-escape). Tab, LF and
 *  CR pass through; the calling code splits paragraphs via separate
 *  <w:p> elements rather than embedded breaks.
 *
 *  The illegal-char strip is load-bearing, not cosmetic: a single bad
 *  char (e.g. a form-feed or vertical-tab pasted into a test's
 *  expected-result, or pulled in from agent-generated steps) makes
 *  `word/document.xml` not well-formed. Word then renders only up to
 *  that byte and silently drops the rest of the document — which is how
 *  a tester-sheet export ends up truncated mid-section with later
 *  sections missing entirely.
 *
 *  Iterating with for..of walks whole code points, so valid astral
 *  characters (emoji, encoded as surrogate PAIRS) survive while LONE
 *  surrogates — equally not well-formed — are dropped. */
function xmlEscape(s: string): string {
  let clean = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    // XML 1.0 Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] |
    //                  [#xE000-#xFFFD] | [#x10000-#x10FFFF]
    const legal =
      cp === 0x9 ||
      cp === 0xa ||
      cp === 0xd ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    if (legal) clean += ch;
  }
  return clean
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Render a single text run inside a paragraph. `sz` is in OOXML
 *  half-points (so `sz: 32` = 16pt). `bold` toggles `<w:b/>`. Empty
 *  string is allowed — Word renders it as a zero-width run, useful
 *  for paragraph-only formatting. */
function docxRun(text: string, opts: { bold?: boolean; sz?: number; color?: string } = {}): string {
  const props: string[] = [];
  if (opts.bold) props.push(`<w:b/>`);
  if (opts.sz != null) props.push(`<w:sz w:val="${opts.sz}"/>`);
  if (opts.color) props.push(`<w:color w:val="${opts.color}"/>`);
  const rPr = props.length > 0 ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  // xml:space="preserve" keeps leading/trailing whitespace inside the
  // run — without it Word collapses to a single space and labels like
  // "ID:  AUTH-01" lose their gap.
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

/** Strip the minimal markdown we know agent-generated steps use, so
 *  the DOCX output reads as plain prose rather than literal asterisks
 *  + backticks. NOT a full markdown renderer — this is a one-pass
 *  scrub for the common cases the agent emits. */
function stripBasicMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

function docxParagraph(text: string, opts: { bold?: boolean; sz?: number; spaceAfter?: number } = {}): string {
  const spacing = opts.spaceAfter != null ? `<w:pPr><w:spacing w:after="${opts.spaceAfter}"/></w:pPr>` : "";
  return `<w:p>${spacing}${docxRun(text, opts)}</w:p>`;
}

function docxHeading(text: string, level: 1 | 2 | 3 | 4): string {
  // Sizes in half-points: H1 32 (16pt), H2 28 (14pt), H3 24 (12pt),
  // H4 22 (11pt). Slight bump above body so the document hierarchy
  // reads clearly when Word opens the file.
  const sz = level === 1 ? 36 : level === 2 ? 30 : level === 3 ? 26 : 22;
  const after = level === 1 ? 240 : level === 2 ? 200 : 160;
  // The outline level makes the heading real without a styles.xml: Word's
  // navigation pane lists it, and docx-to-md.ts reads the level back
  // exactly instead of guessing from the bold size.
  return `<w:p><w:pPr><w:spacing w:before="${after}" w:after="${Math.floor(after / 2)}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>${docxRun(text, { bold: true, sz })}</w:p>`;
}

/** Table cell with inline padding + a thin border. Width is in
 *  twentieths of a point — 5000 = 250pt, sized so a 4-column table
 *  spans the page comfortably at default margins. */
function docxCell(text: string, width: number, opts: { bold?: boolean } = {}): string {
  const props =
    `<w:tcPr>` +
    `<w:tcW w:w="${width}" w:type="dxa"/>` +
    `<w:tcBorders>` +
    `<w:top w:val="single" w:sz="4" w:color="888888"/>` +
    `<w:left w:val="single" w:sz="4" w:color="888888"/>` +
    `<w:bottom w:val="single" w:sz="4" w:color="888888"/>` +
    `<w:right w:val="single" w:sz="4" w:color="888888"/>` +
    `</w:tcBorders>` +
    `</w:tcPr>`;
  const para = `<w:p>${docxRun(text, { bold: opts.bold, sz: 20 })}</w:p>`;
  return `<w:tc>${props}${para}</w:tc>`;
}

function docxRow(cells: string[]): string {
  return `<w:tr>${cells.join("")}</w:tr>`;
}

/**
 * The Markdown export's frontmatter envelope, on one small grey line above
 * the title. A Word file has no frontmatter, so without this a .docx that
 * comes back to Test Pilot has no doc-id: results would replace the
 * developer's catalog instead of overlaying it. Same keys, same order as
 * `composeFrontmatter` (test-pilot-md.ts) — `recoverPintaFrontmatter`
 * (docx-to-md.ts) turns the line back into the envelope on import.
 */
function docxEnvelope(docId: string, signoff?: TestPilotSignoff, scope?: string): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const bits = ["pinta-test-pilot: 1", `doc-id: ${flat(docId)}`];
  if (scope && scope !== "all") bits.push(`scope: ${flat(scope)}`);
  if (signoff) {
    if (signoff.tester.trim()) bits.push(`tester: ${flat(signoff.tester)}`);
    if (signoff.email?.trim()) bits.push(`email: ${flat(signoff.email)}`);
    if (signoff.date.trim()) bits.push(`date: ${flat(signoff.date)}`);
    if (signoff.environment.trim()) bits.push(`environment: ${flat(signoff.environment)}`);
    if (signoff.runType?.trim()) bits.push(`run-type: ${flat(signoff.runType)}`);
    if (signoff.notes?.trim()) bits.push(`notes: ${flat(signoff.notes)}`);
  }
  // One key per line (soft breaks inside one paragraph): the reader then
  // takes each line as exactly one pair, whatever the value contains.
  const runs = bits
    .map((bit, i) => `<w:r><w:rPr><w:sz w:val="14"/><w:color w:val="999999"/></w:rPr>${i > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${xmlEscape(bit)}</w:t></w:r>`)
    .join("");
  return `<w:p>${runs}</w:p>`;
}

/**
 * Compose a hand-rolled DOCX from the catalog. Output is a Uint8Array
 * of zip bytes — the caller wraps it in a Blob with the
 * `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
 * MIME type and triggers a download via the standard anchor-click
 * pattern.
 *
 * Layout mirrors the tester-sheet markdown: title, by-line, tester
 * instructions, then per-section heading + 4-col table + numbered
 * steps. Result column kept empty so the tester fills as they go.
 *
 * No styles.xml — we use direct formatting (size + bold) on each run
 * so the rendered hierarchy doesn't depend on a built-in style being
 * present in Word's normal.dotx.
 */
export async function composeTesterSheetDocx(
  catalog: TestPilotCatalog,
  /** Phase 21 scope token when the sheet covers part of the catalog. */
  scope?: string,
): Promise<Uint8Array> {
  const body: string[] = [];
  body.push(docxEnvelope(catalog.docId, undefined, scope));

  const title = catalog.title?.trim() || catalog.filename;
  body.push(docxHeading(title, 1));
  if (catalog.author?.trim()) {
    body.push(
      `<w:p>${docxRun(`By ${catalog.author.trim()}`, { sz: 22, color: "555555" })}</w:p>`,
    );
  }
  if (catalog.description?.trim()) {
    body.push(docxParagraph(catalog.description.trim(), { sz: 22 }));
  }
  body.push(
    docxParagraph(
      `Tester instructions: Walk through each test in order. Follow the numbered steps under each test, verify the expected result, then mark the Result column with ✓ Pass or ✗ Fail. Save the file and return it when you're done.`,
      { sz: 20, spaceAfter: 240 },
    ),
  );

  for (const section of catalog.sections) {
    body.push(docxHeading(section.title, 2));
    // 4-column table widths (dxa = twentieths of a point). Tuned so
    // ID is narrow, Test + Expected take the bulk, Result reads as a
    // signing box.
    const widths = [1200, 4200, 4200, 1400];
    // Header row
    body.push(
      `<w:tbl>` +
        `<w:tblPr><w:tblW w:w="11000" w:type="dxa"/></w:tblPr>` +
        `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
        docxRow([
          docxCell("ID", widths[0]!, { bold: true }),
          docxCell("Test", widths[1]!, { bold: true }),
          docxCell("Expected Result", widths[2]!, { bold: true }),
          docxCell("Result", widths[3]!, { bold: true }),
        ]) +
        section.tests
          .map((t: TestPilotTest) =>
            docxRow([
              docxCell(t.id, widths[0]!),
              docxCell(t.test.replace(/\n/g, " "), widths[1]!),
              docxCell(t.expected.replace(/\n/g, " "), widths[2]!),
              docxCell("", widths[3]!),
            ]),
          )
          .join("") +
        `</w:tbl>`,
    );

    // Steps block per test
    body.push(docxHeading(`Steps`, 3));
    for (const t of section.tests) {
      const name = t.test.replace(/\n/g, " ").trim() || "(untitled)";
      body.push(docxHeading(`${t.id} — ${name}`, 4));
      if (t.detail && t.detail.steps.length > 0) {
        t.detail.steps.forEach((step, i) => {
          const clean = stripBasicMarkdown(step.replace(/\r?\n+/g, " ").trim());
          body.push(docxParagraph(`${i + 1}. ${clean}`, { sz: 20 }));
        });
      } else {
        body.push(
          `<w:p>${docxRun("(no steps generated yet — ask the developer to run \"Ask for steps\" on this row.)", { sz: 20, color: "888888" })}</w:p>`,
        );
      }
    }
  }

  return wrapDocxBody(body);
}

/**
 * Wrap an array of `<w:p>` / `<w:tbl>` body parts into a complete,
 * minimum-viable DOCX zip (Uint8Array). Shared by every DOCX composer
 * so the OOXML package boilerplate lives in exactly one place.
 *
 * Layout: `[Content_Types].xml` + a root rel pointing at
 * `word/document.xml`. Word opens this and ignores the absence of
 * optional theme/styles/setting parts.
 */
// fflate is loaded on demand (only when a .docx is actually exported) so
// it stays out of the side panel's startup bundle.
async function wrapDocxBody(
  body: string[],
  media: DocxMedia[] = [],
): Promise<Uint8Array> {
  const { zipSync, strToU8 } = await import("fflate");
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"` +
    ` xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<w:body>${body.join("")}</w:body>` +
    `</w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    (media.some((m) => m.ext === "png") ? `<Default Extension="png" ContentType="image/png"/>` : "") +
    (media.some((m) => m.ext === "jpeg") ? `<Default Extension="jpeg" ContentType="image/jpeg"/>` : "") +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "word/document.xml": strToU8(documentXml),
  };
  if (media.length > 0) {
    // Pictures are separate parts: the body references each by its
    // relationship id, and this file maps the id to the media part.
    files["word/_rels/document.xml.rels"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        media
          .map(
            (m) =>
              `<Relationship Id="${m.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.file}"/>`,
          )
          .join("") +
        `</Relationships>`,
    );
    for (const m of media) files[`word/media/${m.file}`] = m.bytes;
  }
  return zipSync(files);
}

/** A picture part of the DOCX package. */
type DocxMedia = {
  relId: string;
  /** File name under `word/media/`. */
  file: string;
  ext: "png" | "jpeg";
  bytes: Uint8Array;
};

/**
 * Pixel size of a PNG or JPEG read from its header — Word needs an
 * explicit extent for every picture. Returns null when the bytes are
 * not a readable PNG/JPEG, and the caller falls back to a placeholder
 * line instead of embedding a picture Word could not lay out.
 */
export function imageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  // PNG: 8-byte signature, then the IHDR chunk (width, height as BE u32).
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const u32 = (o: number) =>
      ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
    const width = u32(16);
    const height = u32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 8 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1]!;
      // Fill bytes before a marker.
      if (marker === 0xff) {
        i++;
        continue;
      }
      // Standalone markers carry no length.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
        const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Widest a picture is laid out, in EMU — 6 inches, the text width of a
 *  default Word page. Taller-than-a-page screenshots are capped too. */
const DOCX_IMAGE_MAX_W = 6 * 914400;
const DOCX_IMAGE_MAX_H = 8 * 914400;
/** 96 dpi pixels → EMU. */
const EMU_PER_PX = 9525;

/**
 * Inline picture paragraph for a `data:image/png|jpeg` URL. Registers
 * the bytes in `media` and returns the body XML, or null when the image
 * can't be embedded (bad base64, unreadable header).
 */
function docxImage(
  dataUrl: string,
  name: string,
  media: DocxMedia[],
): string | null {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(m[2]!);
  } catch {
    return null;
  }
  const size = imageDimensions(bytes);
  if (!size) return null;
  const n = media.length + 1;
  const ext = m[1] as "png" | "jpeg";
  const relId = `rIdImg${n}`;
  media.push({ relId, file: `image${n}.${ext}`, ext, bytes });
  let cx = size.width * EMU_PER_PX;
  let cy = size.height * EMU_PER_PX;
  const scale = Math.min(1, DOCX_IMAGE_MAX_W / cx, DOCX_IMAGE_MAX_H / cy);
  cx = Math.round(cx * scale);
  cy = Math.round(cy * scale);
  const alt = xmlEscape(name);
  return (
    `<w:p><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${n}" name="${alt}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${n}" name="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic>` +
    `</wp:inline></w:drawing></w:r></w:p>`
  );
}

/**
 * Compose a hand-rolled DOCX of the **results** (sign-off report) — the
 * DOCX twin of `ExtensionState.exportResults()`'s markdown. Mirrors that
 * layout exactly so the two formats read the same in Word vs a markdown
 * viewer: title, a meta by-line (run date + author + pass/fail/untested
 * tally), description, then per-section heading + 4-col table with the
 * Result column FILLED (✓ Pass / ✗ Fail / ⚠ Untested), followed by a
 * "Conversations" block listing each row's chat thread.
 *
 * `today` is injected (not read from the clock) so this stays a pure,
 * testable function — the state wrapper passes the formatted date.
 */
export function composeResultsDocx(
  catalog: TestPilotCatalog,
  today: string,
  signoff?: TestPilotSignoff,
  /** Phase 21 scope token when the run covered part of the catalog. */
  scope?: string,
): Promise<Uint8Array> {
  const body: string[] = [];
  const media: DocxMedia[] = [];
  body.push(docxEnvelope(catalog.docId, signoff, scope));

  let pass = 0,
    fail = 0,
    untested = 0;
  for (const s of catalog.sections) {
    for (const t of s.tests) {
      if (t.status === "pass") pass++;
      else if (t.status === "fail") fail++;
      else untested++;
    }
  }
  const total = pass + fail + untested;

  const title = catalog.title?.trim() || catalog.filename;
  body.push(docxHeading(`Test Pilot results — ${title}`, 1));

  const metaBits: string[] = [`Run on ${today}`];
  if (signoff?.tester.trim()) metaBits.push(`by ${signoff.tester.trim()}`);
  else if (catalog.author?.trim()) metaBits.push(`by ${catalog.author.trim()}`);
  metaBits.push(`${pass}/${total} passed, ${fail} failed, ${untested} untested`);
  body.push(
    `<w:p>${docxRun(metaBits.join(", "), { sz: 22, color: "555555" })}</w:p>`,
  );
  if (signoff) {
    // Sign-off block — Word twin of the markdown export's readable
    // sign-off lines, for the human reviewer. (What Pinta reads back on
    // import is the envelope line at the top, not this.)
    const bits: string[] = [signoff.tester.trim()];
    if (signoff.email?.trim()) bits.push(signoff.email.trim());
    if (signoff.environment.trim()) bits.push(signoff.environment.trim());
    if (signoff.runType?.trim()) bits.push(`${signoff.runType.trim()} run`);
    if (signoff.date.trim()) bits.push(signoff.date.trim());
    body.push(
      `<w:p>${docxRun("Sign-off: ", { bold: true, sz: 20 })}${docxRun(bits.filter(Boolean).join(" · "), { sz: 20 })}</w:p>`,
    );
    if (signoff.notes?.trim()) {
      body.push(
        docxParagraph(signoff.notes.replace(/\r?\n+/g, " ").trim(), {
          sz: 20,
          spaceAfter: 200,
        }),
      );
    }
  }
  if (catalog.description?.trim()) {
    body.push(docxParagraph(catalog.description.trim(), { sz: 22, spaceAfter: 240 }));
  }

  for (const section of catalog.sections) {
    body.push(docxHeading(section.title, 2));
    const widths = [1200, 4200, 4200, 1400];
    body.push(
      `<w:tbl>` +
        `<w:tblPr><w:tblW w:w="11000" w:type="dxa"/></w:tblPr>` +
        `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
        docxRow([
          docxCell("ID", widths[0]!, { bold: true }),
          docxCell("Test", widths[1]!, { bold: true }),
          docxCell("Expected Result", widths[2]!, { bold: true }),
          docxCell("Result", widths[3]!, { bold: true }),
        ]) +
        section.tests
          .map((t: TestPilotTest) => {
            const result =
              t.status === "pass"
                ? "✓ Pass"
                : t.status === "fail"
                  ? notesForExport(t).length > 0
                    ? "✗ Fail (see notes)"
                    : "✗ Fail"
                  : "⚠ Untested";
            return docxRow([
              docxCell(t.id, widths[0]!),
              docxCell(t.test.replace(/\n/g, " "), widths[1]!),
              docxCell(t.expected.replace(/\n/g, " "), widths[2]!),
              docxCell(result, widths[3]!),
            ]);
          })
          .join("") +
        `</w:tbl>`,
    );

    // Failure notes — one block per failed row that has any. Each
    // carries the test id + title and the expected result, so a note
    // still makes sense when it is copied out of the report on its own.
    const withNotes = section.tests.filter(
      (t: TestPilotTest) => notesForExport(t).length > 0,
    );
    if (withNotes.length > 0) {
      body.push(docxHeading("Failure notes", 3));
      for (const t of withNotes) {
        const notes = notesForExport(t);
        const name = t.test.replace(/\n/g, " ").trim() || "(untitled)";
        body.push(docxHeading(`${t.id} — ${name}`, 4));
        if (t.expected.trim()) {
          body.push(
            `<w:p>${docxRun("Expected: ", { bold: true, sz: 20 })}${docxRun(t.expected.replace(/\r?\n+/g, " ").trim(), { sz: 20 })}</w:p>`,
          );
        }
        notes.forEach((n, ni) => {
          if (notes.length > 1) {
            body.push(
              `<w:p>${docxRun(`Note ${ni + 1} of ${notes.length}`, { bold: true, sz: 20, color: "555555" })}</w:p>`,
            );
          }
          if (n.description.trim()) {
            body.push(`<w:p>${docxRun("Description", { bold: true, sz: 20 })}</w:p>`);
            for (const line of n.description.split(/\r?\n/)) {
              if (line.trim()) body.push(docxParagraph(line.trim(), { sz: 20 }));
            }
          }
          const steps = splitSteps(n.steps);
          if (steps.length > 0) {
            body.push(
              `<w:p>${docxRun("Steps to reproduce", { bold: true, sz: 20 })}</w:p>`,
            );
            steps.forEach((step, si) => {
              body.push(docxParagraph(`${si + 1}. ${step}`, { sz: 20 }));
            });
          }
          (n.images ?? []).forEach((im, ii) => {
            const label = im.name || `${t.id} screenshot ${ii + 1}`;
            const xml = isFailureNoteImage(im) ? docxImage(im.dataUrl, label, media) : null;
            body.push(
              xml ??
                `<w:p>${docxRun(`[image: ${label} — could not be embedded]`, { sz: 20, color: "888888" })}</w:p>`,
            );
          });
        });
      }
    }

    // Conversations block — only rows with a chat thread. Mirrors the
    // markdown export's per-section "Conversations" appendix.
    const withChat = section.tests.filter(
      (t: TestPilotTest) => Array.isArray(t.chat) && t.chat.length > 0,
    );
    if (withChat.length > 0) {
      body.push(docxHeading("Conversations", 3));
      for (const t of withChat) {
        body.push(docxHeading(`Conversation — ${t.id}`, 4));
        for (const m of t.chat!) {
          const who = m.role === "user" ? "tester: " : "agent: ";
          const text = stripBasicMarkdown(m.text.replace(/\r?\n+/g, " ").trim());
          body.push(
            `<w:p>${docxRun(who, { bold: true, sz: 20 })}${docxRun(text, { sz: 20 })}</w:p>`,
          );
        }
      }
    }
  }

  return wrapDocxBody(body, media);
}

// ─────────────────────────────────────────────────────────────────────
// Local markdown parser — used by standalone Pinta to import tester
// sheets / dev exports without round-tripping through the agent.
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse a Pinta-shaped test markdown back into a TestPilotCatalog.
 * Tolerates both the developer-export format (Result column carries
 * marks) and the tester-sheet format (Result blank + per-section
 * Steps appendix). Returns `null` if the input doesn't look like a
 * Pinta test doc at all — the caller can show an import error rather
 * than silently producing a garbage catalog.
 *
 * Grammar (line-oriented, two-line lookahead at most):
 *   # Title
 *   _By Author_
 *   {description paragraph}
 *   ## Section title
 *   | ID | Test | Expected Result | Result |
 *   |----|------|-----------------|--------|
 *   | id | test | expected | result |
 *   ### Steps
 *   #### {ID} — {name}
 *   1. step
 *   2. step
 *
 * Pass markers (✓, ✓ Pass, Pass) flip a row's status to "pass";
 * fail markers (✗, ✗ Fail, Fail) flip to "fail"; everything else
 * (including the blank tester-sheet column) stays "untested".
 */
export function parseTestDocMarkdown(
  filename: string,
  content: string,
): TestPilotCatalog | null {
  const lines = content.split(/\r?\n/);
  let title = "";
  let author: string | undefined;
  let description: string | undefined;
  const sections: TestPilotSection[] = [];
  let current: TestPilotSection | null = null;

  // Pass 1 — find the title heading. We expect it as the first non-empty
  // line; bail out early if the input doesn't begin with one because
  // it almost certainly isn't a Pinta doc.
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length) return null;
  const titleMatch = /^#\s+(.+?)\s*$/.exec(lines[i]!);
  if (!titleMatch) return null;
  title = titleMatch[1]!.trim();
  i++;

  // Optional author / description block — read until the first `##`.
  const preface: string[] = [];
  while (i < lines.length && !/^##\s+/.test(lines[i]!) && !/^#\s+/.test(lines[i]!)) {
    preface.push(lines[i]!);
    i++;
  }
  const prefaceJoined = preface.join("\n").trim();
  const byMatch = /^_By\s+(.+?)_\s*$/m.exec(prefaceJoined);
  if (byMatch) author = byMatch[1]!.trim();
  // Description: everything in preface that isn't the by-line OR the
  // tester-instructions blockquote.
  const descLines = prefaceJoined
    .split(/\r?\n/)
    .filter((l) => !/^_By\s+/.test(l))
    .filter((l) => !/^>\s+\*\*Tester instructions:/.test(l))
    .filter((l) => l.trim().length > 0);
  if (descLines.length > 0) {
    description = descLines.join("\n").trim();
    if (description === "") description = undefined;
  }

  // Main pass — sections, tables, and per-section Steps appendix.
  // `currentStepsTestId` is set when we cross "#### {ID}" and stays
  // pinned until the next "####" or a new section.
  let currentStepsTestId: string | null = null;
  let currentSteps: string[] = [];
  const flushSteps = () => {
    if (current && currentStepsTestId) {
      const t = current.tests.find((x) => x.id === currentStepsTestId);
      if (t && currentSteps.length > 0) {
        t.detail = { steps: [...currentSteps], askedAt: Date.now() };
      } else if (!t && currentSteps.length > 0) {
        // Step block referenced an ID with no matching table row —
        // tester likely renamed / deleted a row but kept its appendix,
        // or hand-edited the file inconsistently. Warn so the import
        // doesn't silently drop steps the developer expected to survive.
        // eslint-disable-next-line no-console
        console.warn(
          `[pinta] tester-sheet import: dropped ${currentSteps.length} step(s) ` +
            `for unknown test id "${currentStepsTestId}" in section "${current?.title ?? "?"}".`,
        );
      }
    }
    currentStepsTestId = null;
    currentSteps = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;
    // Section heading
    const sectionMatch = /^##\s+(?!#)(.+?)\s*$/.exec(line);
    if (sectionMatch) {
      flushSteps();
      current = { title: sectionMatch[1]!.trim(), tests: [] };
      sections.push(current);
      i++;
      continue;
    }
    // Steps subheading — just a marker, the per-test "####" lines
    // carry the data.
    if (/^###\s+Steps\s*$/.test(line)) {
      flushSteps();
      i++;
      continue;
    }
    // Per-test steps header "#### ID — name"
    const stepHeader = /^####\s+([A-Z0-9-]+(?:_\d+)?)\s*(?:[—\-–]\s*.*)?$/.exec(
      line,
    );
    if (stepHeader && current) {
      flushSteps();
      currentStepsTestId = stepHeader[1]!.trim();
      i++;
      continue;
    }
    // Numbered list item under an active steps header
    const stepItem = /^\s*\d+\.\s+(.+?)\s*$/.exec(line);
    if (stepItem && currentStepsTestId) {
      currentSteps.push(stepItem[1]!.trim());
      i++;
      continue;
    }
    // Table row — skip the header / separator, capture data rows.
    if (current && /^\s*\|/.test(line)) {
      if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) {
        // separator row
        i++;
        continue;
      }
      // Split on un-escaped pipes; trim each cell.
      const cells = line
        .replace(/^\s*\||\|\s*$/g, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.replace(/\\\|/g, "|").trim());
      if (cells.length >= 3) {
        const [id, test, expected, result, rev] = cells;
        // Skip the header row (matches the literal column names we emit)
        if (
          id?.toLowerCase() === "id" &&
          test?.toLowerCase() === "test"
        ) {
          i++;
          continue;
        }
        if (id && test) {
          // Result column: parse Pass / Fail / blank. Glyphs + literal
          // words both work so the tester can hand-edit the file.
          let status: TestPilotTest["status"] = "untested";
          const r = (result ?? "").trim().toLowerCase();
          if (r.includes("✓") || /\bpass\b/.test(r)) status = "pass";
          else if (r.includes("✗") || /\bfail\b/.test(r)) status = "fail";
          // Rev is optional — files written before Phase 21 (and
          // hand-edited ones) have no column, and those rows read as
          // revision 1.
          const revNum = Number.parseInt((rev ?? "").trim(), 10);
          current.tests.push({
            id,
            test,
            expected: expected ?? "",
            status,
            ...(Number.isFinite(revNum) && revNum > 0
              ? { firstSeenRev: revNum, lastChangedRev: revNum }
              : {}),
          });
        }
      }
      i++;
      continue;
    }
    i++;
  }
  flushSteps();

  // Sanity: a Pinta doc must have at least one section. If we parsed
  // nothing meaningful, give up so the caller can flag the file.
  if (sections.length === 0) return null;

  return {
    docId: crypto.randomUUID(),
    filename,
    title,
    author,
    description,
    sections,
    importedAt: Date.now(),
  };
}
