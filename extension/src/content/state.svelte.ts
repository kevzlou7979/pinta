import type { Annotation, Point } from "@pinta/shared";
import type { DrawTool } from "./tools/draw.js";

export type Mode = "idle" | "select" | "draw";

export type Draft = {
  id: string;
  kind: DrawTool;
  color: string;
  strokes: Point[];      // page coords
  createdAt: number;
};

class ContentState {
  mode = $state<Mode>("idle");
  tool = $state<DrawTool>("arrow");

  // Drawings the user has completed in this page session. Rendered semi-
  // transparent on the canvas. Also forwarded to the side panel as Annotations
  // over runtime messaging.
  committed = $state<Annotation[]>([]);

  // The stroke currently being drawn (live mouse). Becomes a draft on mouseup,
  // then opens a comment popup. Rendered at full opacity.
  inProgress = $state<Draft | null>(null);

  // The just-completed stroke awaiting a comment.
  pending = $state<Draft | null>(null);

  // DOM elements the user has annotated in the current page session.
  // Each gets a numbered pin badge in the overlay so they can see at a
  // glance what's already been picked. Cleared when the side panel
  // cancels/starts a new session.
  annotated = $state<{ id: string; element: Element; index: number }[]>([]);

  setMode(next: Mode) {
    this.mode = next;
    if (next !== "draw") {
      this.inProgress = null;
      // keep `pending` so the user can finish typing the comment even
      // after switching away accidentally
    }
  }

  setTool(t: DrawTool) {
    this.tool = t;
    if (this.mode !== "draw") this.mode = "draw";
  }

  beginStroke(point: Point, color: string): void {
    this.inProgress = {
      id: uid(),
      kind: this.tool,
      color,
      strokes: [point],
      createdAt: Date.now(),
    };
  }

  extendStroke(point: Point): void {
    if (!this.inProgress) return;
    const last = this.inProgress.strokes[this.inProgress.strokes.length - 1];
    // For non-freehand tools, only keep first + last for a clean shape.
    if (this.inProgress.kind === "freehand") {
      // throttle: skip points within 2px of the previous one
      if (last && dist(last, point) < 2) return;
      this.inProgress.strokes = [...this.inProgress.strokes, point];
    } else if (this.inProgress.kind === "pin") {
      // pin: single point, ignore drag
      return;
    } else {
      this.inProgress.strokes = [this.inProgress.strokes[0]!, point];
    }
  }

  endStroke(): void {
    if (!this.inProgress) return;
    // require at least minimal movement (except pin)
    const s = this.inProgress;
    if (s.kind !== "pin" && s.strokes.length < 2) {
      this.inProgress = null;
      return;
    }
    this.pending = s;
    this.inProgress = null;
  }

  cancelPending(): void {
    this.pending = null;
  }

  cancelInProgress(): void {
    this.inProgress = null;
  }

  recordCommitted(annotation: Annotation): void {
    this.committed = [...this.committed, annotation];
  }

  recordAnnotated(id: string, element: Element): number {
    const index = this.annotated.length + 1;
    this.annotated = [...this.annotated, { id, element, index }];
    return index;
  }

  removeAnnotatedById(id: string): void {
    const next = this.annotated
      .filter((a) => a.id !== id)
      .map((a, i) => ({ ...a, index: i + 1 }));
    this.annotated = next;
  }

  clearAnnotated(): void {
    this.annotated = [];
  }
}

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export const content = new ContentState();
