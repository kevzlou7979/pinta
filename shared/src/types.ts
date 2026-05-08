export type Point = { x: number; y: number };

export type AnnotationKind =
  | "arrow"
  | "rect"
  | "circle"
  | "freehand"
  | "pin"
  | "select"
  | "image";

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

  /**
   * One or more DOM targets the annotation refers to. Multi-select
   * (Ctrl/Cmd+click) populates this with N elements. Single-element
   * annotations still set just one entry. Readers should prefer this
   * field over the deprecated `target`.
   */
  targets?: AnnotationTarget[];

  /**
   * @deprecated since v0.3 — use `targets` (an array). Kept for one
   * release so existing on-disk sessions still load. Readers should
   * fall back to `[target]` only when `targets` is unset.
   */
  target?: AnnotationTarget;

  /**
   * How the agent should interpret a multi-target annotation.
   * - `"single-edit"` (default) — find one change that satisfies every
   *   target (likely a shared selector / design-system token).
   * - `"per-element"` — apply the comment as N independent edits, one
   *   per target. Useful when the targets share intent but not framing
   *   (e.g. "give all of these the same spacing").
   * Ignored when `targets` has length 0 or 1.
   */
  groupingMode?: "single-edit" | "per-element";

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

  /**
   * Viewport snapshot at annotation time — width/height drive screenshot
   * scaling, scrollY anchors page-coords-based stroke positions when
   * compositing.
   */
  viewport?: { scrollY: number; width: number; height: number };

  /**
   * Per-annotation lifecycle, set by the agent as it works through a
   * submitted batch. Unset = the annotation hasn't been picked up yet.
   */
  status?: AnnotationStatus;
  /** Set when status === "error" so the side panel can show what failed. */
  errorMessage?: string;

  /**
   * Page URL the annotation was created on. Set by the extension at
   * creation time so a single Session can carry annotations from
   * multiple routes (multi-page reviews of a SPA flow). The skill keys
   * off this when filing per-page output (e.g. GitLab issues). Older
   * sessions may lack it; readers fall back to `session.url`.
   */
  url?: string;
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
  /**
   * Set on `kind: "image"` annotations — where the image is positioned
   * on the page in page-space coords (i.e. includes scrollY). Used by
   * the composite renderer to stamp the image onto the screenshot at
   * the right spot, and by the agent as a hint about which region the
   * user wants to look like the reference. Unset for plain inline
   * reference images attached to the comment popover.
   */
  placement?: { x: number; y: number; width: number; height: number };
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

  /**
   * Built-in modules the user opted into for this submit. Each entry
   * carries the module's id and the user-supplied settings the agent
   * needs to do its work (project ids, tokens, etc.). The skill ships
   * the per-module agent instructions; the wire only carries the kind +
   * config so the contract stays narrow.
   *
   * Stripped from `.pinta` share-file exports — see
   * `extension/src/lib/pinta-file.ts:stripTransient`. Secrets in the
   * settings map (e.g. GitLab personal access tokens) must never travel
   * between machines via the share-file path.
   */
  modules?: SessionModule[];
};

export type SessionModule = {
  /** Stable id, e.g. `"gitlab-issues"`. The skill matches on this. */
  id: string;
  /** Free-form module-specific config (project ids, tokens, labels …). */
  settings: Record<string, string | boolean>;
};

/**
 * Wraps a Session for the share-file (`.pinta`) format. The author /
 * title / accentColor live here rather than on Session itself so the
 * wire contract between extension and companion stays untouched —
 * shareability is purely a side-panel-and-disk concern.
 */
export type SessionManifest = {
  title: string;
  author: string;
  description?: string;
  /** Hex color used to tint imported annotation badges in the UI. */
  accentColor: string;
  exportedAt: number;
};

/**
 * One imported session in IndexedDB. The original `session` is preserved
 * verbatim (read-only); the local `id` keeps multiple imports of the same
 * session distinguishable.
 */
export type ImportedSession = {
  id: string;
  manifest: SessionManifest;
  session: Session;
  importedAt: number;
};

/**
 * Schema-versioned envelope of a `.pinta` share file. Validators must
 * reject unknown `$pinta` values to leave room for future format changes.
 */
export type PintaFile = {
  $pinta: "1";
  manifest: SessionManifest;
  session: Session;
};

export type ClientMessage =
  | { type: "session.create"; url: string }
  | { type: "annotation.add"; annotation: Annotation }
  | { type: "annotation.update"; id: string; patch: Partial<Annotation> }
  | { type: "annotation.remove"; id: string }
  | {
      type: "session.submit";
      screenshot: string;
      autoApply?: boolean;
      modules?: SessionModule[];
    };

export type ServerMessage =
  | { type: "session.created"; session: Session }
  | { type: "session.synced"; session: Session }
  | { type: "session.applying" }
  | { type: "session.done"; summary: string }
  | { type: "error"; message: string };
