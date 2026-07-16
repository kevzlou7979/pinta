// Per-entry "Screenshot" renderer for the Report module (Phase 16).
//
// Turns a single ReportItem into a clean, shareable PNG — the thing you
// paste into Slack / a ticket / a doc. Rendered with the native canvas 2D
// API (same dependency-free technique as composite.ts), so there's no
// DOM-snapshot library and no bundle bloat.
//
// The image is ALWAYS light (white card, dark text) regardless of the side
// panel's theme, so it reads on any background. Canvas needs raw hex, so the
// category palette here is a deliberate small parallel to ReportTab's
// `chipClass()` (which emits Tailwind classes the canvas can't use).
//
// Layout is computed in CSS px then up-scaled by devicePixelRatio for a
// crisp bitmap. The drawing path only runs in the browser; the pure helpers
// (`itemImageFilename`, `dataUrlToBlob`) are unit-tested under Node.

import {
  categoryLabel,
  formatDayHeading,
  formatFileSummary,
  humanizeReportTitle,
  type ReportCategory,
  type ReportItem,
} from "./report.js";

/** Light-theme chip colors (bg/fg hex), mirroring ReportTab.chipClass().
 *  Values are the Tailwind {100}/{700-800} pairs that map's classes use. */
export const CATEGORY_IMAGE_COLORS: Record<
  ReportCategory,
  { bg: string; fg: string }
> = {
  "bug-fix": { bg: "#fee2e2", fg: "#b91c1c" },
  feature: { bg: "#dbeafe", fg: "#1d4ed8" },
  polish: { bg: "#f3e8ff", fg: "#7e22ce" },
  test: { bg: "#d1fae5", fg: "#047857" },
  annotate: { bg: "#fce7f3", fg: "#be185d" },
  deps: { bg: "#fef3c7", fg: "#92400e" },
  docs: { bg: "#cffafe", fg: "#0e7490" },
  merge: { bg: "#f1f5f9", fg: "#475569" },
  chore: { bg: "#f1f5f9", fg: "#475569" },
};

// Neutral palette (Tailwind ink scale, see tailwind.config.js).
const C = {
  backdrop: "#eef2f6",
  card: "#ffffff",
  border: "#e2e8f0", // ink-200
  title: "#0f172a", // ink-900
  detail: "#475569", // ink-600
  mute: "#64748b", // ink-500
  faint: "#94a3b8", // ink-400
  neutralBg: "#f1f5f9", // ink-100
  neutralFg: "#475569", // ink-600
  brand: "#FF3D6E", // brand-pink
};

const FONT_STACK =
  'Poppins, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

// Logical layout (CSS px). Height is computed from wrapped content.
const W = 640;
const MARGIN = 22; // backdrop gutter around the card
const PAD = 24; // card inner padding
const CARD_W = W - MARGIN * 2;
const CONTENT_W = CARD_W - PAD * 2;

export type ItemImageContext = {
  /** ISO yyyy-mm-dd the entry belongs to (drives the header date). */
  date: string;
  /** Report spans >1 repo → show the project tag pill. */
  multiProject: boolean;
};

/**
 * Render a single report entry to a light-theme PNG, returned as a data URL.
 * Browser-only (uses `document`/`canvas`). Throws if a 2D context can't be
 * obtained — callers surface that as a dismissible error.
 */
export function renderItemImagePng(
  item: ReportItem,
  ctx: ItemImageContext,
): string {
  const canvas = document.createElement("canvas");
  const c = canvas.getContext("2d");
  if (!c) throw new Error("Could not get a 2D canvas context for the screenshot.");

  // ── Measure pass — wrap text + accumulate the content height ──────────
  const title = humanizeReportTitle(item.title);
  setFont(c, 600, 18);
  const titleLines = wrapText(c, title, CONTENT_W);

  const detail = item.detail?.trim();
  let detailLines: string[] = [];
  if (detail) {
    setFont(c, 400, 13);
    detailLines = wrapText(c, detail, CONTENT_W);
  }

  const fileSummary = formatFileSummary(item);

  // Vertical budget (mirrors the paint pass below).
  let h = MARGIN + PAD;
  h += 22; // header row
  h += 18; // gap
  h += 22; // chip row
  h += 16; // gap
  if (item.ref) h += 18; // ref line
  h += titleLines.length * 24; // title
  if (detailLines.length) h += 8 + detailLines.length * 18;
  if (fileSummary) h += 12 + 16;
  h += PAD + MARGIN; // card bottom pad + backdrop gutter
  const H = Math.ceil(h);

  // ── Size the bitmap (DPR-scaled) and paint ───────────────────────────
  const scale = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  c.scale(scale, scale);

  // Backdrop + card with a soft shadow so it reads as a polished share card.
  c.fillStyle = C.backdrop;
  c.fillRect(0, 0, W, H);
  c.save();
  c.shadowColor = "rgba(15, 23, 42, 0.12)";
  c.shadowBlur = 18;
  c.shadowOffsetY = 6;
  roundRect(c, MARGIN, MARGIN, CARD_W, H - MARGIN * 2, 14);
  c.fillStyle = C.card;
  c.fill();
  c.restore();
  roundRect(c, MARGIN, MARGIN, CARD_W, H - MARGIN * 2, 14);
  c.strokeStyle = C.border;
  c.lineWidth = 1;
  c.stroke();

  const x = MARGIN + PAD;
  let y = MARGIN + PAD;

  // Header: Pinta glyph + wordmark (left), day label (right).
  drawBrandGlyph(c, x, y, 18);
  setFont(c, 600, 14);
  c.fillStyle = C.title;
  c.textBaseline = "alphabetic";
  c.fillText("Pinta", x + 26, y + 14);
  setFont(c, 500, 12);
  c.fillStyle = C.mute;
  c.textAlign = "right";
  c.fillText(formatDayHeading(ctx.date), MARGIN + CARD_W - PAD, y + 13);
  c.textAlign = "left";
  y += 22 + 18;

  // Chip row: category + optional project + optional Manual.
  let cx = x;
  cx += drawPill(
    c,
    cx,
    y,
    categoryLabel(item.category),
    CATEGORY_IMAGE_COLORS[item.category].bg,
    CATEGORY_IMAGE_COLORS[item.category].fg,
  );
  if (ctx.multiProject && item.project) {
    cx += 6;
    cx += drawPill(c, cx, y, item.project, C.neutralBg, C.neutralFg);
  }
  if (item.userAdded) {
    cx += 6;
    drawPill(c, cx, y, "Manual", C.neutralBg, C.mute);
  }
  y += 22 + 16;

  // Optional ref (mono pink), then the bold title.
  if (item.ref) {
    setFont(c, 600, 12, MONO_STACK);
    c.fillStyle = C.brand;
    c.fillText(item.ref, x, y + 12);
    y += 18;
  }
  setFont(c, 600, 18);
  c.fillStyle = C.title;
  for (const line of titleLines) {
    c.fillText(line, x, y + 18);
    y += 24;
  }

  // Optional detail.
  if (detailLines.length) {
    y += 8;
    setFont(c, 400, 13);
    c.fillStyle = C.detail;
    for (const line of detailLines) {
      c.fillText(line, x, y + 13);
      y += 18;
    }
  }

  // Optional changed-files summary, with a small page glyph.
  if (fileSummary) {
    y += 12;
    drawFileGlyph(c, x, y, C.faint);
    setFont(c, 400, 11.5, MONO_STACK);
    c.fillStyle = C.faint;
    c.fillText(fileSummary, x + 16, y + 11);
    y += 16;
  }

  return canvas.toDataURL("image/png");
}

