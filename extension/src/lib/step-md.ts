// Tiny markdown subset for Test Pilot step text and chat replies.
// Supports:
//  - inline `code` → { kind: "code" }
//  - inline **bold** / __bold__ → { kind: "bold" }
//  - fenced ```lang code blocks → { kind: "code", lang, body }
//  - `> Note: …` block-quote callouts → { kind: "note", body }
//  - `- item` / `* item` bullet lists, `1. item` numbered lists →
//    { kind: "list", ordered, items } — each item is parsed for inline
//    code + bold, so agent replies that pour out a long checklist
//    actually render as a checklist instead of a wall of text.
//  - `#` / `##` / `###` ... ATX-style headings → { kind: "heading",
//    level, parts } — without this, agent replies with structured
//    sections render the literal `###` as text instead of a title.
//  - plain text with inline code/bold interleaved → { kind: "text", parts }
//
// Output is a flat array of blocks rather than nested AST — the Svelte
// component iterates and renders each block kind directly.

export type InlinePart =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "bold"; value: string };

export type StepBlock =
  | { kind: "text"; parts: InlinePart[] }
  | { kind: "code"; lang: string; body: string }
  | { kind: "note"; parts: InlinePart[] }
  | { kind: "list"; ordered: boolean; items: InlinePart[][] }
  | { kind: "heading"; level: number; parts: InlinePart[] }
  | {
      /** Pipe-table — agent replies that compare values across columns
       *  ("Layer | Dark | Light" + token / hex rows) were rendering as
       *  a wall of literal `|` chars. Each cell carries its own inline
       *  parts so code refs + bold inside cells still render right. */
      kind: "table";
      headers: InlinePart[][];
      rows: InlinePart[][][];
    };

const FENCE_RE = /^```(\w*)\s*$/;
// Bullet list: `- foo` or `* foo`. The leading whitespace is allowed so
// nested bullets at least don't break the regex (we still render them
// flat — no indented sub-lists in v1).
const BULLET_RE = /^\s*[-*]\s+(.+)$/;
// Numbered list: `1. foo`, `42. foo`. Captures the body, not the index
// — we let the renderer pick the numbering scheme.
const NUMBERED_RE = /^\s*\d+\.\s+(.+)$/;
// ATX heading: 1-6 `#`s, a space, then the body. CommonMark also
// allows a trailing `#`s sequence; we strip those too so the rendered
// title doesn't show stray hashes. Captures the level (length of $1)
// and the body ($2).
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
// Table row: starts and ends with `|`, has at least one `|` separator
// inside. The leading/trailing pipes are optional per CommonMark but
// agents almost always include them; require them here for cheaper
// disambiguation against bullet lists that use `|` in body text.
const TABLE_ROW_RE = /^\s*\|.+\|\s*$/;
// Table separator row: `|---|---|...|` with optional `:` for alignment
// (left/right/center). We don't honor alignment in v1 — every column
// renders left-aligned — but tolerate the syntax so the row parses.
const TABLE_SEP_RE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

/** Split a `|`-delimited table row into cells. Strips the outer
 *  pipes, then splits on un-escaped pipes. Trims each cell.
 *  Unescapes `\|` back to `|` inside cells. */
