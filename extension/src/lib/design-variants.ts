// Pure helpers for Design Variants (Phase 22). Extracted from
// state.svelte.ts (pattern: audit-flow.ts) so they unit-test without the
// chrome.* surface or Svelte's $state runtime.
//
// SECURITY NOTE — this module owns `sanitizeVariantHtml`, the inbound
// sanitizer for agent-generated HTML. That HTML crosses a NEW trust edge
// (agent → user's live page / extension iframe). It must be run:
//   1. before building a sandboxed iframe srcdoc (page-scope cards, the
//      full-screen preview page) — defense in depth;
//   2. before rendering into a shadow root: element cards in the side
//      panel and "Preview on page" / the match check on the live page
//      (load-bearing — neither has a sandbox).
// Keep it allowlist-shaped and boring. If you extend it, extend the tests.

import type { AnnotationTarget } from "@pinta/shared";

// ---------------------------------------------------------------------------
// Types

export type VariantScope =
  | { kind: "element"; target: AnnotationTarget }
  | { kind: "page" };

/** Optional apply hint (real-class markup or a style map). Never rendered. */
export type VariantSwap = {
  /** Inline-CSS property map for style-only variants (applied via applyPreview). */
  cssChanges?: Record<string, string>;
  /** Replacement outerHTML for structural variants. Sanitized before use. */
  html?: string;
};

export type DesignVariant = {
  id: string;
  label: string;
  /** ≤ 18 words on why this direction suits the product. */
  rationale: string;
  /** Self-contained snippet with resolved inline values — the VISUAL
   *  CONTRACT. The card renders it, "Preview on page" renders the same
   *  markup in an isolated shadow root, and variants-apply must
   *  reproduce it in source. */
  previewHtml: string;
  /** Optional CSS color the card paints behind the element (e.g. the
   *  page's dark ground). Never used on the live page. */
  previewBackground?: string;
  /** Optional apply hint (real-class markup / style map). No longer
   *  drives the on-page preview — previewHtml does. */
  swap?: VariantSwap;
  /** Human-readable source-change description; also the apply spec. */
  summary: string;
};

export type VariantRun = {
  runId: string;
  createdAt: number;
  scope: VariantScope;
  url: string;
  variants: DesignVariant[];
  appliedVariantId?: string;
  applySummary?: string;
  appliedFiles?: { path: string; note?: string }[];
  /** Post-apply match check result for the applied variant. */
  match?: VariantMatch;
};

/** State of the post-apply "does the page match the card?" check. */
export type VariantMatch = {
  status: "checking" | "done" | "not-found" | "error";
  score?: number;
  diffs?: RenderDiff[];
  missing?: string[];
  message?: string;
  checkedAt: number;
};

/** One route in the Pages gallery. */
export type PageEntry = { path: string; label: string };

export type DevicePreset = { label: string; width: number; height: number };

// ---------------------------------------------------------------------------
// Size caps (bytes of UTF-16 code units — close enough for a guardrail).

export const PREVIEW_HTML_MAX_ELEMENT = 8 * 1024;
export const PREVIEW_HTML_MAX_PAGE = 20 * 1024;
/** Hard ceiling on variants per run (token economy); the user picks
 *  MIN_VARIANTS..MAX_VARIANTS per run in the tab (VARIANT_COUNT_CHOICES).
 *  One variant is a valid run — a single focused redesign. */
export const MIN_VARIANTS = 1;
export const MAX_VARIANTS = 5;
export const VARIANT_COUNT_CHOICES = [1, 2, 3, 4, 5] as const;
export const DEFAULT_VARIANT_COUNT = 3;

/** True when `n` is a variant count the tab may send (and persist). */
export function isValidVariantCount(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isInteger(n) &&
    n >= MIN_VARIANTS &&
    n <= MAX_VARIANTS
  );
}

/** "1 variant" / "3 variants" — for buttons and progress copy. */
export function variantCountLabel(n: number): string {
  return `${n} variant${n === 1 ? "" : "s"}`;
}
export const MAX_PAGES = 12;
/** Cap on the optional free-text art direction sent with a generate
 *  (token economy — it's a steer, not a spec). */
export const MAX_DIRECTION_CHARS = 280;

/**
 * Normalize the user's optional art-direction prompt: collapse
 * whitespace, trim, cap at MAX_DIRECTION_CHARS. Empty in → empty out
 * (the field is omitted from the wire payload).
 */
export function normalizeDirection(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, MAX_DIRECTION_CHARS);
}

// ---------------------------------------------------------------------------
// Device presets

export const DEFAULT_DEVICE_PRESETS: DevicePreset[] = [
  { label: "Mobile", width: 390, height: 844 },
  { label: "Tablet", width: 768, height: 1024 },
  { label: "Laptop", width: 1280, height: 800 },
  { label: "Desktop", width: 1440, height: 900 },
];

/**
 * Parse the `devicePresets` module setting. Any malformed input (bad
 * JSON, wrong shape, non-positive sizes) falls back to the defaults —
 * a broken setting must never blank the device row.
 */
export function parseDevicePresets(
  settingValue: string | boolean | undefined,
): DevicePreset[] {
  if (typeof settingValue !== "string" || settingValue.trim() === "") {
    return DEFAULT_DEVICE_PRESETS;
  }
  try {
    const parsed: unknown = JSON.parse(settingValue);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return DEFAULT_DEVICE_PRESETS;
    }
    const out: DevicePreset[] = [];
    for (const p of parsed) {
      if (
        p &&
        typeof p === "object" &&
        typeof (p as DevicePreset).label === "string" &&
        (p as DevicePreset).label.trim() !== "" &&
        typeof (p as DevicePreset).width === "number" &&
        (p as DevicePreset).width > 0 &&
        typeof (p as DevicePreset).height === "number" &&
        (p as DevicePreset).height > 0
      ) {
        out.push({
          label: (p as DevicePreset).label.trim(),
          width: Math.round((p as DevicePreset).width),
          height: Math.round((p as DevicePreset).height),
        });
      }
    }
    return out.length > 0 ? out : DEFAULT_DEVICE_PRESETS;
  } catch {
    return DEFAULT_DEVICE_PRESETS;
  }
}

/**
 * Scale factor that fits a device-width frame into a card of the given
 * width. Never upscales (cap at 1).
 */
export function frameScale(deviceWidth: number, cardWidth: number): number {
  if (deviceWidth <= 0 || cardWidth <= 0) return 1;
  return Math.min(1, cardWidth / deviceWidth);
}

// ---------------------------------------------------------------------------
// Inbound sanitizer (agent HTML → page / iframe)
//
// ALLOWLIST, rebuild-not-scrub: the input is parsed into an inert
// document and only allowlisted elements / attributes are re-created in a
// fresh inert document (so nothing the parser produced — comments,
// <template> content, unknown namespaces — is carried over by accident).
// Presentational only: no URLs survive except raster data: images, no
// form wiring, no media, no remote CSS.

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

const HTML_TAGS = new Set([
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "b", "i", "u", "s", "small", "mark", "sub", "sup",
  "code", "pre", "kbd", "blockquote", "br", "hr",
  "ul", "ol", "li", "dl", "dt", "dd",
  "a", "button", "label", "input", "img",
  "figure", "figcaption", "section", "article", "header", "footer",
  "nav", "main", "aside",
  "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
  "colgroup", "col",
]);

/** Dropped WITH their content (active, embedding, media, raw-text or
 *  hidden-text elements). Any other unknown HTML element is unwrapped:
 *  its children are sanitized in its place. */
const HTML_DROP_WITH_CONTENT = new Set([
  "script", "template", "noscript", "noembed", "noframes", "xmp",
  "plaintext", "listing", "iframe", "frame", "frameset", "object",
  "embed", "applet", "portal", "fencedframe", "video", "audio", "source",
  "track", "picture", "canvas", "map", "area", "textarea", "select",
  "option", "optgroup", "datalist", "title", "head", "meta", "link",
  "base", "math", "slot", "dialog",
]);

