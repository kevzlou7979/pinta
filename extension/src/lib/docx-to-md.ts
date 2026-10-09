// .docx → Markdown, for Test Pilot import.
//
// Test Pilot reads Markdown. Sheets come back as Word files all the time:
// Google Drive converts an uploaded .md into a Google Doc and hands it
// back as .docx, testers save Pinta's own Word export, and hand-written
// test plans live in Word. This turns the document body into the same
// Markdown shape the existing import already understands (`# Title`,
// `## Section`, pipe tables, numbered steps), so everything downstream —
// the frontmatter envelope, the local parser, the agent's doc-parse —
// stays untouched.
//
// Deliberately small: headings, paragraphs, lists, tables, links and
// bold / italic / code runs. Images, comments, footnotes, text boxes and
// tracked deletions are dropped. A .docx is untrusted input: only the
// parts we read are inflated, each is size-capped, the XML reader is
// linear-time, and text Word hides from the reader is not passed on.

/** Thrown for files we can't read; `message` is safe to show the user. */
export class DocxImportError extends Error {
  override name = "DocxImportError";
}

/** Whole-file cap, checked by the caller before reading the bytes. */
export const MAX_DOCX_BYTES = 50 * 1024 * 1024;
/** Per-part caps. A real sheet's document.xml is well under 1 MB. */
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_PART_COMPRESSED = 2 * 1024 * 1024;
const MAX_DEPTH = 64;

const NBSP = String.fromCharCode(0xa0);
const NBSP_RE = new RegExp(NBSP, "g");

// ── Tiny XML reader ───────────────────────────────────────────────────
// WordprocessingML is machine-written, so a scanner is enough — and unlike
// DOMParser it behaves the same in the side panel and in the Node test
// runner. Every step advances with indexOf, so a malformed or hostile
// part costs linear time (an unterminated comment just ends the scan).

type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Character data — kept for <w:t> only, the one place it matters. */
  text: string;
};

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const cp =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      try {
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
      } catch {
        return whole;
      }
    }
    return ENTITY[body] ?? whole;
  });
}

const isSpace = (ch: string) => ch === " " || ch === "\n" || ch === "\t" || ch === "\r";

/** `name="value"` pairs, scanned by hand so a malformed tag costs
 *  linear time (a regex here backtracks quadratically on `aaaa…=`). */
function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const n = src.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(src[i]!)) i++;
    const nameAt = i;
    while (i < n && src[i] !== "=" && !isSpace(src[i]!)) i++;
    const name = src.slice(nameAt, i);
    while (i < n && isSpace(src[i]!)) i++;
    if (i >= n || src[i] !== "=") {
      if (i === nameAt) i++; // never stall on an unexpected character
      continue;
    }
    i++;
    while (i < n && isSpace(src[i]!)) i++;
    const quote = src[i];
    if (quote !== '"' && quote !== "'") continue;
    const end = src.indexOf(quote, i + 1);
    if (end === -1) break;
    if (name) attrs[name] = decodeEntities(src.slice(i + 1, end));
    i = end + 1;
  }
  return attrs;
}

/** Collapse soft line breaks (and the space around them) to one space.
 *  Split-and-trim, not a `\s*\n\s*` regex — that one is quadratic on a
 *  long run of spaces. */
function oneLine(s: string): string {
  return s.includes("\n")
    ? s
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ")
    : s;
}

