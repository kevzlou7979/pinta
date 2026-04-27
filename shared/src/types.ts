export type Point = { x: number; y: number };

export type AnnotationKind =
  | "arrow"
  | "rect"
  | "circle"
  | "freehand"
  | "pin"
  | "select";

export type AnnotationTarget = {
  selector: string;
  outerHTML: string;
  computedStyles: Record<string, string>;
  nearbyText: string[];
  boundingRect: { x: number; y: number; width: number; height: number };
  sourceFile?: string;
  sourceLine?: number;
};

/**
 * Lifecycle of a single annotation, set by the agent as it works.
 * Unset = the annotation hasn't been picked up yet (still in the
 * drafting/submitted batch).
 */
export type AnnotationStatus = "applying" | "done" | "error";

export type Annotation = {
  id: string;
  createdAt: number;

  kind: AnnotationKind;
  strokes: Point[];
  color: string;

  target?: AnnotationTarget;

  comment: string;

  /**
   * Optional raw CSS the user typed in the inline editor's CSS tab.
   * Phase 8a (inline editing) shape — agent applies this as CSS
   * additions / property overrides on the matching element.
   */
  customCss?: string;

  viewport: { scrollY: number; width: number; height: number };

  status?: AnnotationStatus;
  errorMessage?: string;
};

export type SessionStatus =
  | "drafting"
  | "submitted"
  | "applying"
  | "done"
  | "error";

export type SessionProducer = "extension" | "desktop" | "test";

export type Session = {
  id: string;
  url: string;
  projectRoot: string;
  startedAt: number;
  submittedAt?: number;
  annotations: Annotation[];
  /**
   * Full base64 data URL. Set transiently when the extension submits;
   * the companion strips this after persisting the PNG to disk and
   * exposes `fullPageScreenshotPath` instead.
   */
  fullPageScreenshot?: string;
  /** Path relative to projectRoot, e.g. `.pinta/sessions/{id}.png`. */
  fullPageScreenshotPath?: string;
  status: SessionStatus;
  appliedSummary?: string;
  errorMessage?: string;
  producer: SessionProducer;
};

export type ClientMessage =
  | { type: "session.create"; url: string }
  | { type: "annotation.add"; annotation: Annotation }
  | { type: "annotation.update"; id: string; patch: Partial<Annotation> }
  | { type: "annotation.remove"; id: string }
  | { type: "session.submit"; screenshot: string };

export type ServerMessage =
  | { type: "session.created"; session: Session }
  | { type: "session.synced"; session: Session }
  | { type: "session.applying" }
  | { type: "session.done"; summary: string }
  | { type: "error"; message: string };
