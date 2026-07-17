// Color harvesting for the Paint tool. Scrapes the colors the page
// ALREADY uses (backgrounds, text, borders) so the user recolors an
// element from the site's own palette instead of inventing a new hex.
// `normalizeColor` / `rankColors` are pure so they can be unit-tested
// without a DOM; `harvestPageColors` is the thin DOM-facing wrapper.

export type Swatch = {
  /** Uppercase `#RRGGBB`. */
  color: string;
  /** How many elements used it — drives palette ordering. */
  count: number;
};

const OVERLAY_HOST_TAG = "PINTA-OVERLAY-HOST";

/** Alpha below this reads as "not really a color" — skip it so the
 *  palette isn't polluted by invisible overlay/scrim layers. */
const MIN_ALPHA = 0.1;

function parseAlpha(raw: string): number {
  const s = raw.trim();
  if (s.endsWith("%")) {
    const n = parseFloat(s.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : 1;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 1;
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    "#" +
    [r, g, b]
      .map((n) => clamp(n).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

/**
 * Normalize any computed color string to `#RRGGBB`. Returns null for
 * values that aren't a usable solid color: `transparent`, `none`, an
 * unparseable keyword, or anything with alpha under {@link MIN_ALPHA}.
 * Alpha is dropped on the way to hex — the swatch represents the hue the
 * user pointed at, and the agent applies it as a plain color. Pure.
 */
export function normalizeColor(css: string): string | null {
  if (!css) return null;
  const s = css.trim().toLowerCase();
  if (s === "transparent" || s === "none" || s === "currentcolor") return null;

  // rgb(r, g, b) / rgba(r, g, b, a) / rgb(r g b / a). Channels allow a
  // leading minus so out-of-range input still parses and gets clamped
  // rather than silently dropping the whole color.
  const m =
    /^rgba?\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)\s*(?:[,/]\s*([\d.%]+)\s*)?\)$/.exec(
      s,
    );
  if (m) {
    if (m[4] != null && parseAlpha(m[4]) < MIN_ALPHA) return null;
    return toHex(parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!));
  }

  if (/^#[0-9a-f]{6}$/.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return ("#" + s[1]! + s[1]! + s[2]! + s[2]! + s[3]! + s[3]!).toUpperCase();
  }
  return null;
}

/**
 * Count + rank raw color strings into a palette, most-used first. Ties
 * keep first-seen order so the result is stable across runs. Pure.
 */
export function rankColors(samples: string[], limit = 24): Swatch[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const raw of samples) {
    const hex = normalizeColor(raw);
    if (!hex) continue;
    if (!counts.has(hex)) order.push(hex);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return order
    .map((color) => ({ color, count: counts.get(color)! }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Walk the rendered page and collect the colors it actually uses. Only
 * looks at elements with a real box (skips display:none / zero-size) and
 * ignores Pinta's own overlay. `maxElements` caps the walk so a huge DOM
 * can't stall the picker — the first N rendered elements are a good
 * sample of the design system in play.
 */
export function harvestPageColors(
  maxElements = 2500,
  limit = 24,
): Swatch[] {
  if (typeof document === "undefined" || !document.body) return [];
  const all = document.body.getElementsByTagName("*");
  const samples: string[] = [];
  const n = Math.min(all.length, maxElements);
  for (let i = 0; i < n; i++) {
    const el = all[i]!;
    if (el.tagName === OVERLAY_HOST_TAG) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = window.getComputedStyle(el);
    samples.push(cs.backgroundColor, cs.color, cs.borderTopColor);
  }
  return rankColors(samples, limit);
}

/**
 * The color a user means when they point AT an element — its background
 * when it has a solid one (the navy button case), else its text color.
 * Returns null when the element has neither. DOM-facing.
 */
export function sampleElementColor(el: Element): string | null {
  const cs = window.getComputedStyle(el);
  return normalizeColor(cs.backgroundColor) ?? normalizeColor(cs.color);
}
