export type Point = { x: number; y: number };

export type AnnotationKind =
  | "arrow"
  | "rect"
  | "circle"
  | "freehand"
  | "pin"
  | "select"
  | "image"
  /**
   * Test Pilot module queries — annotation has no DOM target. Its
   * `comment` carries a JSON-encoded query (e.g. parse a doc, fetch
   * detail steps for a test id) and the agent answers via
   * `mark_session_done(id, appliedSummary)` with structured JSON.
   * Side panel routes these sessions away from the annotation list
   * into the Test Pilot tab.
   */
  | "query";

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

/* ──────────────────────────────────────────────────────────────────────
 * Module declarative shapes (Phase 19 — importable modules)
 *
 * These three types describe a module's *settings form* and *surface*.
 * They used to live only in `extension/src/lib/modules.ts` for the
 * bundled modules; they moved here so an importable module's on-disk
 * manifest (`ModuleManifest`) can reference the exact same shape the
 * extension already renders generically. `extension/src/lib/modules.ts`
 * re-exports them for back-compat — no call-site churn.
 * ──────────────────────────────────────────────────────────────────── */

export type ModuleSettingType = "string" | "secret" | "boolean";

export type ModuleSettingSpec = {
  /** Storage key under chrome.storage.local. */
  key: string;
  type: ModuleSettingType;
  label: string;
  /** Visible explainer under the field. */
  hint?: string;
  /** Default value used when the user hasn't filled the field yet. */
  default?: string | boolean;
  /** Required fields gate the module's "ready to use" state. */
  required?: boolean;
  /** Optional placeholder for the input. */
  placeholder?: string;
};

/**
 * How a module surfaces in the side panel. v1 of importable modules
 * (Phase 19) honors only `"per-submit"`; `"interactive"` / `"inquiry"`
 * (which own a tab or light up cross-cutting surfaces) stay reserved for
 * the bundled modules until the imported-module UI story is built out.
 */
export type ModuleMode = "per-submit" | "interactive" | "inquiry";

/* ──────────────────────────────────────────────────────────────────────
 * Importable modules (Phase 19)
 *
 * A third-party (or the user themselves) can ship a module as a single
 * self-contained `.pinta-module.json` file — `ModulePackage`. The
 * extension reads it, the user reviews + consents to its capabilities,
 * and the companion writes it to `.pinta/modules/<id>/` so the `/pinta`
 * skill can load `agent.md` when a session carries the module's id.
 *
 * COMPLIANCE: imported modules run ONLY inside the user's interactive
 * `/pinta` loop — they never add a headless / Agent-SDK / cron path, and
 * never touch Anthropic credentials. The skill's §7.12 dispatch
 * re-asserts that covenant so a hostile `agent.md` can't push the user's
 * Claude out of the bring-your-own-Claude lane.
 * ──────────────────────────────────────────────────────────────────── */

/**
 * What an imported module is allowed to do beyond the read-only default.
 * Declared in the manifest, but only ever *active* when the user grants
 * it at import time (default-deny). The skill enforces the grant.
 *
 * - `"read-files"`    — read within `projectRoot` (the default posture;
 *                       listed explicitly so a manifest can self-document).
 * - `"write-files"`   — Edit/Write within `projectRoot`.
 * - `run-tool:<cmd>`  — shell out to one specific command (e.g.
 *                       `"run-tool:glab"`). The command is part of the id.
 * - `network:<host>`  — fetch one specific host (e.g.
 *                       `"network:api.linear.app"`).
 */
export type ModuleCapability =
  | "read-files"
  | "write-files"
  | `run-tool:${string}`
  | `network:${string}`;

/**
 * The on-disk manifest (`.pinta/modules/<id>/module.json`) and the
 * `manifest` half of a `ModulePackage`. Extends the bundled `ModuleSpec`
 * shape with packaging metadata (`version` / `author` / `capabilities` /
 * `engines`). The id is namespaced (`acme.jira-sync`) and MUST contain a
 * dot — the companion enforces a strict pattern to prevent it doubling as
 * a path-traversal vector under `.pinta/modules/`.
 */
export type ModuleManifest = {
  id: string;
  name: string;
  version: string;
  author?: string;
  description: string;
  /** v1 honors only `"per-submit"`. */
  mode: ModuleMode;
  /** Footer checkbox label (per-submit). */
  sessionCheckboxLabel: string;
  /** Footer checkbox subtext (per-submit). */
  sessionCheckboxHint: string;
  settings?: ModuleSettingSpec[];
  recommendsScreenshot?: boolean;
  /** Capabilities the module *declares* it needs. Absent / empty = the
   *  module is read-only (read + emit, like an audit). The user grants a
   *  subset at import; the skill never exceeds the grant. */
  capabilities?: ModuleCapability[];
  /** Compatibility hints. `pintaVersion` is a semver range string. */
  engines?: { pintaVersion?: string };
};

