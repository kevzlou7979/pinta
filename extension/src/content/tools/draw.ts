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

/**
 * The page-coords point that "this drawing is pointing at" — used to
 * resolve the underlying DOM element so even a freehand scribble or an
 * arrow gets a selector + outerHTML attached, making the annotation
 * actionable for an agent reading the MD without a screenshot.
 *
 * Differs from `badgeAnchor` for arrow: badges anchor at the *start*
 * (so they don't sit on the arrowhead), but the *target* is the
 * arrowhead end (what the arrow is pointing at).
 */
export function targetAnchor(
  kind: DrawTool,
  points: Point[],
): Point | null {
  if (points.length === 0) return null;
  switch (kind) {
    case "pin":
      return points[0]!;
    case "arrow": {
      if (points.length < 2) return null;
      return points[points.length - 1]!;
    }
    case "rect":
    case "circle": {
      if (points.length < 2) return null;
      const a = points[0]!;
      const b = points[points.length - 1]!;
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    case "freehand": {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      if (!Number.isFinite(minX)) return null;
      return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    }
  }
}

/**
 * Anchor point for the numbered badge of a given drawing — close to
 * the visual centroid so the badge sits near the shape without
 * obscuring its content.
 */
export function badgeAnchor(
  kind: DrawTool,
  points: Point[],
): Point | null {
  if (points.length === 0) return null;
  switch (kind) {
    case "pin":
      // Slight offset so the badge sits next to the dot, not on top of it.
      return { x: points[0]!.x + PIN_RADIUS + 8, y: points[0]!.y };
    case "arrow":
    case "rect":
    case "circle": {
      if (points.length < 2) return null;
      const a = points[0]!;
      const b = points[points.length - 1]!;
      // Top-left corner for rect (so it doesn't overlap the inside),
      // start point for arrow (the "from" end), centroid for circle.
      if (kind === "rect") {
        return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
      }
      if (kind === "arrow") {
        return { x: a.x, y: a.y };
      }
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    case "freehand": {
      // Use the bounding-box top-left of the stroke. Avoids the badge
      // landing inside a tight scribble.
      let minX = Infinity;
      let minY = Infinity;
      for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
      }
      return Number.isFinite(minX) ? { x: minX, y: minY } : null;
    }
  }
}

const BADGE_RADIUS = 11;
const BADGE_FONT = "bold 12px ui-sans-serif, system-ui, sans-serif";

/**
 * Renders a numbered badge (filled circle + white digit) at the given
 * point. Used by both the live canvas overlay and the composited
 * screenshot so the user sees the same numbers on screen and in the
 * exported file.
 */
export function drawNumberBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  n: number,
  color = "#FF3D6E",
): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, BADGE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "white";
  ctx.stroke();
  ctx.fillStyle = "white";
  ctx.font = BADGE_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), x, y + 0.5);
  ctx.restore();
}
