// Draw-style model shared by the side panel's options strip, the on-page
// floating palette, and the content canvas. The LIVE style (always-present
// fields) persists under `pinta-draw-style` in chrome.storage.local; every
// surface reads + writes that one key and syncs via storage.onChanged.
// Annotations ship the lean wire form (non-defaults only) — token economy.

import type { DrawStyle } from "@pinta/shared";

export type DrawStyleState = {
  color: string;
  width: number;
  fill: "none" | "translucent" | "solid";
  radius: number;
  dashed: boolean;
};

export const DRAW_STYLE_KEY = "pinta-draw-style";

export const DRAW_STYLE_DEFAULT: DrawStyleState = {
  color: "#FF3D6E",
  width: 3,
  fill: "none",
  radius: 0,
  dashed: false,
};

/** Swatches offered in the options strips (drawn content, not UI chrome —
 *  the primary-only rule doesn't apply to what the user draws). */
export const DRAW_COLORS: { hex: string; name: string }[] = [
  { hex: "#FF3D6E", name: "Pink" },
  { hex: "#FF8855", name: "Orange" },
  { hex: "#FFD24D", name: "Yellow" },
  { hex: "#10B981", name: "Green" },
  { hex: "#2563EB", name: "Blue" },
  { hex: "#1A1A1A", name: "Ink" },
];

export const DRAW_WIDTHS: { value: number; label: string }[] = [
  { value: 2, label: "S" },
  { value: 3, label: "M" },
  { value: 5, label: "L" },
];

export const DRAW_RADII: number[] = [0, 8, 16];

/** Collapse the live style to the lean wire form (non-defaults only). */
export function wireDrawStyle(s: DrawStyleState): DrawStyle | undefined {
  const out: DrawStyle = {};
  if (s.width !== DRAW_STYLE_DEFAULT.width) out.width = s.width;
  if (s.fill !== "none") out.fill = s.fill;
  if (s.radius > 0) out.radius = s.radius;
  if (s.dashed) out.dashed = true;
  return Object.keys(out).length ? out : undefined;
}

/** Parse a stored value defensively (older/foreign shapes → defaults). */
export function readDrawStyle(raw: unknown): DrawStyleState {
  const r = (raw ?? {}) as Partial<DrawStyleState>;
  return {
    color: typeof r.color === "string" ? r.color : DRAW_STYLE_DEFAULT.color,
    width: typeof r.width === "number" ? r.width : DRAW_STYLE_DEFAULT.width,
    fill: r.fill === "translucent" || r.fill === "solid" ? r.fill : "none",
    radius: typeof r.radius === "number" ? r.radius : 0,
    dashed: r.dashed === true,
  };
}
