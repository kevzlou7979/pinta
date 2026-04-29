import type { Annotation } from "@pinta/shared";
import {
  drawAnnotation,
  badgeAnchor,
  drawNumberBadge,
  type DrawTool,
} from "../content/tools/draw.js";

const SELECT_COLOR = "#FF3D6E";
const SELECT_LINE_WIDTH = 3;
const DRAW_LINE_WIDTH = 3;
const SELECT_PADDING = 4;
const SELECT_LABEL_FONT = "11px ui-sans-serif, system-ui, sans-serif";

// Composites annotations onto the screenshot. Inputs and outputs are PNG
// data URLs. Strokes/boundingRect are in CSS page pixels (matching the
// CSS-pixel screenshot produced by captureFullPage).
//
// Each annotation gets a numbered badge so an agent reading the
// composited PNG can correlate it with the side-panel list / exported
// MD ("annotation 3 in the doc is the badge labelled '3' on the image").
// Numbers are 1..N in array order, matching what the side panel shows.
export async function compositeAnnotations(
  screenshotDataUrl: string,
  annotations: Annotation[],
): Promise<string> {
  const img = await loadImage(screenshotDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  ctx.drawImage(img, 0, 0);

  annotations.forEach((a, i) => {
    const n = i + 1;
    const color = a.color || SELECT_COLOR;
    if (a.kind === "select") {
      paintSelect(ctx, a, n);
    } else {
      drawAnnotation(ctx, a.kind as DrawTool, a.strokes, {
        color,
        opacity: 1,
        lineWidth: DRAW_LINE_WIDTH,
        translate: { x: 0, y: 0 },
      });
      const anchor = badgeAnchor(a.kind as DrawTool, a.strokes);
      if (anchor) drawNumberBadge(ctx, anchor.x, anchor.y, n, color);
    }
  });

  return canvas.toDataURL("image/png");
}

/**
 * Composites annotations onto a single viewport-sized capture. Only the
 * annotations whose anchor (target boundingRect for selects, drawing
 * centroid for everything else) falls within
 * `[offsetY, offsetY + viewportHeight)` get rendered, with strokes
 * translated into viewport-relative coords.
 *
 * Used by the standalone bundle export so each scroll position becomes
 * a separate clean PNG instead of one tall stitched image where fixed
 * elements appear duplicated. Numbering still uses the global 1..N
 * order from the session's annotation array.
 */
export async function compositeAnnotationsToViewport(
  viewportDataUrl: string,
  annotations: Annotation[],
  viewport: { offsetY: number; width: number; height: number },
): Promise<string> {
  const img = await loadImage(viewportDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  // The captured bitmap is in physical pixels, but annotation coords
  // are in CSS pixels. Scale the drawing context so subsequent paint
  // operations are in CSS-pixel space.
  const scaleX = canvas.width / viewport.width;
  const scaleY = canvas.height / viewport.height;
  ctx.drawImage(img, 0, 0);
  ctx.save();
  ctx.scale(scaleX, scaleY);

  const yMin = viewport.offsetY;
  const yMax = viewport.offsetY + viewport.height;

  annotations.forEach((a, i) => {
    const n = i + 1;
    const color = a.color || SELECT_COLOR;
    const anchorY = anchorYFor(a);
    if (anchorY == null) return;
    if (anchorY < yMin || anchorY >= yMax) return;

    if (a.kind === "select") {
      paintSelectTranslated(ctx, a, n, viewport.offsetY);
    } else {
      const translated = a.strokes.map((p) => ({
        x: p.x,
        y: p.y - viewport.offsetY,
      }));
      drawAnnotation(ctx, a.kind as DrawTool, translated, {
        color,
        opacity: 1,
        lineWidth: DRAW_LINE_WIDTH,
        translate: { x: 0, y: 0 },
      });
      const anchor = badgeAnchor(a.kind as DrawTool, translated);
      if (anchor) drawNumberBadge(ctx, anchor.x, anchor.y, n, color);
    }
  });

  ctx.restore();
  return canvas.toDataURL("image/png");
}

/** Returns the page-Y of an annotation's "main" point, used to decide
 *  which viewport slice it belongs to. */
function anchorYFor(a: Annotation): number | null {
  if (a.kind === "select") {
    return a.target?.boundingRect ? a.target.boundingRect.y : null;
  }
  if (!a.strokes.length) return null;
  // Match the anchor used for badge placement so the badge and the
  // viewport routing stay consistent — pin uses its single point,
  // others use a centroid-ish midpoint.
  if (a.kind === "pin") return a.strokes[0]!.y;
  if (a.strokes.length < 2) return a.strokes[0]!.y;
  const first = a.strokes[0]!;
  const last = a.strokes[a.strokes.length - 1]!;
  return (first.y + last.y) / 2;
}

function paintSelectTranslated(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  n: number,
  offsetY: number,
): void {
  const r = a.target?.boundingRect;
  if (!r) return;
  ctx.save();
  ctx.lineWidth = SELECT_LINE_WIDTH;
  ctx.strokeStyle = a.color || SELECT_COLOR;
  ctx.fillStyle = "rgba(255, 61, 110, 0.10)";
  const x = r.x - SELECT_PADDING;
  const y = r.y - offsetY - SELECT_PADDING;
  const w = r.width + SELECT_PADDING * 2;
  const h = r.height + SELECT_PADDING * 2;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  if (a.target?.selector) paintLabel(ctx, a.target.selector, x, y);
  ctx.restore();
  drawNumberBadge(ctx, x + w, y, n, a.color || SELECT_COLOR);
}

function paintSelect(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  n: number,
): void {
  const r = a.target?.boundingRect;
  if (!r) return;

  ctx.save();
  ctx.lineWidth = SELECT_LINE_WIDTH;
  ctx.strokeStyle = a.color || SELECT_COLOR;
  ctx.fillStyle = "rgba(255, 61, 110, 0.10)";
  const x = r.x - SELECT_PADDING;
  const y = r.y - SELECT_PADDING;
  const w = r.width + SELECT_PADDING * 2;
  const h = r.height + SELECT_PADDING * 2;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);

  if (a.target?.selector) {
    paintLabel(ctx, a.target.selector, x, y);
  }
  ctx.restore();

  // Badge in the top-right corner of the select box so it doesn't
  // overlap the selector label that sits at the top-left.
  drawNumberBadge(ctx, x + w, y, n, a.color || SELECT_COLOR);
}

function paintLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
): void {
  ctx.save();
  ctx.font = SELECT_LABEL_FONT;
  const padX = 6;
  const padY = 3;
  const w = ctx.measureText(text).width + padX * 2;
  const h = 16;
  const labelY = Math.max(0, y - h - 2);
  ctx.fillStyle = SELECT_COLOR;
  ctx.fillRect(x, labelY, w, h);
  ctx.fillStyle = "white";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padX, labelY + h / 2 + 0.5);
  ctx.restore();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load image"));
    img.src = src;
  });
}