/**
 * The single-file import bundle a user picks in Settings → Import module.
 * `$pintaModule` is a schema-version sentinel; validators reject unknown
 * values to leave room for format changes (mirrors `PintaFile.$pinta`).
 */
export type ModulePackage = {
  $pintaModule: "1";
  manifest: ModuleManifest;
  /** Author-written runtime instructions the skill loads — the importable
   *  equivalent of a hardcoded SKILL.md §7.x handler. Markdown. */
  agent: string;
};

/**
 * What `GET /v1/modules` returns per installed module: the manifest, the
 * capabilities the user actually approved (NOT the full declared set),
 * and when it landed. The extension merges these with `BUILTIN_MODULES`
 * so settings forms + footer checkboxes render with no bundled code.
 */
export type InstalledModule = {
  manifest: ModuleManifest;
  grantedCapabilities: ModuleCapability[];
  installedAt: number;
};

/**
 * Phase 18 — terminal role for multi-agent routing. A `/pinta` terminal
 * declares its role via CLI flags (`--annotate` / `--test-pilot` / `--audit`
 * / `--chat`); the companion uses it on the claim endpoint to reject
 * cross-role claims (18b enforcement). Generalists (no flag) omit `role`
 * entirely and fall through to first-wins.
 */
export type SessionRole = "annotate" | "test-pilot" | "audit" | "chat";

/**
 * Derive the role a session "belongs to" from its modules[]. The chat,
 * audit-flow, and test-pilot modules are mutually exclusive on a given
 * submit (each is created by its own state.svelte.ts code path), so
 * precedence below only matters as a defensive fallback. A session with
 * no specialized module is annotate work (the base flow + GitLab Issues).
 */
export function expectedSessionRole(session: Session): SessionRole {
  const ids = session.modules?.map((m) => m.id) ?? [];
  if (ids.includes("chat")) return "chat";
  if (ids.includes("audit-flow")) return "audit";
  if (ids.includes("test-pilot")) return "test-pilot";
  return "annotate";
}

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
  | {
      type: "session.create";
      url: string;
      /**
       * If true, the companion creates a fresh session even when a
       * drafting session already exists, and does NOT set it as the
       * active session. Used by interactive modules (Test Pilot) to
       * run a query alongside the user's annotation draft without
       * stomping it. Omit / false for the normal annotation flow.
       */
      ephemeral?: boolean;
      /**
       * If true, the companion discards any existing drafting session
       * before creating a fresh one. Used by the side panel's "Clear"
       * / "Cancel and restart" actions — without this, the server's
       * drafting-idempotency would echo back the existing session and
       * its annotations would silently resurrect. Implied non-ephemeral.
       */
      force?: boolean;
    }
  | { type: "annotation.add"; annotation: Annotation }
  | { type: "annotation.update"; id: string; patch: Partial<Annotation> }
  | { type: "annotation.remove"; id: string }
  | {
      type: "session.submit";
      screenshot: string;
      autoApply?: boolean;
      modules?: SessionModule[];
    }
  | {
      /**
       * One-shot bundled submit for interactive modules. Companion
       * creates a fresh ephemeral session, attaches a single
       * `kind: "query"` annotation built from `queryComment`, attaches
       * the module config, marks `submitted`, and broadcasts the
       * result via `session.synced`. Extension routes by the returned
       * session id to dispatch the eventual `done` payload to the
       * right interactive-module slot.
       *
       * Used by Test Pilot for both doc-parse and detail-steps queries.
       */
      type: "module.query.submit";
      url: string;
      moduleId: string;
      moduleSettings: Record<string, string | boolean>;
      queryComment: string;
    };

/**
 * AuditFlow (Phase 15) — module that runs Lighthouse-style audits on
 * the user's project and routes each finding to actionable handoffs
 * (Fix-with-agent via Annotate, future Discuss via Chat, File issue
 * via GitLab module). Wire shape is documented here so the agent
 * payload validator and the extension UI agree on field names.
 *
 * v1 ships with the Security category only (Phase 15a); Performance /
 * Accessibility / Mobile / Cross Browser land in 15b. Custom audits
 * land in 15c.
 */
export type AuditCheckStatus = "pass" | "warn" | "fail" | "info";