/** Filename for a downloaded entry image — stable + readable.
 *  `pinta-report-item-<date>-<ref|slug>.png`. Pure → unit-tested. */
export function itemImageFilename(item: ReportItem, date: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const tail =
    (item.ref && slug(item.ref)) ||
    (item.title && slug(humanizeReportTitle(item.title))) ||
    slug(item.id) ||
    "entry";
  return `pinta-report-item-${date}-${tail}.png`;
}

/** Convert a `data:` URL to a Blob (for clipboard write + download).
 *  Pure (uses `atob`/`Blob`, both present in Node) → unit-tested. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma === -1) {
    throw new Error("Not a data URL");
  }
  const header = dataUrl.slice(5, comma); // e.g. "image/png;base64"
  const isBase64 = /;base64$/i.test(header);
  const mime = header.replace(/;base64$/i, "") || "application/octet-stream";
  const data = dataUrl.slice(comma + 1);
  if (!isBase64) {
    return new Blob([decodeURIComponent(data)], { type: mime });
  }
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// ─── canvas helpers ──────────────────────────────────────────────────

function setFont(
  c: CanvasRenderingContext2D,
  weight: number,
  size: number,
  stack: string = FONT_STACK,
): void {
  c.font = `${weight} ${size}px ${stack}`;
}

/** Greedy word-wrap to `maxWidth`. Falls back to a hard char-break for a
 *  single token longer than the line (long paths/refs). */
function wrapText(
  c: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const push = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (c.measureText(next).width <= maxWidth || !line) {
      // A lone word wider than the line gets hard-broken.
      if (!line && c.measureText(word).width > maxWidth) {
        let chunk = "";
        for (const ch of word) {
          if (c.measureText(chunk + ch).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      } else {
        line = next;
      }
    } else {
      push();
      line = word;
    }
  }
  push();
  return lines.length ? lines : [""];
}

/** Draw a rounded-rect path (does not fill/stroke). */
function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** Pill/chip. Returns the pill's total width so callers can lay them out. */
function drawPill(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  bg: string,
  fg: string,
): number {
  setFont(c, 600, 10.5);
  const padX = 8;
  const h = 20;
  const w = c.measureText(text).width + padX * 2;
  roundRect(c, x, y, w, h, 5);
  c.fillStyle = bg;
  c.fill();
  c.fillStyle = fg;
  c.textBaseline = "middle";
  c.fillText(text, x + padX, y + h / 2 + 0.5);
  c.textBaseline = "alphabetic";
  return w;
}

/** Small rounded pink square with a white dot — the Pinta mark. */
function drawBrandGlyph(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
): void {
  roundRect(c, x, y, size, size, 5);
  c.fillStyle = C.brand;
  c.fill();
  c.beginPath();
  c.arc(x + size / 2, y + size / 2, size * 0.22, 0, Math.PI * 2);
  c.fillStyle = "#ffffff";
  c.fill();
}

/** Minimal page-with-folded-corner glyph for the file-summary line. */
function drawFileGlyph(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  const w = 10;
  const h = 12;
  const fold = 3;
  c.save();
  c.strokeStyle = color;
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x + w - fold, y);
  c.lineTo(x + w, y + fold);
  c.lineTo(x + w, y + h);
  c.lineTo(x, y + h);
  c.closePath();
  c.stroke();
  c.beginPath();
  c.moveTo(x + w - fold, y);
  c.lineTo(x + w - fold, y + fold);
  c.lineTo(x + w, y + fold);
  c.stroke();
  c.restore();
}
