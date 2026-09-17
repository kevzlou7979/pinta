// Relative-unit helpers for the inline element editor (and anything else
// that shows a computed length back to the user).
//
// The browser reports computed styles in px. Handing those straight to the
// agent bakes fixed pixels into the project's source — type stops scaling
// with the user's browser font size, and spacing stops following the design
// system's scale. So the editor shows lengths in a RELATIVE unit by default
// and only falls back to px when the user asks for it.
//
// `em` is relative to the element's own font size (for font-size itself:
// to the PARENT's), `rem` to the root font size.

/** Units the editor offers, in the order they appear in the picker. */
export const EDITOR_UNITS = ["em", "rem", "px", "%"] as const;
export type EditorUnit = (typeof EDITOR_UNITS)[number];

/** Font sizes a conversion is relative to (CSS px). */
export type UnitBases = {
  /** The element's own computed font-size — the base for `em` on lengths. */
  ownFontSize: number;
  /** The parent's computed font-size — the base for `em` on `font-size`. */
  parentFontSize: number;
  /** The root (<html>) font-size — the base for `rem`. */
  rootFontSize: number;
  /** The parent's content-box width, for `%` on widths/padding/margins.
   *  Omitted (or 0) when unknown — `%` then leaves the value alone rather
   *  than inventing a base. */
  parentWidth?: number;
};

export const DEFAULT_BASES: UnitBases = {
  ownFontSize: 16,
  parentFontSize: 16,
  rootFontSize: 16,
};

/** Keywords that must never be converted (`auto`, `normal`, …). */
const KEYWORDS = new Set([
  "auto",
  "normal",
  "none",
  "inherit",
  "initial",
  "unset",
  "revert",
  "fit-content",
  "max-content",
  "min-content",
]);

const LENGTH_RE = /^(-?\d*\.?\d+)(px|em|rem|%|rlh|lh|ch|ex|vw|vh|vmin|vmax|pt|pc|cm|mm|in)?$/i;

/**
 * Deliberate per-property defaults. Two rules, not one:
 *  - `font-size` is `em` so a heading stays proportional to whatever it
 *    sits in — that's the unit a designer means by "one and a half times".
 *  - everything else is `rem`, because spacing, sizing and radii come out
 *    of the design system's root-based scale; pinning them to the
 *    element's own font size would double a card's padding the moment its
 *    type got bigger.
 * Anything not listed falls through to `rem` for the same reason.
 */
const DEFAULT_UNITS: Record<string, EditorUnit> = {
  "font-size": "em",
  width: "rem",
  height: "rem",
  "min-width": "rem",
  "max-width": "rem",
  "min-height": "rem",
  "max-height": "rem",
  padding: "rem",
  margin: "rem",
  gap: "rem",
  "border-radius": "rem",
};

/** The unit the editor starts in for a property. Type and spacing scale
 *  with the user's font size; raw pixels are opt-in. */
export function defaultUnitFor(prop: string): EditorUnit {
  return DEFAULT_UNITS[prop.toLowerCase()] ?? "rem";
}

/** Box properties whose `%` is a share of the parent's inline size — the
 *  only ones a measured parent width can re-express. `height` (% of the
 *  parent's *height*), `border-radius` and `gap` (% of the element's own
 *  box) are deliberately absent: converting those off a width would change
 *  what the value means, so they're left alone instead. */
const PERCENT_OF_PARENT_WIDTH = new Set([
  "width",
  "min-width",
  "max-width",
  "padding",
  "margin",
]);

/** px value a unit is measured against for `prop`. 0 means "no base
 *  available" — callers leave the value untouched rather than guess. */
export function baseFor(prop: string, unit: EditorUnit, bases: UnitBases): number {
  const p = prop.toLowerCase();
  if (unit === "rem") return bases.rootFontSize || 16;
  if (unit === "%") {
    // `%` on font-size is a share of the parent's font size.
    if (p === "font-size") return bases.parentFontSize || 16;
    return PERCENT_OF_PARENT_WIDTH.has(p) ? bases.parentWidth || 0 : 0;
  }
  // em
  return (p === "font-size" ? bases.parentFontSize : bases.ownFontSize) || 16;
}

/** Trim a converted number: 1.5 not 1.500, 1 not 1.0000001. */
export function trimNumber(n: number, decimals = 3): string {
  if (!Number.isFinite(n)) return "0";
  const fixed = n.toFixed(decimals);
  // Strip zeros only when there IS a fraction: doing it unconditionally
  // turns "100" into "1" once `decimals` is 0.
  if (!fixed.includes(".")) return fixed;
  return fixed.replace(/0+$/, "").replace(/\.$/, "") || "0";
}

