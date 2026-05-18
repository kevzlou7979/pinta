// Tiny markdown subset for Test Pilot step text. Supports:
//  - inline `code` → <span class="inline-code">…</span>
//  - fenced ```lang code blocks → { kind: "code", lang, body }
//  - `> Note: …` block-quote callouts → { kind: "note", body }
//  - plain text with inline code interleaved → { kind: "text", parts }
//
// Output is a flat array of blocks rather than nested AST — the Svelte
// component iterates and renders each block kind directly.

export type InlinePart =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string };

export type StepBlock =
  | { kind: "text"; parts: InlinePart[] }
  | { kind: "code"; lang: string; body: string }
  | { kind: "note"; parts: InlinePart[] };

const FENCE_RE = /^```(\w*)\s*$/;

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

    // Plain paragraph — accumulate until blank line or a special line.
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE_RE.test(lines[i]) &&
      !lines[i].startsWith(">")
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

function parseInline(s: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      parts.push({ kind: "text", value: s.slice(last, m.index) });
    }
    parts.push({ kind: "code", value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) {
    parts.push({ kind: "text", value: s.slice(last) });
  }
  return parts;
}