/** SVG allowlist (case-sensitive localNames — the parser camelCases). */
const SVG_TAGS = new Set([
  "svg", "g", "path", "circle", "rect", "line", "polyline", "polygon",
  "ellipse", "defs", "linearGradient", "radialGradient", "stop", "text",
  "tspan",
]);
/** SVG elements whose text children render (all other SVG text is
 *  invisible — a hiding place for instructions aimed at the agent). */
const SVG_TEXT_TAGS = new Set(["text", "tspan"]);

const GLOBAL_ATTRS = new Set(["class", "style", "role", "dir", "lang"]);
const HTML_TAG_ATTRS: Record<string, Set<string>> = {
  img: new Set(["alt", "width", "height", "src"]),
  input: new Set(["type", "checked", "disabled", "placeholder", "value", "readonly"]),
  button: new Set(["disabled"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "reversed"]),
};
const SVG_ATTRS = new Set(
  [
    "width", "height", "viewBox", "preserveAspectRatio", "fill",
    "fill-opacity", "fill-rule", "clip-rule", "stroke", "stroke-width",
    "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
    "stroke-dashoffset", "stroke-miterlimit", "stroke-opacity", "d", "cx",
    "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "dx", "dy",
    "fx", "fy", "points", "offset", "stop-color", "stop-opacity", "opacity",
    "transform", "gradientUnits", "gradientTransform", "spreadMethod",
    "text-anchor", "dominant-baseline", "font-size", "font-weight",
    "font-family",
  ].map((a) => a.toLowerCase()),
);
const INPUT_TYPES = new Set(["text", "checkbox", "radio"]);
const RASTER_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const LOCAL_PAINT_REF = /^url\(\s*#[a-z][\w-]*\s*\)$/i;
const SAFE_ID = /^[a-z][\w-]{0,40}$/i;
const NUMERIC_ATTRS = new Set(["width", "height", "colspan", "rowspan", "span", "start"]);
const MAX_SANITIZE_DEPTH = 64;
const MAX_ARIA_CHARS = 200;

/** CSS functions a declaration may call. Everything else — url(),
 *  image-set(), image(), src(), cross-fade(), element(), expression(),
 *  paint(), attr() … — rejects the declaration. */
const CSS_FUNCS = new Set([
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch",
  "color", "color-mix", "light-dark", "calc", "min", "max", "clamp", "var",
  "env", "linear-gradient", "radial-gradient", "conic-gradient",
  "repeating-linear-gradient", "repeating-radial-gradient",
  "repeating-conic-gradient", "translate", "translatex", "translatey",
  "translatez", "translate3d", "rotate", "rotatex", "rotatey", "rotatez",
  "rotate3d", "scale", "scalex", "scaley", "scalez", "scale3d", "skew",
  "skewx", "skewy", "matrix", "matrix3d", "perspective", "cubic-bezier",
  "steps", "blur", "brightness", "contrast", "drop-shadow", "grayscale",
  "hue-rotate", "invert", "opacity", "saturate", "sepia", "fit-content",
  "minmax", "repeat", "inset", "circle", "ellipse", "polygon", "counter",
  "counters",
]);
const CSS_BLOCKED_PROPS = new Set(["behavior", "-moz-binding", "-webkit-binding"]);
const CSS_POSITION_OK = /^(static|relative|absolute|sticky)(\s*!important)?$/i;
/** Selector parts that reach OUT of the shadow root / card (UI redress). */
const CSS_ESCAPE_SELECTOR = /:host|::?slotted|::?part\b/i;

function stripCssComments(css: string): string {
  // Removing comments can only JOIN tokens (u/**/rl( → url(), which the
  // checks below then reject — strictly safer than skipping them.
  return css.replace(/\/\*[\s\S]*?(\*\/|$)/g, "");
}

/** Split on `sep` outside quotes and parentheses. */
function splitCssTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let quote = "";
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function balancedCss(v: string): boolean {
  let depth = 0;
  let quote = "";
  for (const ch of v) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0 && quote === "";
}

/** True when a declaration VALUE can't fetch, escape, or break out. */
function cssValueSafe(v: string): boolean {
  // Backslash escapes (u\72l), `<` (</style>), `@` (@import), braces and
  // `;` (rule / declaration injection) are never needed by a preview.
  if (/[\\<>@{};]/.test(v) || /javascript:|expression/i.test(v)) return false;
  if (!balancedCss(v)) return false;
  for (const m of v.matchAll(/(-?[a-z_][a-z0-9_-]*)?\s*\(/gi)) {
    if (m[1] === undefined) continue; // bare grouping paren, e.g. calc((…))
    if (!CSS_FUNCS.has(m[1].toLowerCase())) return false;
  }
  return true;
}

/**
 * Filter a declaration list (`a:b;c:d`) — each declaration is kept only
 * when its property is well-formed and not blocked and its value passes
 * cssValueSafe. `position` must be a plain non-fixed keyword. Returns the
 * kept declarations re-joined with `;` (empty string = nothing kept).
 */
export function filterCssDeclarations(text: string): string {
  if (typeof text !== "string" || text.trim() === "") return "";
  const kept: string[] = [];
  for (const decl of splitCssTopLevel(stripCssComments(text), ";")) {
    const i = decl.indexOf(":");
    if (i <= 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!/^-{0,2}[a-z][a-z0-9-]*$/.test(prop) || value === "") continue;
    if (CSS_BLOCKED_PROPS.has(prop)) continue;
    if (prop === "position" && !CSS_POSITION_OK.test(value)) continue;
    if (!cssValueSafe(value)) continue;
    kept.push(`${prop}:${value}`);
  }
  return kept.join(";");
}

type CssBlock = { prelude: string; body: string | null };

/** Split a stylesheet into top-level statements / blocks. Unterminated
 *  trailing input is dropped. Quote tracking deliberately ignores
 *  backslashes: any piece containing one is rejected downstream. */
function cssBlocks(css: string): CssBlock[] {
  const out: CssBlock[] = [];
  const n = css.length;
  let i = 0;
  while (i < n) {
    const start = i;
    let quote = "";
    while (i < n) {
      const c = css[i]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ";" || c === "{" || c === "}") break;
      i++;
    }
    if (i >= n) break;
    const prelude = css.slice(start, i).trim();
    if (css[i] !== "{") {
      i++;
      if (prelude) out.push({ prelude, body: null });
      continue;
    }
    let depth = 1;
    i++;
    const bodyStart = i;
    quote = "";
    while (i < n && depth > 0) {
      const c = css[i]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    if (depth !== 0) break;
    out.push({ prelude, body: css.slice(bodyStart, i - 1) });
  }
  return out;
}

const KEYFRAME_SELECTOR = /^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/i;

function filterRules(css: string, depth: number, keyframes: boolean): string {
  let out = "";
  for (const { prelude, body } of cssBlocks(css)) {
    // Statements (`@import "…";`, `@charset`, stray junk) never survive.
    if (body === null) continue;
    if (/[\\<>{};]/.test(prelude)) continue;
    if (prelude.startsWith("@")) {
      if (keyframes || depth > 1) continue;
      const m = /^@(media|keyframes|-webkit-keyframes)\s+([\s\S]+)$/i.exec(prelude);
      if (!m) continue; // @font-face, @import, @supports, @layer, @property …
      const kind = m[1]!.toLowerCase();
      const arg = m[2]!.trim();
      if (kind === "media") {
        if (!/^[\w\s():,.%/-]+$/.test(arg)) continue;
        const inner = filterRules(body, depth + 1, false);
        if (inner) out += `@media ${arg}{${inner}}`;
      } else {
        if (!/^[a-z_-][\w-]*$/i.test(arg)) continue;
        const inner = filterRules(body, depth + 1, true);
        if (inner) out += `@${kind} ${arg}{${inner}}`;
      }
      continue;
    }
    if (keyframes) {
      if (!KEYFRAME_SELECTOR.test(prelude)) continue;
    } else if (/[@"']/.test(prelude) || CSS_ESCAPE_SELECTOR.test(prelude) || /url\s*\(/i.test(prelude)) {
      continue;
    }
    if (/[{}]/.test(body)) continue; // CSS nesting — not needed, not parsed
    const decls = filterCssDeclarations(body);
    if (decls) out += `${prelude}{${decls}}`;
  }
  return out;
}

/**
 * Filter a `<style>` element's text: comments removed; plain style rules
 * plus `@media` / `@keyframes` blocks kept, every other at-rule dropped;
 * rules whose selector reaches out of the shadow root (`:host`,
 * `::slotted`, `::part`) dropped; declarations run through
 * filterCssDeclarations. The result contains no `<`, `\` or `@import`.
 */
export function filterStylesheet(css: string): string {
  if (typeof css !== "string" || css.trim() === "") return "";
  return filterRules(stripCssComments(css), 0, false).replace(/</g, "");
}

/** Keep only style-map entries that pass the same CSS filter (agent
 *  `swap.cssChanges` hints — never rendered, but never trusted either). */
export function sanitizeCssMap(map: unknown): Record<string, string> | undefined {
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    if (filterCssDeclarations(`${k}:${v}`) !== "") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function copyAttributes(src: Element, dst: Element, isSvg: boolean): void {
  const tag = src.localName;
  const perTag = isSvg ? undefined : HTML_TAG_ATTRS[tag];
  for (const attr of Array.from(src.attributes)) {
    // Namespaced attributes (xlink:href, xml:*, xmlns:*) never pass.
    if (attr.namespaceURI || attr.name.includes(":")) continue;
    const name = attr.name.toLowerCase();
    const value = attr.value;
    if (/javascript:/i.test(value.replace(/[\s\x00-\x1f]+/g, ""))) continue;
    if (name.startsWith("aria-")) {
      if (/^aria-[a-z]+$/.test(name) && value.length <= MAX_ARIA_CHARS) {
        dst.setAttribute(name, value);
      }
      continue;
    }
    if (name === "style") {
      const css = filterCssDeclarations(value);
      if (css) dst.setAttribute("style", css);
      continue;
    }
    if (GLOBAL_ATTRS.has(name)) {
      dst.setAttribute(name, value);
      continue;
    }
    if (isSvg) {
      if (name === "id") {
        // Gradients need an id to be referenced by fill="url(#id)".
        if ((tag === "linearGradient" || tag === "radialGradient") && SAFE_ID.test(value)) {
          dst.setAttribute("id", value);
        }
        continue;
      }
      if (!SVG_ATTRS.has(name) || value.length > 8000) continue;
      if (/url\s*\(/i.test(value) && !LOCAL_PAINT_REF.test(value.trim())) continue;
      dst.setAttribute(attr.name, value);
      continue;
    }
    if (!perTag?.has(name)) continue;
    const v = value.trim();
    if (tag === "img" && name === "src") {
      // No remote loads (beacons / GET CSRF from the extension origin).
      if (RASTER_DATA_IMAGE.test(v)) dst.setAttribute("src", v);
      continue;
    }
    if (tag === "input" && name === "type") {
      const t = v.toLowerCase();
      dst.setAttribute("type", INPUT_TYPES.has(t) ? t : "text");
      continue;
    }
    if (NUMERIC_ATTRS.has(name)) {
      if (/^\d{1,5}(\.\d+)?(px|%)?$/.test(v)) dst.setAttribute(name, v);
      continue;
    }
    dst.setAttribute(name, value);
  }
  if (!isSvg && tag === "button") dst.setAttribute("type", "button");
  if (!isSvg && tag === "input" && !dst.hasAttribute("type")) {
    dst.setAttribute("type", "text");
  }
}

function rebuildChildren(
  src: Node,
  dst: Node,
  out: Document,
  parent: { svg: boolean; textOk: boolean },
  depth: number,
): void {
  if (depth > MAX_SANITIZE_DEPTH) return;
  for (const node of Array.from(src.childNodes)) {
    if (node.nodeType === 3) {
      if (parent.textOk) dst.appendChild(out.createTextNode(node.nodeValue ?? ""));
      continue;
    }
    // Comments, processing instructions, CDATA: never copied.
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const name = el.localName;
    if (el.namespaceURI === HTML_NS && !parent.svg) {
      if (name === "style") {
        const css = filterStylesheet(el.textContent ?? "");
        if (css) {
          const style = out.createElement("style");
          style.textContent = css;
          dst.appendChild(style);
        }
        continue;
      }
      if (HTML_TAGS.has(name)) {
        const copy = out.createElement(name);
        copyAttributes(el, copy, false);
        rebuildChildren(el, copy, out, { svg: false, textOk: true }, depth + 1);
        dst.appendChild(copy);
      } else if (!HTML_DROP_WITH_CONTENT.has(name)) {
        rebuildChildren(el, dst, out, parent, depth + 1); // unwrap unknown
      }
      continue;
    }
    if (
      el.namespaceURI === SVG_NS &&
      SVG_TAGS.has(name) &&
      (parent.svg || name === "svg")
    ) {
      const copy = out.createElementNS(SVG_NS, name);
      copyAttributes(el, copy, true);
      rebuildChildren(el, copy, out, { svg: true, textOk: SVG_TEXT_TAGS.has(name) }, depth + 1);
      dst.appendChild(copy);
    }
    // Anything else — MathML, unknown SVG (animate, set, use, image,
    // foreignObject, script, style, title …), HTML nested in SVG — is
    // dropped with its content.
  }
}

function inertDocument(): Document {
  return new DOMParser().parseFromString("<!doctype html><title></title>", "text/html");
}

/**
 * Sanitize agent-generated variant HTML into a DocumentFragment owned by
 * a fresh inert document. Appending it to a live tree adopts the nodes —
 * no string re-parse, so no serialize/parse (mXSS) divergence.
 *
 * Runs in extension pages, the content-script isolated world, and
 * happy-dom (vitest) — DOMParser exists in all three.
 */
export function sanitizeVariantFragment(html: string): DocumentFragment {
  const out = inertDocument();
  const frag = out.createDocumentFragment();
  if (typeof html !== "string" || html === "") return frag;
  // Parse via <template> in an inert document: contents stay in order
  // (no head/body split) and nothing loads or runs while we walk them.
  const tpl = inertDocument().createElement("template");
  tpl.innerHTML = html;
  rebuildChildren(tpl.content, frag, out, { svg: false, textOk: true }, 0);
  return frag;
}

/**
 * Sanitize agent-generated variant HTML (see sanitizeVariantFragment) and
 * serialize it ONCE. Allowlist: presentational HTML + basic SVG shapes /
 * gradients; class / style (CSS-filtered) / role / aria-* / dir / lang
 * plus a few per-tag attributes. Drops comments, <template>/<noscript>,
 * media, form wiring, every URL except raster data: images, id / data-* /
 * title attributes, and any CSS that can fetch or escape the preview.
 */
export function sanitizeVariantHtml(html: string): string {
  if (typeof html !== "string" || html === "") return "";
  const frag = sanitizeVariantFragment(html);
  const holder = (frag.ownerDocument ?? inertDocument()).createElement("div");
  holder.appendChild(frag);
  return holder.innerHTML;
}

// ---------------------------------------------------------------------------
// srcdoc for the sandboxed variant cards

/** CSP stamped into every variant srcdoc: no network, no script. */
export const SRCDOC_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'";

/**
 * Wrap a (sanitized) previewHtml snippet into a full srcdoc document.
 * The iframe carries the EMPTY `sandbox` attribute so nothing executes;
 * this wrapper just gives the snippet a neutral canvas.
 */
export function buildSrcdoc(
  variant: Pick<DesignVariant, "previewHtml" | "previewBackground">,
  opts: { scroll?: boolean } = {},
): string {
  const { elementHtml, background } = splitPreviewBackdrop(variant.previewHtml);
  const safe = sanitizeVariantHtml(elementHtml);
  const ground =
    safeCssColor(variant.previewBackground) ?? background ?? "#fff";
  const overflow = opts.scroll ? "auto" : "hidden";
  // overflow:hidden — the card iframe is a non-interactive thumbnail;
  // inner scrollbars only add noise to the scaled-down render. The body
  // font matches SHADOW_PREVIEW_CSS so card and on-page preview agree.
  // The meta CSP is defense-in-depth on top of the sanitizer + empty
  // sandbox: the document may not fetch anything but inline data: images.
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="Content-Security-Policy" content="${SRCDOC_CSP}">` +
    `<style>html,body{margin:0;overflow:${overflow}}body{padding:16px;background:${ground};font-family:system-ui,sans-serif}</style>` +
    "</head><body>" +
    safe +
    "</body></html>"
  );
}

// ---------------------------------------------------------------------------
// Full-screen preview hand-off (side panel → packaged preview page). The
// variant rides in chrome.storage.session under a one-time random key —
// never in the URL, and agent HTML is never navigated to as a document.

export const VARIANT_PREVIEW_PAGE = "src/variant-preview/index.html";
const VARIANT_PREVIEW_PREFIX = "pinta-variant-preview:";
/** A hand-off older than this is treated as gone (tab never opened). */
export const VARIANT_PREVIEW_TTL_MS = 5 * 60_000;

export type VariantPreviewPayload = {
  label: string;
  previewHtml: string;
  previewBackground?: string;
  createdAt: number;
};

/** Storage key for a preview nonce, or null when the nonce is malformed. */
export function variantPreviewKey(nonce: string | null | undefined): string | null {
  return typeof nonce === "string" && /^[0-9a-f-]{16,64}$/i.test(nonce)
    ? `${VARIANT_PREVIEW_PREFIX}${nonce}`
    : null;
}

/** Validate a stored hand-off (untrusted shape; expired → null). */
export function parseVariantPreviewPayload(
  raw: unknown,
  now: number,
): VariantPreviewPayload | null {
  const o = asRecord(raw);
  if (!o || typeof o.previewHtml !== "string" || typeof o.createdAt !== "number") {
    return null;
  }
  if (now - o.createdAt > VARIANT_PREVIEW_TTL_MS || o.createdAt > now + 60_000) {
    return null;
  }
  return {
    label: typeof o.label === "string" ? o.label.slice(0, 200) : "Variant",
    previewHtml: o.previewHtml.slice(0, PREVIEW_HTML_MAX_PAGE),
    previewBackground: safeCssColor(o.previewBackground),
    createdAt: o.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Faithful on-page preview. The card is an iframe document; the live page
// is not. Rendering the SAME markup inside a shadow root with inherited
// properties reset gives the page preview the card's rendering context:
// page CSS (Tailwind preflight, element resets) can't reach in, and any
// <style> the variant carries stays scoped to the preview.

/** Base CSS for the shadow root that hosts an on-page variant preview.
 *  Mirrors the card's iframe body (system font, light scheme, UA
 *  defaults) minus its padding and ground — the page is the ground. */
export const SHADOW_PREVIEW_CSS =
  ":host{all:initial;display:block}" +
  ".pinta-pv{font-family:system-ui,sans-serif;color:#000;color-scheme:light}";

/** Computed properties copied from the original element onto the preview
 *  host so the preview occupies the same slot in the page's layout. */
export const PREVIEW_LAYOUT_PROPS = [
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-self",
  "justify-self",
  "order",
  "grid-column-start",
  "grid-column-end",
  "grid-row-start",
  "grid-row-end",
] as const;

/** Width (CSS px) to lay out an ELEMENT variant at: the element's own
 *  on-page width when known, never wider than the device's content box. */
export function elementRenderWidth(deviceWidth: number, targetWidth?: number): number {
  const content = Math.max(240, Math.round(deviceWidth) - 32);
  if (!targetWidth || !Number.isFinite(targetWidth) || targetWidth <= 0) {
    return Math.min(content, 720);
  }
  return Math.max(120, Math.round(Math.min(content, targetWidth)));
}

export type ShadowCardParams = {
  /** Variant markup (sanitized again here). */
  html: string;
  /** Layout width of the element in CSS px (see elementRenderWidth). */
  width: number;
  /** Card ground color (already validated by safeCssColor). */
  ground: string;
  /** true = render at 100% (the parent scrolls horizontally);
   *  false/absent = scale down to fit the parent's width. */
  actual?: boolean;
};

/**
 * Render an element variant card in `node` through the SAME shadow-root
 * context as the on-page preview (SHADOW_PREVIEW_CSS), so what the card
 * shows is exactly what "Preview on page" shows. Unlike a sandboxed
 * iframe, the content height is measurable: the stage is laid out at the
 * element's real width, scaled to fit `node`, and `node` takes the
 * scaled height — no empty letterboxing. Mark `node` inert; the preview
 * is a picture, not an interactive surface. Returns update/destroy.
 */
export function mountShadowCard(
  node: HTMLElement,
  initial: ShadowCardParams,
): { update(p: ShadowCardParams): void; destroy(): void } {
  const doc = node.ownerDocument;
  const root = node.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  const stage = doc.createElement("div");
  stage.className = "pinta-pv stage";
  root.append(style, stage);
  let params = initial;
  const PAD = 16;

  const layout = () => {
    const outer = params.width + PAD * 2;
    // Reads first, then writes — no forced reflow between them. The
    // stage's offsetHeight ignores its transform, so reading it before
    // the transform write is exact.
    const avail = node.parentElement?.clientWidth || outer;
    const stageH = stage.offsetHeight;
    const scale = params.actual ? 1 : Math.min(1, avail / outer);
    const t = `scale(${scale})`;
    const w = `${Math.ceil(outer * scale)}px`;
    const h = `${Math.max(24, Math.ceil(stageH * scale))}px`;
    // Only write on change: the observer watches the parent and the
    // stage, so an unchanged write would re-trigger it for nothing.
    if (stage.style.transform !== t) stage.style.transform = t;
    if (node.style.width !== w) node.style.width = w;
    if (node.style.height !== h) node.style.height = h;
  };
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    const raf = doc.defaultView?.requestAnimationFrame;
    if (!raf) return layout();
    frame = raf(() => {
      frame = 0;
      layout();
    });
  };

  const render = () => {
    // Re-validated here: this string is CSS text, never trust the caller.
    const ground = safeCssColor(params.ground) ?? "#fff";
    const width = Math.max(0, Math.round(Number(params.width) || 0));
    style.textContent =
      SHADOW_PREVIEW_CSS +
      `.stage{box-sizing:border-box;width:${width + PAD * 2}px;padding:${PAD}px;background:${ground};transform-origin:top left}`;
    stage.replaceChildren(sanitizeVariantFragment(params.html));
  };

  const view = doc.defaultView as (Window & typeof globalThis) | null;
  const ro = view && "ResizeObserver" in view ? new view.ResizeObserver(schedule) : null;
  if (node.parentElement) ro?.observe(node.parentElement);
  ro?.observe(stage);
  render();
  layout(); // size once synchronously so the card never flashes at 0×0

  return {
    update(p) {
      const htmlChanged =
        p.html !== params.html || p.ground !== params.ground || p.width !== params.width;
      params = p;
      if (htmlChanged) {
        render();
        schedule();
      } else layout();
    },
    destroy() {
      ro?.disconnect();
      if (frame) doc.defaultView?.cancelAnimationFrame(frame);
      stage.replaceChildren();
    },
  };
}

/**
 * Build the detached host that stands in for `original` during an
 * on-page variant preview: a div carrying the original's layout slot
 * (computed margins + flex/grid placement) with a CLOSED shadow root
 * holding SHADOW_PREVIEW_CSS and the variant markup. `html` is
 * sanitized here — callers may pass untrusted markup. Returns null when
 * nothing renderable survives sanitizing. The caller inserts `host`
 * (`original.replaceWith(host)`) and owns restore; `content` is the
 * wrapper inside the closed root (used by the post-apply match check).
 */
export function buildShadowPreviewHost(
  original: Element,
  html: string,
  variantId: string,
): { host: HTMLElement; content: HTMLElement } | null {
  const doc = original.ownerDocument;
  const content = sanitizeVariantFragment(html);
  const renderable = Array.from(content.children).some(
    (c) => c.tagName.toUpperCase() !== "STYLE",
  );
  if (!renderable) return null;
  const host = doc.createElement("div");
  host.setAttribute("data-pinta-variant", variantId);
  // Containment makes the host the containing block for any fixed /
  // absolute descendant and clips paint to its box, so a hostile preview
  // can't cover the page (the sanitizer also drops :host rules and
  // position:fixed — this is the second layer).
  host.style.setProperty("contain", "layout paint");
  const view = doc.defaultView;
  const cs = view ? view.getComputedStyle(original) : null;
  if (cs) {
    for (const prop of PREVIEW_LAYOUT_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (v) host.style.setProperty(prop, v);
    }
  }
  const root = host.attachShadow({ mode: "closed" });
  const base = doc.createElement("style");
  base.textContent = SHADOW_PREVIEW_CSS;
  const wrap = doc.createElement("div");
  wrap.className = "pinta-pv";
  wrap.append(content);
  root.append(base, wrap);
  return { host, content: wrap };
}

// Interpolated into CSS text (buildSrcdoc, mountShadowCard): the charset
// is closed — no `;`, `}`, `<`, quotes, backslashes or newlines can pass.
const SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([0-9 .,%/deg+-]+\)|[a-z]{3,20})$/i;

/** Returns `v` when it is a plain CSS color (hex / rgb / hsl / keyword),
 *  else undefined. Gradients, url(), var() and anything else are rejected. */
export function safeCssColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= 60 && SAFE_COLOR.test(t) ? t : undefined;
}

/** Inline-style props a pure "page ground" wrapper may set. */
const BACKDROP_PROPS = new Set([
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "background",
  "background-color",
  "font-family",
  "min-height",
]);

function parseInlineStyle(style: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const decl of style.split(";")) {
    if (decl.trim() === "") continue;
    const i = decl.indexOf(":");
    if (i <= 0) return null;
    out.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim());
  }
  return out;
}

/**
 * Split an agent `previewHtml` into the variant ELEMENT and its backdrop.
 * Agents often wrap the element in a padded "page ground" div so the card
 * reads in context. On the live page that wrapper would show up as an
 * extra padded box, so it's unwrapped when ALL hold:
 *  - the snippet has exactly one non-<style> root element, a class-less
 *    <div> with only a style attribute and no direct text;
 *  - that style only sets padding / background / font-family / min-height;
 *  - it has exactly one non-<style> element child.
 * The wrapper's font-family moves onto the element (unless it sets its
 * own) and its background becomes the card ground when it's a plain color.
 * Anything else is returned untouched.
 */
export function splitPreviewBackdrop(html: string): {
  elementHtml: string;
  background?: string;
} {
  const untouched = { elementHtml: typeof html === "string" ? html : "" };
  if (typeof html !== "string" || html.trim() === "") return untouched;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const nodes = [
    ...Array.from(doc.head.children),
    ...Array.from(doc.body.childNodes),
  ];
  const styles: Element[] = [];
  const roots: Element[] = [];
  for (const n of nodes) {
    if (n.nodeType === 3) {
      if ((n.textContent ?? "").trim() !== "") return untouched;
      continue;
    }
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    if (el.tagName.toUpperCase() === "STYLE") styles.push(el);
    else roots.push(el);
  }
  if (roots.length !== 1) return untouched;
  const wrap = roots[0]!;
  if (wrap.tagName.toUpperCase() !== "DIV") return untouched;
  for (const a of Array.from(wrap.attributes)) {
    if (a.name.toLowerCase() !== "style") return untouched;
  }
  const decls = parseInlineStyle(wrap.getAttribute("style") ?? "");
  if (!decls || decls.size === 0) return untouched;
  for (const prop of decls.keys()) {
    if (!BACKDROP_PROPS.has(prop)) return untouched;
  }
  const inner: Element[] = [];
  for (const c of Array.from(wrap.childNodes)) {
    if (c.nodeType === 3) {
      if ((c.textContent ?? "").trim() !== "") return untouched;
      continue;
    }
    if (c.nodeType !== 1) continue;
    const el = c as Element;
    if (el.tagName.toUpperCase() === "STYLE") styles.push(el);
    else inner.push(el);
  }
  if (inner.length !== 1) return untouched;
  const element = inner[0]!;
  const font = decls.get("font-family");
  if (font) {
    const prev = (element.getAttribute("style") ?? "").trim();
    const own = parseInlineStyle(prev);
    if (!own || !own.has("font-family")) {
      const rest = prev === "" ? "" : prev.startsWith(";") ? prev : `;${prev}`;
      element.setAttribute("style", `font-family:${font}${rest}`);
    }
  }
  const bg = safeCssColor(
    decls.get("background-color") ?? decls.get("background"),
  );
  return {
    elementHtml:
      styles.map((st) => st.outerHTML).join("") + element.outerHTML,
    ...(bg ? { background: bg } : {}),
  };
}

// ---------------------------------------------------------------------------
// Agent-payload parsing (alias-tolerant, mirroring handleAuditSync's
// leniency — the main defense against SKILL.md / extension version skew).

const RUN_TYPE_ALIASES = new Set([
  "design-variants-run",
  "variants-run",
  "design-variants",
]);

const APPLIED_TYPE_ALIASES = new Set([
  "design-variants-applied",
  "variants-applied",
]);

const PAGES_TYPE_ALIASES = new Set([
  "design-variants-pages",
  "variants-pages",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tryParse(summary: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(summary));
  } catch {
    return null;
  }
}

/**
 * Parse + validate a variants-generate result. Returns null when the
 * summary isn't recognizably a variants run (caller surfaces the raw
 * text as an error, clipped).
 */
export function parseVariantsResult(
  summary: string,
): { runId?: string; variants: DesignVariant[] } | null {
  const obj = tryParse(summary);
  if (!obj) return null;
  const typeOk =
    typeof obj.type === "string"
      ? RUN_TYPE_ALIASES.has(obj.type)
      : Array.isArray(obj.variants); // duck-type: missing type but has variants[]
  if (!typeOk || !Array.isArray(obj.variants)) return null;
  const variants: DesignVariant[] = [];
  for (const raw of obj.variants) {
    const v = asRecord(raw);
    if (!v) continue;
    if (typeof v.previewHtml !== "string" || v.previewHtml.trim() === "") {
      continue; // a card with nothing to render is useless — drop it
    }
    const swap = asRecord(v.swap);
    variants.push({
      id: typeof v.id === "string" && v.id ? v.id : `v${variants.length + 1}`,
      label: typeof v.label === "string" ? v.label : `Variant ${variants.length + 1}`,
      rationale: typeof v.rationale === "string" ? v.rationale : "",
      previewHtml: v.previewHtml,
      previewBackground: safeCssColor(v.previewBackground),
      swap: swap
        ? {
            cssChanges: sanitizeCssMap(swap.cssChanges),
            html: typeof swap.html === "string" ? swap.html : undefined,
          }
        : undefined,
      summary: typeof v.summary === "string" ? v.summary : "",
    });
    if (variants.length >= MAX_VARIANTS) break;
  }
  if (variants.length === 0) return null;
  return {
    runId: typeof obj.runId === "string" ? obj.runId : undefined,
    variants,
  };
}

/**
 * Clamp a parsed run to the size budget: previewHtml is truncated at the
 * scope's cap (truncation may break markup, but the sandboxed iframe
 * degrades safely and the cap should never be hit by a compliant agent).
 */
export function validateVariantRun(
  variants: DesignVariant[],
  scopeKind: "element" | "page",
): DesignVariant[] {
  const cap =
    scopeKind === "page" ? PREVIEW_HTML_MAX_PAGE : PREVIEW_HTML_MAX_ELEMENT;
  return variants.slice(0, MAX_VARIANTS).map((v) => ({
    ...v,
    previewHtml:
      v.previewHtml.length > cap ? v.previewHtml.slice(0, cap) : v.previewHtml,
  }));
}

/** Partial variant update returned by a Discuss refinement. */
export type VariantDiscussUpdate = Partial<
  Pick<
    DesignVariant,
    "label" | "rationale" | "previewHtml" | "previewBackground" | "swap" | "summary"
  >
>;

const DISCUSS_TYPE_ALIASES = new Set([
  "design-variants-discuss",
  "variants-discuss",
]);

/**
 * Parse a variants-discuss reply: a conversational `reply` plus an
 * optional `updatedVariant` carrying refined fields (previewHtml /
 * swap / summary / label / rationale). Bare markdown (older agents) is
 * accepted as a plain reply.
 */
export function parseDiscussResult(summary: string): {
  variantId?: string;
  reply: string;
  updatedVariant?: VariantDiscussUpdate;
} | null {
  const obj = tryParse(summary);
  if (!obj) {
    return summary.trim() !== "" ? { reply: summary } : null;
  }
  if (typeof obj.type === "string" && !DISCUSS_TYPE_ALIASES.has(obj.type)) {
    return null;
  }
  const reply =
    typeof obj.reply === "string" && obj.reply.trim() !== ""
      ? obj.reply
      : typeof obj.message === "string"
        ? obj.message
        : "";
  const uv = asRecord(obj.updatedVariant ?? obj.variant);
  let updatedVariant: VariantDiscussUpdate | undefined;
  if (uv) {
    const swap = asRecord(uv.swap);
    updatedVariant = {
      ...(typeof uv.label === "string" && uv.label ? { label: uv.label } : {}),
      ...(typeof uv.rationale === "string" ? { rationale: uv.rationale } : {}),
      ...(typeof uv.previewHtml === "string" && uv.previewHtml.trim() !== ""
        ? { previewHtml: uv.previewHtml }
        : {}),
      ...(safeCssColor(uv.previewBackground)
        ? { previewBackground: safeCssColor(uv.previewBackground) }
        : {}),
      ...(swap
        ? {
            swap: {
              cssChanges: sanitizeCssMap(swap.cssChanges),
              html: typeof swap.html === "string" ? swap.html : undefined,
            },
          }
        : {}),
      ...(typeof uv.summary === "string" ? { summary: uv.summary } : {}),
    };
    if (Object.keys(updatedVariant).length === 0) updatedVariant = undefined;
  }
  if (!reply && !updatedVariant) return null;
  return {
    variantId: typeof obj.variantId === "string" ? obj.variantId : undefined,
    reply: reply || "Updated the variant.",
    updatedVariant,
  };
}

export function parseApplyResult(summary: string): {
  variantId?: string;
  summary: string;
  files: { path: string; note?: string }[];
} | null {
  const obj = tryParse(summary);
  if (!obj) return null;
  const typeOk =
    typeof obj.type === "string"
      ? APPLIED_TYPE_ALIASES.has(obj.type)
      : typeof obj.variantId === "string"; // duck-type
  if (!typeOk) return null;
  const files: { path: string; note?: string }[] = [];
  if (Array.isArray(obj.files)) {
    for (const raw of obj.files) {
      const f = asRecord(raw);
      if (f && typeof f.path === "string" && f.path) {
        files.push({
          path: f.path,
          note: typeof f.note === "string" ? f.note : undefined,
        });
      }
    }
  }
  return {
    variantId: typeof obj.variantId === "string" ? obj.variantId : undefined,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    files,
  };
}

export function parsePagesResult(summary: string): PageEntry[] | null {
  const obj = tryParse(summary);
  if (!obj) return null;
  const typeOk =
    typeof obj.type === "string"
      ? PAGES_TYPE_ALIASES.has(obj.type)
      : Array.isArray(obj.pages); // duck-type
  if (!typeOk || !Array.isArray(obj.pages)) return null;
  const pages: PageEntry[] = [];
  for (const raw of obj.pages) {
    const p = asRecord(raw);
    if (!p || typeof p.path !== "string") continue;
    const path = p.path.trim();
    // Same-origin routes only — the gallery iframes the dev server, never
    // an absolute URL the agent chose.
    if (!path.startsWith("/")) continue;
    pages.push({
      path,
      label:
        typeof p.label === "string" && p.label.trim() !== ""
          ? p.label.trim()
          : path,
    });
    if (pages.length >= MAX_PAGES) break;
  }
  return pages.length > 0 ? pages : null;
}

// ---------------------------------------------------------------------------
// Post-apply match check. After variants-apply hot-reloads, the content
// script renders the card markup off-screen (same shadow context as the
// on-page preview) and walks it alongside the live element, comparing a
// fixed set of computed properties. Deterministic, zero agent tokens —
// the agent is only involved when the user asks to fix the differences.

/** One computed-style property that differs between card and page. */
export type RenderDiff = {
  /** Human + agent readable node path, e.g. `root › span[1] "In progress"`. */
  path: string;
  prop: string;
  expected: string;
  actual: string;
};

export type RenderCheck = {
  /** 0–100, share of compared properties that match. */
  score: number;
  checked: number;
  matched: number;
  diffs: RenderDiff[];
  /** Nodes present in the card with no counterpart on the page. */
  missing: string[];
};

/** Text properties — compared only on nodes that render their own text
 *  (a wrapper's inherited font size is noise). Icons compare `color`
 *  because SVG strokes use currentColor. */
const MATCH_PROPS_TEXT = [
  "color",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-transform",
  "text-align",
] as const;
/** Box properties — compared on every node. */
const MATCH_PROPS_BASE = [
  "background-color",
  "background-image",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "box-shadow",
  "opacity",
  "display",
  "position",
  "overflow-x",
  "overflow-y",
  "row-gap",
  "column-gap",
  "max-width",
] as const;
const MATCH_PROPS_OFFSETS = ["top", "right", "bottom", "left"] as const;
const MATCH_PROPS_MARGIN = [
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
] as const;
const BORDER_SIDES = ["top", "right", "bottom", "left"] as const;

/** Cap on diffs kept for the UI and the fix payload (token economy). */
export const MAX_RENDER_DIFFS = 24;

type StyleOf = (el: Element) => { getPropertyValue(prop: string): string };

const SKIP_TAGS = new Set(["STYLE", "SCRIPT", "TEMPLATE", "LINK", "META"]);

function kids(el: Element): Element[] {
  return Array.from(el.children).filter(
    (c) => !SKIP_TAGS.has(c.tagName.toUpperCase()),
  );
}

function normText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Raw text is read in windows of at least this many chars, so a huge
 *  text node is never whitespace-collapsed in one go. */
const BOUNDED_TEXT_WINDOW = 256;

/**
 * normText, but stops reading once the result is known to be longer than
 * `maxLen`. When the element's normalized text fits, the return value is
 * identical to normText(el); otherwise it is a prefix of it whose length
 * is > maxLen (enough for "too long" decisions without reading a whole
 * page's textContent).
 */
export function boundedNormText(el: Element, maxLen: number): string {
  const doc = el.ownerDocument;
  // SHOW_TEXT | SHOW_CDATA_SECTION — the node set textContent concatenates.
  const walker = doc.createTreeWalker(el, 0x4 | 0x8);
  let acc = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = (n as CharacterData).data;
    for (let off = 0; off < data.length; ) {
      const size = Math.max(BOUNDED_TEXT_WINDOW, Math.ceil(maxLen - acc.length) + 1);
      let chunk = data.slice(off, off + size).replace(/\s+/g, " ");
      off += size;
      // Collapse a whitespace run split across nodes / windows; drop leading.
      if (chunk.startsWith(" ") && (acc === "" || acc.endsWith(" "))) chunk = chunk.slice(1);
      acc += chunk;
      if (acc.trimEnd().length > maxLen) return acc.trimEnd();
    }
  }
  return acc.trimEnd();
}

function nodeLabel(el: Element, index: number | null): string {
  const tag = el.tagName.toLowerCase();
  const text = normText(el);
  const short = text.length > 24 ? `${text.slice(0, 24)}…` : text;
  return `${tag}${index === null ? "" : `[${index}]`}${short ? ` "${short}"` : ""}`;
}

/** Drop fully transparent / all-zero box-shadow layers (Tailwind ring
 *  and shadow utilities emit `rgba(0,0,0,0) 0px 0px 0px 0px` fillers). */
function normShadow(v: string): string {
  if (v === "none") return "none";
  const layers: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      layers.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) layers.push(cur.trim());
  const kept = layers.filter((l) => {
    if (/rgba\([^)]*,\s*0\)/.test(l) || /\btransparent\b/.test(l)) return false;
    const nums = (l.replace(/rgba?\([^)]*\)/g, "").match(/-?\d*\.?\d+/g) ?? []).map(Number);
    return nums.some((n) => n !== 0);
  });
  return kept.length === 0 ? "none" : kept.join(", ");
}

function normValue(prop: string, v: string): string {
  let out = v.replace(/\s+/g, " ").trim();
  if (prop === "box-shadow") out = normShadow(out);
  if (prop.endsWith("color") && /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(out)) {
    out = "transparent";
  }
  return out;
}

/** Equal after normalizing, allowing tiny numeric drift (sub-pixel
 *  rounding, color channel rounding, alpha precision). */
export function cssValuesMatch(prop: string, a: string, b: string): boolean {
  const x = normValue(prop, a);
  const y = normValue(prop, b);
  if (x === y) return true;
  const numRe = /-?\d*\.?\d+(e-?\d+)?/gi;
  if (x.replace(numRe, "#") !== y.replace(numRe, "#")) return false;
  const xs = (x.match(numRe) ?? []).map(Number);
  const ys = (y.match(numRe) ?? []).map(Number);
  if (xs.length !== ys.length) return false;
  return xs.every((n, i) => {
    const m = ys[i]!;
    const tol = Math.abs(n) <= 1 && Math.abs(m) <= 1 ? 0.03 : 1;
    return Math.abs(n - m) <= tol;
  });
}

/** Pair expected children with actual children. Index pairing when the
 *  counts agree AND every pair carries the same text; otherwise pair in
 *  order by text (text-less nodes such as icons pair by tag). */
function pairChildren(
  exp: Element[],
  act: Element[],
): { pairs: [Element, Element, number][]; missing: [Element, number][] } {
  // Each child's text is computed once (it was re-read per comparison).
  const expText = exp.map(normText);
  const actText = act.map(normText);
  const aligned =
    exp.length === act.length &&
    expText.every((t, i) => t === actText[i]);
  if (aligned) {
    return { pairs: exp.map((e, i) => [e, act[i]!, i]), missing: [] };
  }
  const pairs: [Element, Element, number][] = [];
  const missing: [Element, number][] = [];
  let from = 0;
  exp.forEach((e, i) => {
    const t = expText[i]!;
    const k = act.findIndex((a, j) => {
      if (j < from) return false;
      if (t !== "") return actText[j] === t;
      return a.tagName === e.tagName && actText[j] === "";
    });
    if (k >= 0) {
      pairs.push([e, act[k]!, i]);
      from = k + 1;
    } else missing.push([e, i]);
  });
  return { pairs, missing };
}

/**
 * Default-style lookup for "did the card actually set this?". Probes a
 * bare element of the same tag inside `container` (the card's shadow
 * wrapper) and caches its computed values per tag.
 */
export function makeDefaultStyleOf(container: Element): StyleOf {
  const cache = new Map<string, Map<string, string>>();
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  const keyOf = (el: Element) => `${el.namespaceURI}|${el.localName}`;
  /** Probe every tag in `els` at once: append all probes, read all,
   *  remove all — one style recalc instead of one per tag. */
  const warm = (els: Iterable<Element>) => {
    const probes: [string, Element][] = [];
    for (const el of els) {
      const key = keyOf(el);
      if (cache.has(key) || probes.some(([k]) => k === key)) continue;
      probes.push([key, doc.createElementNS(el.namespaceURI ?? HTML_NS, el.localName)]);
    }
    if (probes.length === 0) return;
    container.append(...probes.map(([, p]) => p));
    for (const [key, probe] of probes) {
      const cs = view?.getComputedStyle(probe);
      const snap = new Map<string, string>();
      for (const prop of MATCH_PROPS_TEXT) snap.set(prop, cs?.getPropertyValue(prop) ?? "");
      cache.set(key, snap);
    }
    for (const [, probe] of probes) probe.remove();
  };
  // The card tree is already inside `container` — pre-probe its tags.
  warm(Array.from(container.getElementsByTagName("*")));
  return (el: Element) => {
    const key = keyOf(el);
    if (!cache.has(key)) warm([el]);
    const values = cache.get(key)!;
    return { getPropertyValue: (prop: string) => values.get(prop) ?? "" };
  };
}

/**
 * Compare a rendered card tree (`expected`) with the live element
 * (`actual`). Text content is NOT compared (it's real data); SVG
 * internals are compared only at the <svg> box. The root's outer margins
 * are skipped — the page owns the element's placement.
 *
 * Environment noise is ignored so a faithful apply can reach 100%:
 *  - text props the card leaves at their default (per `defaultStyleOf`)
 *    — the page's inherited base line-height / font size aren't the card's;
 *  - top/right/bottom/left the card doesn't set inline (computed offsets
 *    are derived from the opposite side and the box height);
 *  - `display` on <svg>/<img> (CSS resets make them block; the box is
 *    still compared via width/height).
 */
export function diffRenderedTrees(
  expected: Element,
  actual: Element,
  styleOf: StyleOf,
  defaultStyleOf?: StyleOf,
): RenderCheck {
  let checked = 0;
  let matched = 0;
  const diffs: RenderDiff[] = [];
  const missing: string[] = [];

  const visit = (e: Element, a: Element, path: string, isRoot: boolean) => {
    const es = styleOf(e);
    const as = styleOf(a);
    const tag = e.tagName.toUpperCase();
    const isGraphic = tag === "SVG" || tag === "IMG";
    const ownText = Array.from(e.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
    );
    const props: string[] = MATCH_PROPS_BASE.filter(
      (prop) => !(isGraphic && prop === "display"),
    );
    const textProps: string[] = ownText
      ? [...MATCH_PROPS_TEXT]
      : isGraphic
        ? ["color"]
        : [];
    const ds = defaultStyleOf?.(e);
    for (const prop of textProps) {
      // Card left it at the default → the page's inherited value is fine.
      if (ds && cssValuesMatch(prop, es.getPropertyValue(prop), ds.getPropertyValue(prop))) continue;
      props.push(prop);
    }
    if (!isRoot) props.push(...MATCH_PROPS_MARGIN);
    if (es.getPropertyValue("position") !== "static") {
      const inline = (e as HTMLElement).style;
      for (const side of MATCH_PROPS_OFFSETS) {
        if (inline?.getPropertyValue(side)) props.push(side);
      }
    }
    for (const side of BORDER_SIDES) {
      const w = parseFloat(es.getPropertyValue(`border-${side}-width`)) || 0;
      const wa = parseFloat(as.getPropertyValue(`border-${side}-width`)) || 0;
      if (w > 0 || wa > 0) {
        props.push(`border-${side}-width`, `border-${side}-style`, `border-${side}-color`);
      }
    }
    if (isGraphic) props.push("width", "height");
    for (const prop of props) {
      const ev = es.getPropertyValue(prop);
      const av = as.getPropertyValue(prop);
      checked++;
      if (cssValuesMatch(prop, ev, av)) matched++;
      else if (diffs.length < MAX_RENDER_DIFFS) {
        diffs.push({
          path,
          prop,
          expected: diffValueForWire(normValue(prop, ev)),
          actual: diffValueForWire(normValue(prop, av)),
        });
      }
    }
    if (isGraphic) return;
    const { pairs, missing: gone } = pairChildren(kids(e), kids(a));
    for (const [ce, ca, i] of pairs) {
      visit(ce, ca, `${path} › ${nodeLabel(ce, i)}`, false);
    }
    for (const [ce, i] of gone) {
      checked++;
      missing.push(`${path} › ${nodeLabel(ce, i)}`);
    }
  };

  visit(expected, actual, `root ${nodeLabel(expected, null)}`.trim(), true);
  const score = checked === 0 ? 100 : Math.round((matched / checked) * 100);
  return { score, checked, matched, diffs, missing };
}

/** Bounds for locateAppliedElement's page walk (big SPAs have 50k+ nodes). */
export const LOCATE_MAX_VISITED = 20_000;
export const LOCATE_MAX_CANDIDATES = 300;
const LOCATE_POINT_CANDIDATES = 30;
const LOCATE_SKIP_SUBTREES = new Set(["svg", "script", "style", "template", "noscript"]);

export type LocateOptions = {
  /** Allow the bounded whole-page walk (default true). The auto check
   *  passes false on early retries — the hot-reload is usually still
   *  landing, and the walk is the expensive step. */
  allowGlobal?: boolean;
  /** Where the element sat when it was picked (viewport CSS px) — probed
   *  with elementsFromPoint before any walk. */
  rect?: { x: number; y: number; width: number; height: number };
};

/**
 * After an apply the element's classes change, so its recorded selector
 * usually stops matching. Candidate order: the full selector; the
 * children of the selector's PARENT path; the elements stacked at the
 * original rect's center (+ ancestors); then — only when allowed — a
 * bounded walk of the page. The winner is the candidate whose text best
 * matches the card's text (token overlap ≥ 0.6). Text-less cards (icon
 * buttons) can't be scored: they trust the exact selector hit, else a
 * same-tag child of the parent path. Returns null when nothing plausible
 * is found.
 */
export function locateAppliedElement(
  doc: Document,
  selector: string | undefined,
  expectedText: string,
  opts: LocateOptions = {},
): Element | null {
  const want = tokenSet(expectedText);
  const textless = want.size === 0;
  const texts = new Map<Element, string>();
  const textOf = (el: Element): string => {
    let t = texts.get(el);
    if (t === undefined) texts.set(el, (t = normText(el)));
    return t;
  };
  const score = (el: Element): number => overlap(want, tokenSet(textOf(el)));
  const best = (cands: Iterable<Element>): Element | null => {
    let top: Element | null = null;
    let topScore = 0.6;
    for (const c of cands) {
      const s = score(c);
      // Prefer the DEEPEST element on ties — ancestors contain the same text.
      if (s > topScore || (s === topScore && top && top.contains(c))) {
        top = c;
        topScore = s;
      }
    }
    return top;
  };
  const query = (sel: string): Element | null => {
    try {
      return doc.querySelector(sel);
    } catch {
      return null; // invalid selector
    }
  };

  if (selector) {
    const exact = query(selector);
    if (exact && (textless || score(exact) >= 0.6)) return exact;
    const cut = selector.lastIndexOf(" > ");
    const parent = cut > 0 ? query(selector.slice(0, cut)) : null;
    if (parent) {
      const kids = Array.from(parent.children);
      if (textless) {
        const last = selector.slice(cut + 3);
        const tag = /^[a-z][a-z0-9-]*/i.exec(last)?.[0]?.toLowerCase();
        const nth = /:nth-child\((\d+)\)/.exec(last);
        const byIndex = nth ? kids[Number(nth[1]) - 1] : undefined;
        if (byIndex && (!tag || byIndex.localName === tag)) return byIndex;
        const sameTag = kids.filter((k) => k.localName === tag);
        return sameTag.length === 1 ? sameTag[0]! : null;
      }
      const hit = best(kids);
      if (hit) return hit;
    }
  }
  if (textless) return null;

  // Whatever now sits where the element was picked.
  const r = opts.rect;
  const view = doc.defaultView;
  if (r && typeof doc.elementsFromPoint === "function" && view) {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx < view.innerWidth && cy < view.innerHeight) {
      const seen = new Set<Element>();
      for (const top of doc.elementsFromPoint(cx, cy)) {
        for (let el: Element | null = top; el && el !== doc.body; el = el.parentElement) {
          if (seen.size >= LOCATE_POINT_CANDIDATES || seen.has(el)) break;
          seen.add(el);
        }
        if (seen.size >= LOCATE_POINT_CANDIDATES) break;
      }
      const hit = best(seen);
      if (hit) return hit;
    }
  }

  if (opts.allowGlobal === false || !doc.body) return null;
  // Bounded walk. A subtree whose text is already too SHORT can't contain
  // a match (descendants only get shorter), so it's skipped whole.
  const wantLen = expectedText.replace(/\s+/g, " ").trim().length;
  const minLen = wantLen * 0.7;
  const maxLen = wantLen * 1.4;
  const cands: Element[] = [];
  const stack: Element[] = Array.from(doc.body.children).reverse();
  let visited = 0;
  while (stack.length > 0 && visited < LOCATE_MAX_VISITED && cands.length < LOCATE_MAX_CANDIDATES) {
    const el = stack.pop()!;
    visited++;
    if (LOCATE_SKIP_SUBTREES.has(el.localName.toLowerCase())) continue;
    // Only as much text as the length test needs: a page-level wrapper's
    // full textContent can be megabytes. Cached full text wins when present.
    const len = (texts.get(el) ?? boundedNormText(el, maxLen)).length;
    if (len < minLen) continue;
    if (len <= maxLen) cands.push(el);
    const kids = el.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return best(cands);
}

/** Node path for the AGENT (the UI keeps the full one): quoted page-text
 *  snippets removed — page text is data, and a hiding place for
 *  instructions — and only the last 3 segments kept (token economy). */
export function diffPathForAgent(path: string): string {
  if (typeof path !== "string") return "";
  return path
    .replace(/ "[\s\S]*?"(?= › |$)/g, "")
    .split(" › ")
    .slice(-3)
    .join(" › ")
    .slice(0, 160);
}

/** Diff values ride to the agent: no URLs, bounded length. */
function diffValueForWire(v: string): string {
  if (/url\s*\(|image-set\s*\(/i.test(v)) return "url(…)";
  return v.length > 120 ? `${v.slice(0, 119)}…` : v;
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / Math.max(a.size, b.size);
}
