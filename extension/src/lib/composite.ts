import type { Annotation } from "@pinta/shared";
import { drawAnnotation, type DrawTool } from "../content/tools/draw.js";

const SELECT_COLOR = "#ef4444";
const SELECT_LINE_WIDTH = 3;
const DRAW_LINE_WIDTH = 3;
const SELECT_PADDING = 4;
const SELECT_LABEL_FONT = "11px ui-sans-serif, system-ui, sans-serif";

// Composites annotations onto the screenshot. Inputs and outputs are PNG
// data URLs. Strokes/boundingRect are in CSS page pixels (matching the
// CSS-pixel screenshot produced by captureFullPage).
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

  for (const a of annotations) {
    if (a.kind === "select") {
      paintSelect(ctx, a);
    } else {
      drawAnnotation(ctx, a.kind as DrawTool, a.strokes, {
        color: a.color || SELECT_COLOR,
        opacity: 1,
        lineWidth: DRAW_LINE_WIDTH,
        translate: { x: 0, y: 0 },
      });
    }
  }

  return canvas.toDataURL("image/png");
}

function paintSelect(ctx: CanvasRenderingContext2D, a: Annotation): void {
  const r = a.target?.boundingRect;
  if (!r) return;

  ctx.save();
  ctx.lineWidth = SELECT_LINE_WIDTH;
  ctx.strokeStyle = a.color || SELECT_COLOR;
  ctx.fillStyle = "rgba(239, 68, 68, 0.10)";
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
