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

  /**
   * Structured CSS property → value changes from the picker tabs (Font /
   * Sizing / Spacing). The agent translates these into whatever the
   * project's framework expects — Tailwind utilities, CSS-in-JS, plain
   * CSS, etc. — based on the source file it's editing. Property names
   * are CSS conventional kebab-case ("font-size", "padding-top").
   */
  cssChanges?: Record<string, string>;

  /**
   * If set, the user edited the element's text content in the Content
   * tab. Both before and after are captured so the agent can do a
   * targeted replacement in the source instead of re-finding the text.
   */
  contentChange?: { textBefore: string; textAfter: string };

  /**
   * Reference images attached by the user — pasted into the comment
   * popover or drag-dropped onto it. The user typically refers to them
   * inline as `[image1]`, `[image2]`, etc. The agent reads them as
   * visual context for the change (e.g. "make this look like [image1]").
   *
   * Inline base64 dataUrls for now. Companion may extract to disk and
   * replace with `path` later for large attachments.
   */
  images?: AnnotationImage[];
};

export type AnnotationImage = {
  /** Stable id ("image1", "image2") used in inline `[imageN]` references. */
  id: string;
  /** MIME type, e.g. "image/png", "image/jpeg". */
  mediaType: string;
  /** Base64 data URL — inline payload. */
  dataUrl?: string;
  /** Path on disk relative to projectRoot, set after companion extraction. */
  path?: string;
  /** Optional original filename if dropped from disk. */
  name?: string;

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

  /**
   * If true, the agent should skip its plan-and-wait-for-confirmation
   * step and apply edits directly. The plan is still shown briefly so
   * the user can see what's happening, but no "go" reply is required.
   */
  autoApply?: boolean;

  /**
   * Set when an agent successfully claims this session via
   * POST /v1/sessions/:id/claim. First-claim-wins ensures that when
   * multiple Claude Code terminals are subscribed to the same project
   * (e.g. inside Claude Dock), exactly one of them processes any given
   * submission instead of all of them racing.
   */
  claimedBy?: string;
  claimedAt?: number;
};

export type ClientMessage =
  | { type: "session.create"; url: string }
  | { type: "annotation.add"; annotation: Annotation }
  | { type: "annotation.update"; id: string; patch: Partial<Annotation> }
  | { type: "annotation.remove"; id: string }
  | { type: "session.submit"; screenshot: string; autoApply?: boolean };

export type ServerMessage =
  | { type: "session.created"; session: Session }
  | { type: "session.synced"; session: Session }
  | { type: "session.applying" }
  | { type: "session.done"; summary: string }
  | { type: "error"; message: string };