function splitTableRow(line: string): string[] {
  // Drop leading/trailing pipe + surrounding whitespace.
  const inner = line.trim().replace(/^\||\|$/g, "");
  // Split on un-escaped pipes. Backslash-escaped \| stays in-cell.
  // Simple manual scan — regex with lookbehind is fussy across older
  // engines and we don't need fancy escape handling.
  const cells: string[] = [];
  let buf = "";
  for (let j = 0; j < inner.length; j++) {
    const ch = inner[j];
    if (ch === "\\" && inner[j + 1] === "|") {
      buf += "|";
      j++;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

export function parseStep(raw: string): StepBlock[] {
  const lines = raw.split(/\r?\n/);
  const blocks: StepBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        bodyLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      blocks.push({ kind: "code", lang, body: bodyLines.join("\n") });
      continue;
    }

    // Pipe-table. Two-line minimum: header row + separator row.
    // We peek one line ahead to confirm the separator before
    // committing — keeps a line like `| this is | not a table |`
    // (no separator following) from being misclassified.
    if (
      TABLE_ROW_RE.test(line) &&
      i + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[i + 1])
    ) {
      const headers = splitTableRow(line).map((c) => parseInline(c));
      i += 2; // skip header + separator
      const rows: InlinePart[][][] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        rows.push(splitTableRow(lines[i]).map((c) => parseInline(c)));
        i++;
      }
      blocks.push({ kind: "table", headers, rows });
      // Skip trailing blank so the next paragraph isn't glued to the
      // table's bottom edge.
      if (i < lines.length && lines[i].trim() === "") i++;
      continue;
    }

    // ATX heading. Must come before the paragraph branch so a line
    // starting with `###` doesn't get glued into the surrounding
    // text. Inline marks inside the heading text (code, bold) are
    // parsed too so `### **Important:** more` renders correctly.
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push({
        kind: "heading",
        level,
        parts: parseInline(heading[2]),
      });
      i++;
      // Skip a single trailing blank so the heading doesn't visually
      // crowd the next paragraph.
      if (i < lines.length && lines[i].trim() === "") i++;
      continue;
    }

    // Block-quote note callout — one or more consecutive `> ` lines.
    if (line.startsWith(">")) {
      const noteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        noteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "note", parts: parseInline(noteLines.join(" ")) });
      continue;
    }

    // List block — one or more consecutive bullet OR numbered lines.
    // A list breaks on the first non-list, non-empty line. Mixed bullet
    // / numbered runs collapse to one list using the first item's
    // ordering (rare in practice).
    const firstBullet = BULLET_RE.exec(line);
    const firstNumbered = NUMBERED_RE.exec(line);
    if (firstBullet || firstNumbered) {
      const ordered = !firstBullet && !!firstNumbered;
      const items: InlinePart[][] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const b = BULLET_RE.exec(cur);
        const n = NUMBERED_RE.exec(cur);
        if (!b && !n) break;
        items.push(parseInline((b?.[1] ?? n?.[1] ?? "").trim()));
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      // Skip a single trailing blank so the following paragraph isn't
      // glued onto the list visually.
      if (i < lines.length && lines[i].trim() === "") i++;
      continue;
    }

    // Plain paragraph — accumulate until blank line or a special line
    // (fence, blockquote, list, heading, table).
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE_RE.test(lines[i]) &&
      !lines[i].startsWith(">") &&
      !BULLET_RE.test(lines[i]) &&
      !NUMBERED_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !(TABLE_ROW_RE.test(lines[i]) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      blocks.push({ kind: "text", parts: parseInline(paraLines.join(" ")) });
    }
    // skip blank line
    if (i < lines.length && lines[i].trim() === "") i++;
  }

  return blocks;
}

// Inline grammar: backtick code, **bold**, __bold__ — interleaved with
// plain text. The combined regex is alternation-based so the leftmost
// match wins; nested marks (code inside bold, etc.) are intentionally
// NOT supported — agents almost never produce them and the simpler
// regex keeps parseInline allocation-free.
function parseInline(s: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /`([^`]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      parts.push({ kind: "text", value: s.slice(last, m.index) });
    }
    if (m[1] !== undefined) parts.push({ kind: "code", value: m[1] });
    else if (m[2] !== undefined) parts.push({ kind: "bold", value: m[2] });
    else if (m[3] !== undefined) parts.push({ kind: "bold", value: m[3] });
    last = m.index + m[0].length;
  }
  if (last < s.length) {
    parts.push({ kind: "text", value: s.slice(last) });
  }
  return parts;
}

