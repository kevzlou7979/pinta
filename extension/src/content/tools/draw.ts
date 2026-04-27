import type { AnnotationKind, Point } from "@pinta/shared";

export type DrawTool = Exclude<AnnotationKind, "select">;

export const DRAW_TOOLS: DrawTool[] = [
  "arrow",
  "rect",
  "circle",
  "freehand",
  "pin",
];

export type DrawOptions = {
  color: string;
  opacity: number;
  lineWidth: number;
  /** subtract from page-space points to map into viewport space */
  translate: { x: number; y: number };
};

const ARROW_HEAD_LEN = 14;
const ARROW_HEAD_ANGLE = Math.PI / 7;
const PIN_RADIUS = 8;

export function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  kind: DrawTool,
  points: Point[],
  opts: DrawOptions,
): void {
  if (points.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = opts.color;
  ctx.fillStyle = opts.color;
  ctx.globalAlpha = opts.opacity;
  ctx.lineWidth = opts.lineWidth;

  switch (kind) {
    case "arrow":
      renderArrow(ctx, points, opts);
      break;
    case "rect":
      renderRect(ctx, points, opts);
      break;
    case "circle":
      renderCircle(ctx, points, opts);
      break;
    case "freehand":
      renderFreehand(ctx, points, opts);
      break;
    case "pin":
      renderPin(ctx, points, opts);
      break;
  }

  ctx.restore();
}

function toView(p: Point, opts: DrawOptions): Point {
  return { x: p.x - opts.translate.x, y: p.y - opts.translate.y };
}

function renderArrow(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  opts: DrawOptions,
): void {
  if (points.length < 2) return;
  const a = toView(points[0]!, opts);
  const b = toView(points[points.length - 1]!, opts);

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();

  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const left = {
    x: b.x - ARROW_HEAD_LEN * Math.cos(angle - ARROW_HEAD_ANGLE),
    y: b.y - ARROW_HEAD_LEN * Math.sin(angle - ARROW_HEAD_ANGLE),
  };
  const right = {
    x: b.x - ARROW_HEAD_LEN * Math.cos(angle + ARROW_HEAD_ANGLE),
    y: b.y - ARROW_HEAD_LEN * Math.sin(angle + ARROW_HEAD_ANGLE),
  };
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(left.x, left.y);
  ctx.lineTo(right.x, right.y);
  ctx.closePath();
  ctx.fill();
}

function renderRect(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  opts: DrawOptions,
): void {
  if (points.length < 2) return;
  const a = toView(points[0]!, opts);
  const b = toView(points[points.length - 1]!, opts);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  ctx.strokeRect(x, y, w, h);
}

function renderCircle(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  opts: DrawOptions,
): void {
  if (points.length < 2) return;
  const a = toView(points[0]!, opts);
  const b = toView(points[points.length - 1]!, opts);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2;
  const ry = Math.abs(b.y - a.y) / 2;
  if (rx === 0 || ry === 0) return;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function renderFreehand(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  opts: DrawOptions,
): void {
  if (points.length < 2) return;
  const first = toView(points[0]!, opts);
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const p = toView(points[i]!, opts);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function renderPin(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  opts: DrawOptions,
): void {
  const p = toView(points[0]!, opts);
  ctx.beginPath();
  ctx.arc(p.x, p.y, PIN_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.globalAlpha = Math.min(1, opts.opacity * 1.4);
  ctx.beginPath();
  ctx.arc(p.x, p.y, PIN_RADIUS, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "white";
  ctx.stroke();
  ctx.restore();
}