/** Parse one length token. Returns null for keywords, calc(), var() etc. */
export function parseLength(
  value: string,
): { n: number; unit: string } | null {
  const v = (value ?? "").trim();
  if (v === "" || KEYWORDS.has(v.toLowerCase())) return null;
  const m = LENGTH_RE.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return { n, unit: (m[2] ?? "").toLowerCase() };
}

/** Convert a single length token to `unit`. Anything that isn't a plain
 *  px / em / rem / % length (keywords, calc(), var(), 0) is returned
 *  unchanged — converting those would change meaning. */
export function convertLength(
  value: string,
  prop: string,
  unit: EditorUnit,
  bases: UnitBases,
): string {
  const parsed = parseLength(value);
  if (!parsed) return (value ?? "").trim();
  const { n, unit: from } = parsed;
  if (n === 0) return "0";
  // Everything we can reason about relative to a px base.
  const fromBase =
    from === "" || from === "px"
      ? 1
      : from === "em" || from === "rem" || from === "%"
        ? baseFor(prop, from as EditorUnit, bases) / (from === "%" ? 100 : 1)
        : null;
  // vh, ch, pt… — and `%` with no measured parent width. Leave alone.
  if (fromBase === null || fromBase === 0) return value.trim();
  const px = n * fromBase;
  if (unit === "px") return `${trimNumber(px, 2)}px`;
  const toBase = baseFor(prop, unit, bases);
  if (!toBase) return value.trim();
  const out = unit === "%" ? (px / toBase) * 100 : px / toBase;
  // Shortest decimal form that still reads back as the same px value:
  // 24px → "1.5em" stays pretty, 13px → "0.5417em" stays accurate (a
  // 3-decimal "0.542em" would round-trip to 13.01px and look like an edit).
  const pxPerUnit = unit === "%" ? toBase / 100 : toBase;
  for (let d = 1; d <= 4; d++) {
    const s = trimNumber(out, d);
    if (Math.abs(Number(s) * pxPerUnit - px) < 0.005) return `${s}${unit}`;
  }
  return `${trimNumber(out, 5)}${unit}`;
}

/** Convert every token of a shorthand ("8px 16px" → "0.5em 1em"). */
export function convertShorthand(
  value: string,
  prop: string,
  unit: EditorUnit,
  bases: UnitBases,
): string {
  const v = (value ?? "").trim();
  if (v === "") return "";
  if (/[(),]/.test(v)) return v; // calc(), var(), clamp() — hands off
  return v
    .split(/\s+/)
    .map((part) => convertLength(part, prop, unit, bases))
    .join(" ");
}

/**
 * Give any bare number in `value` the unit the user is looking at, so the
 * editor never submits a unitless length ("24" → "24rem"). 0, keywords and
 * function values are left alone.
 */
export function ensureUnits(value: string, unit: EditorUnit): string {
  const v = (value ?? "").trim();
  if (v === "" || /[(),]/.test(v)) return v;
  return v
    .split(/\s+/)
    .map((part) => {
      const parsed = parseLength(part);
      if (!parsed || parsed.unit !== "" || parsed.n === 0) return part;
      return `${trimNumber(parsed.n)}${unit}`;
    })
    .join(" ");
}

/**
 * line-height reads best unitless — it then scales with whatever font size
 * the element ends up with. Converts a computed "38.4px" against the
 * element's font size to "1.6"; leaves "normal" and existing ratios alone.
 */
export function toUnitlessLineHeight(value: string, ownFontSize: number): string {
  const parsed = parseLength(value);
  if (!parsed) return (value ?? "").trim();
  if (parsed.unit === "") return trimNumber(parsed.n, 2);
  if (!ownFontSize) return value.trim();
  const px =
    parsed.unit === "px"
      ? parsed.n
      : parsed.unit === "em" || parsed.unit === "rem"
        ? parsed.n * ownFontSize
        : parsed.unit === "%"
          ? (parsed.n / 100) * ownFontSize
          : null;
  if (px === null) return value.trim();
  return trimNumber(px / ownFontSize, 2);
}

/** True when a value is already expressed in a unit that scales (em, rem,
 *  %, ch, vw…) or is unitless / a keyword. Used to flag px-only values. */
export function isResponsiveLength(value: string): boolean {
  const parsed = parseLength(value);
  if (!parsed) return true; // keyword / calc() / var()
  if (parsed.n === 0) return true;
  return parsed.unit !== "px" && parsed.unit !== "";
}
