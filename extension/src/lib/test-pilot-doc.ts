// Pure helpers for Test Pilot catalog ↔ markdown / docx round-trips.
// Lives outside the state class so it can be unit-tested without
// booting the chrome.* API surface or Svelte's $state runtime.
//
// All functions are referentially transparent — same input, same
// output. The state class wraps them with persistence + companion
// disk-sync side effects.

import { zipSync, strToU8 } from "fflate";
import type {
  TestPilotCatalog,
  TestPilotSection,
  TestPilotTest,
} from "./state.svelte.js";

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
    out += `| ID | Test | Expected Result | Result |\n`;
    out += `|----|------|-----------------|--------|\n`;
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
      out += `| ${id} | ${test} | ${expected} | ${result} |\n`;
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

/** Minimum text-escape for XML body content. Order matters — & first
 *  so the &amp; we just inserted doesn't double-escape on the next
 *  pass. Newline & tab pass through; the calling code splits paragraphs
 *  via separate <w:p> elements rather than embedded breaks. */
function xmlEscape(s: string): string {
  return s
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
  return `<w:p><w:pPr><w:spacing w:before="${after}" w:after="${Math.floor(after / 2)}"/></w:pPr>${docxRun(text, { bold: true, sz })}</w:p>`;
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
export function composeTesterSheetDocx(catalog: TestPilotCatalog): Uint8Array {
  const body: string[] = [];

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

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join("")}</w:body>` +
    `</w:document>`;

  // OOXML minimum-viable layout: Content_Types + a root rel pointing
  // at word/document.xml. Word opens this and ignores the absence of
  // optional theme/styles/setting parts.
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "word/document.xml": strToU8(documentXml),
  });
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
        const [id, test, expected, result] = cells;
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
          current.tests.push({
            id,
            test,
            expected: expected ?? "",
            status,
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