export type AuditCategoryId =
  | "security"
  | "performance"
  | "accessibility"
  | "mobile"
  | "cross-browser"
  /** User-defined audit. The id includes a uuid suffix so multiple
   *  custom audits don't collide: e.g. `audit-flow-custom:abc-123`. */
  | `audit-flow-custom:${string}`;

/** One finding in an audit run. Status is the primary signal; value
 *  is for measurable observations ("1.2 MB across 64 requests"); fix
 *  hint is what the agent suggests doing about it. */
export type AuditCheck = {
  /** Stable per-finding id — typically a sha1 of category+label+where
   *  so the same finding across runs has the same id (needed by 15d's
   *  cross-run disposition map). v1 trusts the agent to generate it. */
  id: string;
  category: AuditCategoryId;
  status: AuditCheckStatus;
  /** Short human-readable summary, ≤80 chars. Reads as a sentence in
   *  the card view ("eval() in user-input path", "innerHTML on
   *  untrusted string"). */
  label: string;
  /** Optional measured value displayed next to the label
   *  ("3 occurrences", "1.2 MB"). */
  value?: string;
  /** Longer explainer shown when the check row is expanded. Markdown
   *  allowed — renders via the same parseStep pipeline as Test Pilot
   *  detail steps. */
  description?: string;
  /** Pointer to the offending code / page when known. */
  where?: { file?: string; line?: number; url?: string };
  /** What the agent thinks should change. Becomes the prefilled
   *  comment when the user clicks Fix-with-agent. */
  fixHint?: string;
  /** Pre-composed annotation the side panel can drop directly into
   *  the Annotate draft. Lets the agent control the exact shape of
   *  the handoff payload (selector / sourceFile / comment) instead of
   *  the extension synthesizing it from where + fixHint. Optional —
   *  when absent the extension composes a fallback. */
  suggestedAnnotation?: Annotation;
};

/** Per-finding remediation disposition the user works through. Lives
 *  OUTSIDE the AuditRun (keyed by the check's stable fingerprint id)
 *  so re-running an audit doesn't wipe the user's progress. Only
 *  actionable checks (status fail / warn) carry one; the default for
 *  an actionable check with no stored entry is "open". "resolved" and
 *  "wont-fix" both count as "addressed" in the progress rollup. */
export type AuditDisposition = "open" | "fixing" | "resolved" | "wont-fix";

/**
 * User-curated edits layered over the AGENT-generated audit run
 * (Phase 15 "Slice 2" — catalog editing). The agent's run is
 * recomputed every time the user re-audits, so user edits can't live
 * inside it; they live here and are merged over the raw run by
 * `mergeAuditRun`. Persisted independently so edits survive re-runs.
 *
 * Mirrors Test Pilot's Phase 13 catalog-editing model: an immutable
 * agent baseline + a durable user overlay.
 */
export type AuditOverlay = {
  /** Custom categories the user added. id = `audit-flow-custom:${uuid}`. */
  addedCategories: AuditCategoryResult[];
  /** User-added checks, keyed by category id. Check id = `USER-${uuid}`. */
  addedChecks: Record<string, AuditCheck[]>;
  /** Field overrides on AGENT checks, keyed by check id. */
  edits: Record<string, { label?: string; description?: string; fixHint?: string }>;
  /** Ids of checks AND categories the user hid. */
  deleted: string[];
};

export type AuditCategoryResult = {
  id: AuditCategoryId;
  name: string;
  /** 0-100. Computed deterministically:
   *  (pass*1 + warn*0.5 + fail*0) / (pass + warn + fail) × 100.
   *  Info checks are excluded from the denominator. */
  score: number;
  checks: AuditCheck[];
};

export type AuditRun = {
  runId: string;
  startedAt: number;
  completedAt?: number;
  categories: AuditCategoryResult[];
  /** Average of category scores, 0-100. */
  overall: number;
  /** Derived rating string ("Excellent" / "Good" / "Needs work" /
   *  "Poor"). Computed by the agent from `overall` so the UI doesn't
   *  have to duplicate the threshold logic. */
  rating: string;
};

export type ServerMessage =
  | { type: "session.created"; session: Session }
  | { type: "session.synced"; session: Session }
  | { type: "session.applying" }
  | { type: "session.done"; summary: string }
  | {
      /**
       * Companion's ack for a `module.query.submit`. Carries the
       * freshly-created session so the extension can pin
       * `testPilot.pending.sessionId` to it and route the eventual
       * `session.synced` (status: done | error) into the correct
       * interactive-module slot. The companion also broadcasts a
       * normal `session.synced` for the same session — both are safe
       * to receive; the extension uses the first one to capture the id.
       */
      type: "module.query.created";
      moduleId: string;
      session: Session;
    }
  | { type: "error"; message: string };