function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1]!;
    const lt = xml.indexOf("<", i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i && top.tag === "w:t") top.text += decodeEntities(xml.slice(i, textEnd));
    if (lt === -1) break;
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      if (e === -1) break;
      i = e + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9);
      if (e === -1) break;
      if (top.tag === "w:t") top.text += xml.slice(lt + 9, e);
      i = e + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const e = xml.indexOf("?>", lt + 2);
      if (e === -1) break;
      i = e + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      const e = xml.indexOf(">", lt + 2);
      if (e === -1) break;
      i = e + 1;
      continue;
    }
    // A tag ends at the first `>` outside a quoted attribute value.
    let j = lt + 1;
    let quote = "";
    for (; j < n; j++) {
      const ch = xml[j]!;
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    if (j >= n) break;
    const raw = xml.slice(lt + 1, j);
    i = j + 1;
    if (raw[0] === "/") {
      // Tolerate a stray close tag rather than failing the whole file.
      if (stack.length > 1 && top.tag === raw.slice(1).trim()) stack.pop();
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const name = /^[A-Za-z_][\w:.-]*/.exec(body)?.[0];
    if (!name) continue;
    const node: XmlNode = { tag: name, attrs: parseAttrs(body.slice(name.length)), children: [], text: "" };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function child(n: XmlNode | undefined, tag: string): XmlNode | undefined {
  return n?.children.find((c) => c.tag === tag);
}

function descend(n: XmlNode | undefined, ...tags: string[]): XmlNode | undefined {
  let cur = n;
  for (const t of tags) cur = child(cur, t);
  return cur;
}

/** OOXML on/off properties: present = on unless val is 0 / false / none. */
function isOn(n: XmlNode | undefined): boolean {
  if (!n) return false;
  const v = (n.attrs["w:val"] ?? "").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "none";
}

// ── Document model lookups ────────────────────────────────────────────

type ListLevel = { ordered: boolean; start: number };

type DocxContext = {
  /** styleId → heading level (1–6); 0 marks the document "Title". */
  headingByStyle: Map<string, number>;
  /** `${numId}:${ilvl}` → list level definition. */
  lists: Map<string, ListLevel>;
  /** relationship id → external URL. */
  links: Map<string, string>;
  /** A non-empty Title-styled paragraph exists (shifts Heading N down). */
  hasTitle: boolean;
  /** The document uses real heading styles (turns the bold-size guess off). */
  usesHeadingStyles: boolean;
  /** Running counters for numbered lists: numId → ilvl → last number. */
  counters: Map<string, Map<number, number>>;
  /** The document carries Pinta's envelope line (it is a Pinta export). */
  pintaExport: boolean;
  /** ilvl of the first item of the list run being emitted, or null. */
  listBase: number | null;
  /** Paragraphs seen by the survey pass. */
  surveyed: number;
  /** Inside a results export's "Failure notes" block. */
  inFailureNotes: boolean;
  /** A styled heading has been emitted (see levelFromFormatting). */
  seenStyledHeading: boolean;
};

function readStyles(xml: string | undefined, ctx: DocxContext): void {
  // Built-in ids are stable in English-language exports (Google Docs,
  // most Word installs); <w:name> covers localized ones, and basedOn
  // covers custom styles derived from a heading.
  for (let i = 1; i <= 6; i++) ctx.headingByStyle.set(`Heading${i}`, i);
  ctx.headingByStyle.set("Title", 0);
  if (!xml) return;
  const styles = child(parseXml(xml), "w:styles");
  const basedOn = new Map<string, string>();
  for (const s of styles?.children ?? []) {
    if (s.tag !== "w:style" || s.attrs["w:type"] !== "paragraph") continue;
    const id = s.attrs["w:styleId"];
    if (!id) continue;
    const name = (child(s, "w:name")?.attrs["w:val"] ?? "").toLowerCase().trim();
    const parent = child(s, "w:basedOn")?.attrs["w:val"];
    if (parent) basedOn.set(id, parent);
    const h = /^heading\s*([1-6])$/.exec(name);
    if (h) ctx.headingByStyle.set(id, Number(h[1]));
    else if (name === "title") ctx.headingByStyle.set(id, 0);
    else {
      const lvl = descend(s, "w:pPr", "w:outlineLvl")?.attrs["w:val"];
      const n = lvl === undefined ? NaN : Number(lvl);
      if (Number.isFinite(n) && n >= 0 && n <= 5 && !ctx.headingByStyle.has(id)) {
        ctx.headingByStyle.set(id, n + 1);
      }
    }
  }
  for (const id of basedOn.keys()) {
    if (ctx.headingByStyle.has(id)) continue;
    let cur: string | undefined = id;
    for (let hop = 0; hop < 12 && cur !== undefined; hop++) {
      cur = basedOn.get(cur);
      if (cur !== undefined && ctx.headingByStyle.has(cur)) {
        ctx.headingByStyle.set(id, ctx.headingByStyle.get(cur)!);
        break;
      }
    }
  }
}

function readNumbering(xml: string | undefined, ctx: DocxContext): void {
  if (!xml) return;
  const numbering = child(parseXml(xml), "w:numbering");
  if (!numbering) return;
  const abstract = new Map<string, Map<string, ListLevel>>();
  for (const a of numbering.children) {
    if (a.tag !== "w:abstractNum") continue;
    const levels = new Map<string, ListLevel>();
    for (const lvl of a.children) {
      if (lvl.tag !== "w:lvl") continue;
      // No numFmt means decimal (the schema default), not a bullet.
      const fmt = child(lvl, "w:numFmt")?.attrs["w:val"] ?? "decimal";
      const start = Number(child(lvl, "w:start")?.attrs["w:val"]);
      // Word has nine list levels (0–8); anything else is not a real list.
      if (!/^[0-8]$/.test(lvl.attrs["w:ilvl"] ?? "0")) continue;
      levels.set(lvl.attrs["w:ilvl"] ?? "0", {
        ordered: fmt !== "bullet" && fmt !== "none",
        start: Number.isFinite(start) && start >= 0 && start < 100000 ? start : 1,
      });
    }
    abstract.set(a.attrs["w:abstractNumId"] ?? "", levels);
  }
  for (const num of numbering.children) {
    if (num.tag !== "w:num") continue;
    const numId = num.attrs["w:numId"] ?? "";
    const levels = abstract.get(child(num, "w:abstractNumId")?.attrs["w:val"] ?? "");
    for (const [ilvl, def] of levels ?? []) ctx.lists.set(`${numId}:${ilvl}`, def);
  }
}

/** Keep a URL from breaking out of `[text](url)`. */
function safeHref(target: string): string | null {
  // Only web / mail links survive — never a javascript: or file: URL.
  if (!/^(https?:|mailto:)/i.test(target) || /[<>"`\\]/.test(target)) return null;
  return target.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function readLinks(xml: string | undefined, ctx: DocxContext): void {
  if (!xml) return;
  const rels = child(parseXml(xml), "Relationships");
  for (const r of rels?.children ?? []) {
    if (r.tag !== "Relationship" || r.attrs["TargetMode"] !== "External") continue;
    const href = safeHref(r.attrs["Target"] ?? "");
    if (r.attrs["Id"] && href) ctx.links.set(r.attrs["Id"], href);
  }
}

// ── Inline runs ───────────────────────────────────────────────────────

type Span = { text: string; bold: boolean; italic: boolean; code: boolean; href?: string; sz?: number };

const MONO_FONT = /courier|consolas|menlo|monaco|mono|source code/i;

/** Wingdings glyphs testers type into a Result cell. */
const WINGDINGS: Record<string, string> = { F0FC: "✓", F0FE: "✓", F0FB: "✗", F0FD: "✗" };

function runSpan(run: XmlNode, href: string | undefined): Span | null {
  const rPr = child(run, "w:rPr");
  // Word hides this text from the person reading the document; passing it
  // on would let a sheet carry instructions its reviewer never saw.
  if (isOn(child(rPr, "w:vanish")) || isOn(child(rPr, "w:webHidden"))) return null;
  const szRaw = Number(child(rPr, "w:sz")?.attrs["w:val"] || NaN);
  const sz = Number.isFinite(szRaw) && szRaw > 0 ? szRaw : undefined;
  // 1pt text is unreadable on the page — same treatment as hidden text.
  if (sz !== undefined && sz <= 2) return null;
  let text = "";
  for (const c of run.children) {
    if (c.tag === "w:t") text += c.text;
    else if (c.tag === "w:tab") text += " ";
    else if (c.tag === "w:br" || c.tag === "w:cr") {
      // A page / column break is layout, not content.
      if (!c.attrs["w:type"] || c.attrs["w:type"] === "textWrapping") text += "\n";
    } else if (c.tag === "w:noBreakHyphen") text += "-";
    else if (c.tag === "w:sym") text += WINGDINGS[(c.attrs["w:char"] ?? "").toUpperCase()] ?? "";
  }
  if (text === "") return null;
  const fonts = child(rPr, "w:rFonts");
  const font = fonts?.attrs["w:ascii"] ?? fonts?.attrs["w:hAnsi"] ?? "";
  const style = child(rPr, "w:rStyle")?.attrs["w:val"] ?? "";
  return {
    text,
    bold: isOn(child(rPr, "w:b")),
    italic: isOn(child(rPr, "w:i")),
    code: MONO_FONT.test(font) || /code/i.test(style),
    href,
    sz,
  };
}

const RUN_CONTAINERS = new Set(["w:ins", "w:moveTo", "w:smartTag", "w:sdt", "w:sdtContent", "w:fldSimple"]);

function collectSpans(node: XmlNode, ctx: DocxContext, href: string | undefined, out: Span[], depth = 0): void {
  if (depth > MAX_DEPTH) return;
  for (const c of node.children) {
    if (c.tag === "w:r") {
      const s = runSpan(c, href);
      if (s) out.push(s);
    } else if (c.tag === "w:hyperlink") {
      collectSpans(c, ctx, ctx.links.get(c.attrs["r:id"] ?? "") ?? href, out, depth + 1);
    } else if (RUN_CONTAINERS.has(c.tag)) {
      collectSpans(c, ctx, href, out, depth + 1);
    }
    // w:del / w:moveFrom (tracked deletions), comments, bookmarks: dropped.
  }
}

function plainOf(spans: Span[]): string {
  return spans.map((s) => s.text).join("").replace(NBSP_RE, " ");
}

/** Wrap `text` in a marker, keeping edge whitespace outside it
 *  (`** bold**` doesn't render as bold in Markdown). */
function wrap(text: string, open: string, close: string): string {
  const core = text.trim();
  if (!core) return text;
  const lead = text.length - text.trimStart().length;
  return `${text.slice(0, lead)}${open}${core}${close}${text.slice(lead + core.length)}`;
}

function renderSpans(spans: Span[]): string {
  // Merge neighbours that share formatting so a word split across runs
  // (Word does this constantly) doesn't become `**Ex****pected**`.
  const merged: Span[] = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (prev && prev.bold === s.bold && prev.italic === s.italic && prev.code === s.code && prev.href === s.href) {
      prev.text += s.text;
    } else {
      merged.push({ ...s });
    }
  }
  let out = "";
  for (const s of merged) {
    let t = s.text.replace(NBSP_RE, " ");
    if (s.code) t = wrap(t, "`", "`");
    else {
      if (s.italic) t = wrap(t, "_", "_");
      if (s.bold) t = wrap(t, "**", "**");
    }
    if (s.href && t.trim()) t = wrap(t, "[", `](${s.href})`);
    out += t;
  }
  return out;
}

// ── Blocks ────────────────────────────────────────────────────────────

/**
 * Heading level guessed from direct formatting — a whole line in one bold
 * size — for documents that don't mark headings any other way. Pinta's
 * Word exports before the outline level was added look like this
 * (36 / 30 / 26 / 22 half-points for H1–H4).
 *
 * `loose` is true for a Pinta export or a document with no heading styles
 * at all: every size band counts. In a document that DOES use heading
 * styles only a clearly oversized line (14pt+) counts, so its bold
 * lead-ins ("Expected result:") and bold dates stay bold text.
 */
function levelFromFormatting(spans: Span[], loose: boolean, afterStyledHeading: boolean): number {
  if (spans.length === 0 || !spans.every((s) => s.bold)) return 0;
  const sz = spans[0]!.sz;
  if (sz === undefined || !spans.every((s) => s.sz === sz)) return 0;
  const text = plainOf(spans).trim();
  // In a styled document a big bold line is usually a callout or a cover
  // word ("IMPORTANT: use the VPN", "CONFIDENTIAL"): it must come after
  // the first real heading and not read like a sentence or a label.
  if (!loose && (!afterStyledHeading || /[.:!?]$/.test(text))) return 0;
  if (sz >= 34) return 1;
  if (sz >= 28) return 2;
  if (!loose) return 0;
  // 12pt bold is also how people write a lead-in label.
  if (sz >= 24) return text.length > 160 || /:$/.test(text) ? 0 : 3;
  // H4 shares its size with body text — only "ID — name" step headers
  // (written with a dash, as Pinta does) count.
  if (sz >= 21 && sz <= 23) return /^[A-Z0-9][A-Z0-9-]*(?:_\d+)?\s*[—–]\s*\S/.test(text) ? 4 : 0;
  return 0;
}

/** `<w:outlineLvl>` set on the paragraph itself: 0–5 are heading levels
 *  1–6 (9 is body text). Pinta's Word export writes it on every heading. */
function outlineLevel(p: XmlNode): number {
  const raw = descend(p, "w:pPr", "w:outlineLvl")?.attrs["w:val"];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n + 1 : 0;
}

function isRule(p: XmlNode): boolean {
  // Google Docs writes a horizontal rule as a VML <v:rect o:hr="t">.
  const stack = [p];
  let guard = 0;
  while (stack.length && guard++ < 2000) {
    const n = stack.pop()!;
    if (n.attrs["o:hr"] === "t" || n.attrs["o:hr"] === "true") return true;
    for (const c of n.children) stack.push(c);
  }
  return false;
}

function styleLevel(p: XmlNode, ctx: DocxContext): number | undefined {
  const id = descend(p, "w:pPr", "w:pStyle")?.attrs["w:val"];
  return id === undefined ? undefined : ctx.headingByStyle.get(id);
}

function paragraphToMd(p: XmlNode, ctx: DocxContext): string {
  const pPr = child(p, "w:pPr");
  const spans: Span[] = [];
  collectSpans(p, ctx, undefined, spans);
  const plain = plainOf(spans);
  if (plain.trim() === "") return isRule(p) ? "---" : "";

  const numPr = child(pPr, "w:numPr");
  const numId = child(numPr, "w:numId")?.attrs["w:val"];
  // Clamped to Word's nine levels, which also bounds the per-list counters.
  const ilvl = Math.min(8, Math.max(0, Math.trunc(Number(child(numPr, "w:ilvl")?.attrs["w:val"] ?? "0")) || 0));
  const numbered = !!numPr && numId !== undefined && numId !== "0";
  // An item restarts the numbering of the levels beneath it — including
  // a numbered heading, which Word treats as the list's top level.
  const restartDeeper = () => {
    const levels = numbered ? ctx.counters.get(numId!) : undefined;
    if (!levels) return;
    for (const lv of [...levels.keys()]) if (lv > ilvl) levels.delete(lv);
  };

  let level = -1;
  const styled = styleLevel(p, ctx);
  if (styled !== undefined) {
    level = styled === 0 ? 1 : ctx.hasTitle ? Math.min(6, styled + 1) : styled;
  } else {
    const loose = ctx.pintaExport || !ctx.usesHeadingStyles;
    const l = (loose ? outlineLevel(p) : 0) || levelFromFormatting(spans, loose, ctx.seenStyledHeading);
    if (l > 0) level = l;
  }
  if (level > 0) {
    restartDeeper();
    ctx.listBase = null;
    if (styled !== undefined) ctx.seenStyledHeading = true;
    const text = oneLine(plain).trim();
    // F-5: only Pinta's results export has this block; in any other
    // document "Failure notes" is just a heading.
    if (level <= 3) {
      ctx.inFailureNotes =
        level === 3 && (ctx.pintaExport || !ctx.usesHeadingStyles) && /^failure notes$/i.test(text);
    }
    return `${"#".repeat(level)} ${text}`;
  }
  // A results export lists each failed test's notes under "ID — name"
  // headings, the same shape as a tester sheet's how-to steps. Quote the
  // block (as the Markdown export does) so the repro steps in a failure
  // note are not read back as that test's how-to steps.
  if (ctx.inFailureNotes) {
    ctx.listBase = null;
    return renderSpans(spans)
      .split("\n")
      .map((l) => `> ${l.trim()}`)
      .join("\n");
  }

  if (numbered) {
    restartDeeper();
    const key = `${numId}:${ilvl}`;
    // Indent relative to where this run of items started: an absolute
    // ilvl would turn a list that begins at level 2 into a code block.
    if (ctx.listBase === null || ilvl < ctx.listBase) ctx.listBase = ilvl;
    const indent = "  ".repeat(Math.min(6, ilvl - ctx.listBase));
    const body = oneLine(renderSpans(spans)).trim();
    const def = ctx.lists.get(key);
    if (def?.ordered) {
      let levels = ctx.counters.get(numId!);
      if (!levels) ctx.counters.set(numId!, (levels = new Map()));
      const n = levels.has(ilvl) ? levels.get(ilvl)! + 1 : def.start;
      levels.set(ilvl, n);
      return `${indent}${n}. ${body}`;
    }
    return `${indent}- ${body}`;
  }

  ctx.listBase = null;
  const trimmed = plain.trim();
  // Pinta's Word export writes this as a plain paragraph; give it back
  // the Markdown shape the sheet parser recognises.
  const tester = /^Tester instructions:\s*([\s\S]*)$/.exec(trimmed);
  if (tester) return `> **Tester instructions:** ${oneLine(tester[1]!).trim()}`;
  return renderSpans(spans)
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

function cellText(tc: XmlNode, ctx: DocxContext): string {
  const parts: string[] = [];
  const walk = (n: XmlNode, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const c of n.children) {
      if (c.tag === "w:p") {
        const spans: Span[] = [];
        collectSpans(c, ctx, undefined, spans);
        const t = oneLine(plainOf(spans)).trim();
        if (t) parts.push(t);
      } else if (c.tag === "w:tbl" || c.tag === "w:tr" || c.tag === "w:tc" || c.tag === "w:sdt" || c.tag === "w:sdtContent") {
        walk(c, depth + 1);
      }
    }
  };
  walk(tc, 0);
  // Cells are plain text on purpose: the sheet parser matches ids and
  // "ID" / "Test" headers literally, and emphasis markers would break that.
  return parts.join(" ").replace(/\\+$/, "").replace(/\|/g, "\\|");
}

function rowCells(tr: XmlNode, ctx: DocxContext): string[] {
  const cells: string[] = [];
  const add = (tc: XmlNode) => {
    cells.push(cellText(tc, ctx));
    // A merged cell spans several grid columns; pad so later cells stay
    // under their own header.
    const span = Number(descend(tc, "w:tcPr", "w:gridSpan")?.attrs["w:val"]);
    for (let k = 1; Number.isFinite(span) && k < Math.min(span, 32); k++) cells.push("");
  };
  for (const c of tr.children) {
    if (c.tag === "w:tc") add(c);
    else if (c.tag === "w:sdt") {
      for (const inner of child(c, "w:sdtContent")?.children ?? []) if (inner.tag === "w:tc") add(inner);
    }
  }
  return cells;
}

function tableToMd(tbl: XmlNode, ctx: DocxContext): string {
  const rows: string[][] = [];
  const addRow = (tr: XmlNode) => {
    const cells = rowCells(tr, ctx);
    if (cells.length > 0) rows.push(cells);
  };
  for (const c of tbl.children) {
    if (c.tag === "w:tr") addRow(c);
    else if (c.tag === "w:sdt") {
      for (const inner of child(c, "w:sdtContent")?.children ?? []) if (inner.tag === "w:tr") addRow(inner);
    }
  }
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  // A one-column table is a layout box (Google Docs wraps code and
  // callouts in them), not data — read it as paragraphs.
  if (width === 1) return rows.map((r) => r[0]!).filter(Boolean).join("\n\n");
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

function blocksOf(container: XmlNode, ctx: DocxContext, out: string[], depth = 0): void {
  if (depth > MAX_DEPTH) return;
  for (const c of container.children) {
    if (c.tag === "w:p") out.push(paragraphToMd(c, ctx));
    else if (c.tag === "w:tbl") {
      ctx.listBase = null;
      out.push(tableToMd(c, ctx));
    } else if (c.tag === "w:sdt") {
      const inner = child(c, "w:sdtContent");
      if (inner) blocksOf(inner, ctx, out, depth + 1);
    }
  }
}

/** One pass over the body's own paragraphs to learn how the document is
 *  styled, so every heading is read by the same rule. */
function surveyBody(body: XmlNode, ctx: DocxContext, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  for (const c of body.children) {
    if (c.tag === "w:p") {
      const level = styleLevel(c, ctx);
      // Only the opening paragraphs can be the envelope line; reading
      // every paragraph's text here would double the conversion work.
      const nearTop = ctx.surveyed++ < 4;
      if (level === undefined && !nearTop) continue;
      const spans: Span[] = [];
      collectSpans(c, ctx, undefined, spans);
      const text = plainOf(spans).trim();
      if (nearTop && /^pinta-test-pilot:\s*\S/.test(text)) ctx.pintaExport = true;
      // An empty Title paragraph (Word leaves them behind) is not a title.
      if (level === undefined || text === "") continue;
      ctx.usesHeadingStyles = true;
      if (level === 0) ctx.hasTitle = true;
    } else if (c.tag === "w:sdt") {
      const inner = child(c, "w:sdtContent");
      if (inner) surveyBody(inner, ctx, depth + 1);
    }
  }
}

// ── Pinta frontmatter recovery ────────────────────────────────────────

/** Envelope keys, in the order `composeFrontmatter` writes them. */
const FM_KEYS = ["pinta-test-pilot", "doc-id", "scope", "tester", "email", "date", "environment", "run-type", "notes"];
const FM_KEY_RE = new RegExp(`(?:^|\\s)(${FM_KEYS.join("|")}):\\s*`, "g");

/** True when the text already opens with a well-formed Pinta envelope:
 *  `---`, only `key: value` / blank lines, `---` — with the marker key. */
function hasIntactEnvelope(md: string): boolean {
  const lines = (md.charCodeAt(0) === 0xfeff ? md.slice(1) : md).split(/\r?\n/, 40);
  if (lines[0] !== "---") return false;
  let marker = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "---") return marker;
    if (line.trim() === "") continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) return false;
    if (kv[1] === "pinta-test-pilot") marker = true;
  }
  return false;
}

/**
 * Rebuild the `---` envelope Pinta puts on its Markdown exports. A trip
 * through Google Docs destroys it: the opening fence becomes a horizontal
 * rule and the `key: value` lines plus the closing fence become ONE
 * heading ("pinta-test-pilot: 1 doc-id: … "), because that is how
 * Markdown reads text followed by `---`. Pinta's Word exports carry the
 * same keys on one line above the title. Without the envelope the doc-id
 * is lost and a returned results file can't be matched to its catalog.
 *
 * Everything before the first `# ` title is searched. Keys are accepted
 * only in the order Pinta writes them, so a value that happens to contain
 * "date:" or "notes:" stays part of its value, and `notes` — always last —
 * takes the rest of the line.
 */
export function recoverPintaFrontmatter(md: string): string {
  if (hasIntactEnvelope(md)) return md;
  // The title is the first `# ` line that isn't the envelope itself (a
  // converter may hand the envelope back as a level-1 heading).
  const h1 = /^# (.*)$/gm;
  let title: RegExpExecArray | null = null;
  for (let m = h1.exec(md); m; m = h1.exec(md)) {
    if (m[1]!.trim() && !/pinta-test-pilot:/.test(m[1]!)) {
      title = m;
      break;
    }
  }
  if (!title || title.index === 0) return md;
  const head = md.slice(0, title.index);
  if (!/(?:^|\s)pinta-test-pilot:\s*\S/.test(head)) return md;
  const lines = head
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|---+[ \t]*$|\*\*\*+[ \t]*$|>[ \t]?)/gm, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rebuild = (meta: Map<string, string>) => {
    let out = "---\n";
    for (const k of FM_KEYS) {
      const v = meta.get(k);
      if (v) out += `${k}: ${v}\n`;
    }
    return `${out}---\n\n${md.slice(title!.index)}`;
  };
  // One key per line (how Pinta's Word export writes it): each line is
  // exactly one pair, so a value may contain anything — even "notes:".
  const perLine = new Map<string, string>();
  const allPairs = lines.every((l) => {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(l);
    if (!kv || !FM_KEYS.includes(kv[1]!)) return false;
    if (kv[2] && !perLine.has(kv[1]!)) perLine.set(kv[1]!, kv[2]!);
    return true;
  });
  // …but only when the lines have the shape Pinta writes: a bare version
  // number and a doc-id with no spaces. A hand-edited head that packs
  // several keys onto one line goes through the ordered scan instead.
  if (
    allPairs &&
    lines.length > 1 &&
    /^\d+$/.test(perLine.get("pinta-test-pilot") ?? "") &&
    /^\S+$/.test(perLine.get("doc-id") ?? "")
  ) {
    return rebuild(perLine);
  }
  // Everything on one line (what Google Docs leaves behind).
  const flat = lines.join(" ").replace(/\s+/g, " ").trim();
  const hits: { key: string; start: number; valueAt: number }[] = [];
  let next = 0;
  FM_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (next < FM_KEYS.length && (m = FM_KEY_RE.exec(flat))) {
    const at = FM_KEYS.indexOf(m[1]!);
    if (at < next) continue;
    hits.push({ key: m[1]!, start: m.index, valueAt: m.index + m[0].length });
    next = at + 1;
  }
  const meta = new Map<string, string>();
  hits.forEach((h, i) => {
    const value = flat.slice(h.valueAt, hits[i + 1]?.start ?? flat.length).trim();
    if (value) meta.set(h.key, value);
  });
  if (!meta.get("pinta-test-pilot")) return md;
  return rebuild(meta);
}

/**
 * Put the title first. Word plans often carry a cover line, a date or a
 * "CONFIDENTIAL" banner above the title; the sheet parser expects the
 * document to open with its `# Title`. Whatever sat above it moves to
 * just under it (where it reads as the description). A Pinta envelope is
 * left exactly where it is.
 */
function titleFirst(md: string): string {
  if (hasIntactEnvelope(md)) return md;
  const m = /^# .*$/m.exec(md);
  if (!m || m.index === 0) return md;
  const above = md.slice(0, m.index).trim();
  if (!above) return md.slice(m.index);
  return `${m[0]}\n\n${above}${md.slice(m.index + m[0].length)}`;
}

// ── Entry points ──────────────────────────────────────────────────────

/** Convert the XML parts of a .docx to Markdown (pure — unit-tested). */
export function docxPartsToMarkdown(parts: {
  document: string;
  numbering?: string;
  styles?: string;
  rels?: string;
}): string {
  const ctx: DocxContext = {
    headingByStyle: new Map(),
    lists: new Map(),
    links: new Map(),
    hasTitle: false,
    usesHeadingStyles: false,
    counters: new Map(),
    pintaExport: false,
    listBase: null,
    surveyed: 0,
    inFailureNotes: false,
    seenStyledHeading: false,
  };
  readStyles(parts.styles, ctx);
  readNumbering(parts.numbering, ctx);
  readLinks(parts.rels, ctx);

  const body = descend(parseXml(parts.document), "w:document", "w:body");
  if (!body) throw new DocxImportError("This Word file has no readable text.");
  surveyBody(body, ctx);

  const blocks: string[] = [];
  blocksOf(body, ctx, blocks);

  // Pinta's Word export writes the by-line as plain "By Name" right under
  // the title; the sheet parser reads it as `_By Name_`.
  const live = blocks.filter(Boolean);
  const titleAt = live.findIndex((b) => /^# \S/.test(b));
  const byLine = titleAt >= 0 ? live[titleAt + 1] : undefined;
  const nameShaped = (s: string) =>
    s
      .split(/\s+/)
      .slice(1)
      .every((w) => /^[\p{Lu}\d(]/u.test(w) || /^(?:de|del|der|van|von|la|le|da|dos|bin|al|and|&)$/i.test(w));
  if (
    byLine &&
    /^By\s+\S[^\n]{0,58}$/.test(byLine) &&
    !/[!?:]$/.test(byLine) &&
    byLine.split(/\s+/).length <= 6 &&
    (ctx.pintaExport || nameShaped(byLine))
  ) {
    blocks[blocks.indexOf(byLine)] = `_${byLine}_`;
  }

  let md = "";
  let prev = "";
  for (const b of blocks) {
    if (!b) continue;
    // Keep consecutive list items and literal `| row |` lines together
    // (a doc holding un-rendered Markdown has one paragraph per line).
    const tight =
      prev !== "" &&
      ((/^\s*(?:[-*]|\d+\.)\s/.test(b) && /^\s*(?:[-*]|\d+\.)\s/.test(prev)) ||
        (/^\s*\|/.test(b) && /^\s*\|/.test(prev) && !b.includes("\n") && !prev.includes("\n")));
    md += (md === "" ? "" : tight ? "\n" : "\n\n") + b;
    prev = b;
  }
  if (md.trim() === "") throw new DocxImportError("This Word file has no readable text.");
  return titleFirst(recoverPintaFrontmatter(`${md}\n`));
}

function decodeXml(bytes: Uint8Array, utf8: (b: Uint8Array) => string): string {
  // Word writes UTF-8; a few tools write UTF-16 with a byte-order mark.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  return utf8(bytes);
}

/**
 * Read a .docx (zip bytes) and return its body as Markdown. Throws
 * {@link DocxImportError} with a user-facing message when the file isn't
 * a Word document or can't be read.
 */
export async function docxToMarkdown(bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_DOCX_BYTES) throw new DocxImportError("This Word file is too large to import.");
  // Every .docx is a zip: "PK\x03\x04". An old binary .doc, a PDF renamed
  // to .docx, or a Google Docs shortcut all fail here with a clear message.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new DocxImportError(
      "This isn't a Word .docx file. Old .doc files and Google Docs shortcuts can't be read — download it as .docx or Markdown.",
    );
  }
  const { unzipSync, strFromU8 } = await import("fflate");
  let tooBig = false;
  // Inflate only the named parts, each at most once (a crafted archive can
  // list one entry thousands of times) and only within the size caps. A
  // compressed size larger than the declared size is a lying header.
  const unzip = (wanted: Set<string>, required?: string): Record<string, Uint8Array> => {
    const seen = new Set<string>();
    try {
      return unzipSync(bytes, {
        filter: (f) => {
          if (!wanted.has(f.name) || seen.has(f.name)) return false;
          seen.add(f.name);
          // A stored (uncompressed) entry is as big as its content, so the
          // compressed cap only applies to deflated ones.
          const stored = f.compression === 0;
          if (f.originalSize > MAX_PART_BYTES || (!stored && f.size > MAX_PART_COMPRESSED) || f.size > f.originalSize + 1024) {
            // Only the body is required; an oversized styles / numbering
            // part is skipped and the document still imports.
            if (f.name === required) tooBig = true;
            return false;
          }
          return true;
        },
      });
    } catch {
      throw new DocxImportError("Couldn't open this Word file — it looks damaged. Try downloading it again.");
    }
  };

  // The package says where its main part lives; almost always
  // word/document.xml, but not for every producer.
  let main = "word/document.xml";
  const rootRels = unzip(new Set(["_rels/.rels"]))["_rels/.rels"];
  if (rootRels) {
    const rels = child(parseXml(decodeXml(rootRels, strFromU8)), "Relationships");
    const office = rels?.children.find((r) => r.tag === "Relationship" && /\/officeDocument$/.test(r.attrs["Type"] ?? ""));
    const target = office?.attrs["Target"]?.replace(/^\/+/, "");
    if (target && /^[\w./-]+\.xml$/.test(target) && !target.includes("..")) main = target;
  }
  const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/") + 1) : "";
  const base = main.slice(dir.length);
  const numbering = `${dir}numbering.xml`;
  const styles = `${dir}styles.xml`;
  const rels = `${dir}_rels/${base}.rels`;

  const files = unzip(new Set([main, numbering, styles, rels]), main);
  if (tooBig) throw new DocxImportError("This Word file is too large to import.");
  const doc = files[main];
  if (!doc) {
    throw new DocxImportError("This isn't a Word document Pinta can read (no document body inside).");
  }
  const part = (name: string) => (files[name] ? decodeXml(files[name]!, strFromU8) : undefined);
  try {
    return docxPartsToMarkdown({
      document: decodeXml(doc, strFromU8),
      numbering: part(numbering),
      styles: part(styles),
      rels: part(rels),
    });
  } catch (err) {
    if (err instanceof DocxImportError) throw err;
    throw new DocxImportError("Couldn't read this Word file. Try exporting it as Markdown instead.");
  }
}
