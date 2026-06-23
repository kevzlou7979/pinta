# Pinta — Spec

A browser-based visual annotation tool that lets developers mark up their running app and have an AI coding agent apply the changes to source files.

---

## 1. Problem

Describing UI changes in prose is high-friction and lossy. "Make the warning icon next to the delete button blue, but only on the review page, and tighten the spacing around it" is the kind of instruction that takes longer to write than the change itself takes to make. Designers and developers iterating on UI need a faster loop — point at it, mark it up, ship it.

The closest existing pattern is leaving comments on a Figma file, but Figma doesn't edit your code. Browser DevTools lets you inspect, but doesn't connect to your codebase. Coding agents can edit files, but can't see what you're pointing at.

Pinta closes this loop: annotate the running page in the browser → an AI agent (Claude Code, Cursor, Aider, or any MCP-compatible agent) edits the matching source files → HMR shows the result.

---

## 2. Goals & non-goals

**Goals**
- Mark up any web app running in the browser with drawings, element selections, and comments.
- Batch multiple annotations into a session and submit them together.
- Hand the session off to a coding agent that edits the actual project files.
- Be agent-agnostic — Claude Code is the reference implementation, but Cursor, Aider, and other MCP-compatible tools should work via the same companion server.
- Work on real-world Svelte/React/Vue projects without per-project setup, with optional opt-in source-mapping for instant edits.

**Non-goals (v1)**
- Cross-user collaboration on annotations. Single-user, single-session.
- Editing production sites. The target is local dev or staging where the user owns the source.
- Replacing design tools. Pinta is for *fixing* UI, not designing it from scratch.
- Mobile browser support. Desktop Chrome only at v1.

---

## 3. System overview

Four components, designed so each could in principle be swapped:

```
┌─────────────────────┐     WebSocket      ┌──────────────────────┐
│  Chrome Extension   │ ◄────────────────► │  Companion Server    │
│  (Svelte)           │                    │  (Node + MCP)        │
│                     │                    │                      │
│  - Overlay canvas   │                    │  - Session store     │
│  - Element selector │                    │  - WebSocket hub     │
│  - Side panel UI    │                    │  - HTTP API          │
│  - Session state    │                    │  - MCP server        │
└─────────────────────┘                    └──────────┬───────────┘
                                                      │
                                                      │ MCP / HTTP
                                                      ▼
                                           ┌──────────────────────┐
                                           │  Coding Agent        │
                                           │                      │
                                           │  Claude Code (skill) │
                                           │  Cursor (MCP)        │
                                           │  Aider (adapter)     │
                                           │  Custom (HTTP)       │
                                           └──────────┬───────────┘
                                                      │
                                                      │ file edits
                                                      ▼
                                           ┌──────────────────────┐
                                           │  Project files       │
                                           │  (.svelte, .tsx, ...)│
                                           └──────────────────────┘
```

**Boundaries**
- Extension knows nothing about agents — it only talks to the companion.
- Companion knows nothing about specific agents — it exposes a generic API and an MCP server.
- Agents know nothing about the extension — they consume sessions from the companion.

This split is the entire point of the architecture. It's what makes "works with any coding agent" real.

**Multi-companion routing.** A single extension can talk to multiple
companions concurrently — one per project. Each companion registers in
`~/.pinta/registry.json` and claims URL patterns via per-project
`.pinta.json`. The side panel auto-routes the active tab to the right
companion. See Phase 9.

**Standalone (no-companion) mode.** When no companion is running (or
none claims the active tab's URL), the extension runs fully locally —
annotations live in IndexedDB, the agent-handoff path collapses to
**Copy to clipboard** and **Download `.zip`** instead of WS submit.
Designed for QA / testers who don't have the project on disk. See
Phase 10.

---

## 4. Core concepts

### Annotation
A single mark-up: one drawing, selection, or interactive-module query
plus an optional comment. Canonical type in `shared/src/types.ts`.

```ts
type Annotation = {
  id: string;                         // uuid
  createdAt: number;

  // The mark. "image" annotations are pasted/dropped reference images
  // placed in page-space; "query" annotations carry a JSON-encoded
  // request from an interactive module (e.g. Test Pilot) and have no
  // DOM target — see §8 Phase 12.
  kind: 'arrow' | 'rect' | 'circle' | 'freehand' | 'pin' | 'select'
      | 'image' | 'query';
  strokes: Point[];                   // page coordinates
  color: string;

  // Page URL the annotation was created on. Lets a single Session
  // carry annotations from multiple routes of a SPA flow. Skill keys
  // off this for per-page output; falls back to `session.url`.
  url?: string;

  // What it points at. Multi-select (Ctrl/Cmd+click) populates the
  // `targets` array; single-target legacy paths still set `target`.
  // Readers should prefer `targets` and fall back to `[target]`.
  targets?: AnnotationTarget[];
  /** @deprecated since v0.3 — use `targets`. Kept for one release. */
  target?: AnnotationTarget;

  // How the agent should interpret a multi-target annotation:
  // - "single-edit" (default): one change that satisfies every target.
  // - "per-element": apply as N independent edits, one per target.
  // Ignored when `targets` has length 0 or 1.
  groupingMode?: 'single-edit' | 'per-element';

  // The intent
  comment: string;

  // Inline-editor payloads (Phase 8). All optional. The agent emits
  // whichever of these are set; multiple can coexist on one annotation.
  customCss?: string;                 // raw CSS textarea
  cssChanges?: Record<string, string>;// kebab-case CSS prop → value
  contentChange?: { textBefore: string; textAfter: string };
  images?: AnnotationImage[];         // [imageN] tokens in `comment`

  // Context — set on capture, optional because draft annotations may
  // not yet have a viewport snapshot (e.g. test ingest paths).
  viewport?: { scrollY: number; width: number; height: number };

  // Lifecycle, set by the agent. Unset = not yet picked up.
  status?: 'applying' | 'done' | 'error';
  errorMessage?: string;
};

type AnnotationTarget = {
  selector: string;                 // computed CSS selector
  outerHTML: string;                // truncated to ~2 KB, sanitized
  computedStyles: Record<string, string>;
  nearbyText: string[];             // for grep fallback
  boundingRect: { x: number; y: number; width: number; height: number };
  sourceFile?: string;              // from Vite plugin if installed
  sourceLine?: number;
};

type AnnotationImage = {
  id: string;            // "image1", "image2" — used in [imageN] refs
  mediaType: string;     // "image/png", "image/jpeg"
  dataUrl?: string;      // inline base64 (current shape)
  path?: string;         // disk path, set if companion extracts later
  name?: string;         // original filename if dropped from disk
  // Set on `kind: "image"` annotations — where the image is placed on
  // the page in page-space coords (includes scrollY). Composite renderer
  // stamps the image onto the screenshot at this position. Unset for
  // inline reference images attached to a comment popover.
  placement?: { x: number; y: number; width: number; height: number };
};
```

### Session
A batch of annotations submitted together.

```ts
type Session = {
  id: string;
  url: string;
  projectRoot: string;                // companion was started in this directory
                                      // (empty string in standalone mode)
  startedAt: number;
  submittedAt?: number;
  annotations: Annotation[];

  // Set transiently when the extension submits with a screenshot; the
  // companion strips it after persisting the PNG to disk and exposes
  // `fullPageScreenshotPath` (path relative to projectRoot) instead.
  fullPageScreenshot?: string;
  fullPageScreenshotPath?: string;

  status: 'drafting' | 'submitted' | 'applying' | 'done' | 'error';
  appliedSummary?: string;            // agent's summary of what it did
  errorMessage?: string;

  // Where this session came from. "extension" is the normal Chrome
  // extension flow; "test" is the HTTP /v1/sessions ingest path used by
  // tests and direct curl. "desktop" reserved for future native client.
  producer: 'extension' | 'desktop' | 'test';

  // Phase 7 — when true, agent skips the "reply 'go' to apply" gate.
  autoApply?: boolean;

  // Phase 9 — first-claim-wins coordination across multiple agents
  // subscribed to the same project (e.g. multiple Claude Code terminals
  // in Claude Dock). Set by POST /v1/sessions/:id/claim. Stale claims
  // (>5 min without a status-update heartbeat) auto-release.
  claimedBy?: string;
  claimedAt?: number;

  // Phase 12 — built-in modules the user opted into for this submit.
  // Each entry pairs a stable module id with user-supplied settings the
  // agent needs (project ids, labels, feature flags, etc.). Stripped
  // from `.pinta` share-file exports so secrets in module settings
  // (e.g. GitLab tokens) never travel between machines.
  modules?: SessionModule[];
};

type SessionModule = {
  id: string;                          // e.g. "gitlab-issues", "test-pilot"
  settings: Record<string, string | boolean>;
};
```

### Adapter
The agent-specific glue. A skill, an MCP client config, a CLI script — whatever it takes to make a given agent receive sessions from the companion. The companion never knows which adapter is consuming.

---

## 5. Workflow (end-to-end)

The intended user experience, narrated:

1. **Start.** Developer is in their project terminal with Claude Code (or any agent) open. They type `/pinta` (or "open the visual editor"). The agent invokes the pinta skill/adapter.

2. **Companion launches.** The skill starts the companion server on `localhost:7878`, passing in the current project root. If already running, reuse it.

3. **Extension activates.** User clicks the extension icon (or the skill prints a deeplink). Side panel opens. Extension connects to the companion via WebSocket. A new session is created.

4. **Annotate.** User browses to the page they want to fix. Activates the overlay. Draws, selects elements, types comments. Each annotation appears in the side panel as a card. They can edit, delete, reorder.

5. **Review.** User reviews the list. Maybe deletes one, edits a comment. Hits "Send to agent."

6. **Capture & submit.** Extension takes a full-page screenshot, packages the session, sends it to the companion. Companion marks the session `submitted`.

7. **Agent picks up.** Agent (which has been polling or subscribed via MCP) receives the session payload. Presents a plan to the user: "I see 4 annotations. Here's what I'd change in 3 files…"

8. **User confirms.** User says "go" in the agent's chat. Agent applies edits.

9. **Live update.** Vite/Webpack HMR refreshes the page. User sees the result. Companion marks session `done`.

10. **Iterate.** User starts a new session for follow-up changes, or closes the extension.

---

## 6. Component specs

### 6.1 Chrome Extension (Svelte)

**Stack**: Svelte 5 + TypeScript + Vite + `@crxjs/vite-plugin` + Tailwind + shadcn-svelte.

**Surfaces**
- **Side panel** (Chrome's `chrome.sidePanel` API): main UI. Annotation list, comment editor, submit button, session controls.
- **Content script overlay**: full-viewport canvas + element selector, injected into the host page. Mounted in a Shadow DOM root to isolate styles.
- **Background service worker**: handles `chrome.tabs.captureVisibleTab`, brokers messages between content script and side panel.
- **Popup** (minimal): on/off toggle and "open side panel" button.

**Modes** (keyboard-switchable)
- `D` — Draw: pick a tool, draw on the canvas. On stroke completion, comment input appears inline near the stroke.
- `S` — Select: hover highlights elements, click locks selection. Comment input appears.
- `R` — Review: see all annotations as a list. Click to scroll to. Edit/delete.

**State**

```ts
type ExtensionState = {
  session: Session;                   // current session
  mode: 'draw' | 'select' | 'review' | 'idle';
  activeTool: Tool;                   // when in draw mode
  activeStroke: Point[] | null;       // in-progress drawing
  hoveredElement: Element | null;     // in select mode
  selectedAnnotationId: string | null;
  connectionStatus: 'connected' | 'connecting' | 'disconnected';
};
```

**Drawing anchoring**: page coordinates + scroll offset. Drawings translate with scroll. (Phase-2 enhancement: anchor to selectors for reflow resilience.)

**Element selection**: hover highlights with a colored outline + label showing tag/class. Click to lock. Computed selector prefers `id`, then unique class combinations, then `nth-child` path. Capture `outerHTML`, computed styles for color/spacing/typography, nearby text (parents up 3 levels).

**Style isolation**: Shadow DOM root for the overlay. Tailwind built into a single CSS string and injected into the shadow root to keep it out of the host page's cascade.

### 6.2 Companion Server (Node)

**Stack**: Node 20+, TypeScript, `ws` for WebSocket, native `http`, `@modelcontextprotocol/sdk` for MCP.

**Responsibilities**
- Hold the active session in memory.
- Accept annotation updates from the extension over WebSocket.
- Expose an HTTP API for non-MCP agents.
- Expose an MCP server for MCP-compatible agents.
- Persist completed sessions to disk for history (`.pinta/sessions/*.json`).

**HTTP API (versioned)**

Reads (GET) are open. Writes (POST / DELETE) reject requests carrying
a browser `Origin` other than `chrome-extension://*` so a tab in the
user's own browser can't CSRF the companion — see `companion/src/server.ts`.

```
GET    /v1/health                                          → { ok, projectRoot, port, urlPatterns, registryId, version, pid }
GET    /v1/registry                                        → snapshot of every running companion
GET    /v1/url-patterns                                    → on-disk patterns from .pinta.json
POST   /v1/url-patterns                                    → { pattern } → updated patterns[]
GET    /v1/sessions                                        → slim history list (no annotation bodies)
GET    /v1/sessions/active                                 → current session or null
GET    /v1/sessions/poll                                   → long-poll for next submitted session (25s)
GET    /v1/sessions/stream                                 → SSE push (event: session\ndata: {...})
POST   /v1/sessions                                        → ingest a fully-formed session (test path)
GET    /v1/sessions/:id                                    → full session
POST   /v1/sessions/:id/status                             → { status, summary?, errorMessage? }
POST   /v1/sessions/:id/claim                              → { claimerId } → 200 winner | 409 already-claimed
POST   /v1/sessions/:id/annotations/:annId/status          → { status, errorMessage? }
DELETE /v1/sessions                                        → wipe history (preserves any active drafting session)
DELETE /v1/test-docs                                       → wipe .pinta/test-docs/ (Test Pilot, Phase 12)
PUT    /v1/test-docs/:docId                                → { content } → rewrite .pinta/test-docs/:docId.md (Phase 13)
PUT    /v1/test-docs/:docId/results[/:authorSlug]          → { content } → write per-author Pass/Fail sidecar (Phase 13)
GET    /v1/test-docs/:docId/results[/:authorSlug]          → read sidecar content (Phase 13)
```

`:authorSlug` is the lowercased + kebab-cased catalog author name
(`[a-z0-9-]{1,64}`). When omitted, the companion picks the most
recent sidecar so a single-tester project still round-trips cleanly.

**WebSocket protocol** (extension ↔ companion)

```ts
type ClientMessage =
  | {
      type: 'session.create';
      url: string;
      // Phase 12 — interactive modules create ephemeral sessions that
      // don't take over `activeId`, so the user's annotation draft is
      // left alone while a Test Pilot query runs alongside it.
      ephemeral?: boolean;
      // v0.3.1 — discard any existing drafting session before creating
      // a fresh one. Set by side-panel "Clear" so the server's
      // drafting-idempotency doesn't resurrect the cleared annotations.
      force?: boolean;
    }
  | { type: 'annotation.add'; annotation: Annotation }
  | { type: 'annotation.update'; id: string; patch: Partial<Annotation> }
  | { type: 'annotation.remove'; id: string }
  | {
      type: 'session.submit';
      screenshot: string;             // "" allowed (opt-in, no-screenshot mode)
      autoApply?: boolean;            // Phase 7 — skip the "reply 'go'" gate
      modules?: SessionModule[];      // Phase 12 — per-submit module opt-ins
    }
  // Phase 12 — one-shot bundled submit for interactive modules.
  // Companion creates an ephemeral session, attaches a single
  // `kind: "query"` annotation built from `queryComment`, marks
  // submitted, and broadcasts the result via session.synced.
  | {
      type: 'module.query.submit';
      url: string;
      moduleId: string;
      moduleSettings: Record<string, string | boolean>;
      queryComment: string;
    };

type ServerMessage =
  | { type: 'session.created'; session: Session }
  | { type: 'session.synced'; session: Session }
  | { type: 'session.applying' }
  | { type: 'session.done'; summary: string }
  // Phase 12 — companion's targeted ack for a module.query.submit.
  // Lets the extension pin the resulting session id to the right
  // interactive-module slot. The companion also broadcasts a normal
  // session.synced for the same session.
  | { type: 'module.query.created'; moduleId: string; session: Session }
  | { type: 'error'; message: string };
```

**MCP tools exposed**

```
get_pending_session()                          → Session | null
get_session(id)                                → Session
mark_session_applying(id)                      → void
mark_session_done(id, summary)                 → void
mark_session_error(id, error)                  → void
mark_annotation_applying(sessionId, annId)     → void   // Phase 9
mark_annotation_done(sessionId, annId)         → void   // Phase 9
mark_annotation_error(sessionId, annId, error) → void   // Phase 9
get_screenshot(annotation_id)                  → base64 PNG (cropped)
```

**Process model**: long-running. Started once per project, runs until killed. Multiple agents can connect simultaneously (only one applies, others observe).

### 6.3 Adapters

#### 6.3.1 Claude Code (reference adapter)

A skill at `.claude/skills/pinta/SKILL.md`:

```markdown
---
name: pinta
description: Use when the user wants to visually annotate their running app to make UI changes. Starts the companion server, instructs the user to open the Chrome extension, then receives annotations and edits the corresponding component files.
---

# Pinta

When invoked:
1. Check if the companion is running on localhost:7878. If not, start it:
   `node ~/.claude/skills/pinta/start-companion.js {project_root}`
2. Tell the user: "Companion is running. Open the Pinta extension and start annotating. I'll wait for you to submit."
3. Long-poll GET /v1/sessions/poll for a submitted session.
4. When a session arrives:
   a. Read the session payload (annotations, screenshot, project root).
   b. For each annotation:
      - If `target.sourceFile` is provided, open it directly.
      - Otherwise, grep the codebase for `target.nearbyText[0]` to locate.
   c. Build a unified plan grouping edits by file.
   d. Present the plan to the user. Wait for confirmation.
   e. Apply edits. POST status updates as you go.
   f. Run any test/lint commands per project conventions.
5. POST /v1/sessions/:id/status with 'done' and a summary.
```

#### 6.3.2 Cursor / Cline / Continue / Zed (MCP)

The companion ships a separate stdio MCP bridge binary, `pinta-mcp`,
that proxies to whichever companion is responsible for the agent's cwd.
Discovery is three-tier: explicit `--companion-url` /
`$PINTA_COMPANION_URL` first, then `~/.pinta/registry.json` walk-up for
`$CLAUDE_PROJECT_DIR` (else cwd), then `localhost:7878` as a fallback.

User adds the bridge to their MCP config. `pinta-mcp` ships as a `bin`
inside the `pinta-companion` npm package (not as a separate package),
so the `npx` invocation needs `-p`:

```json
{
  "mcpServers": {
    "pinta": {
      "command": "npx",
      "args": ["-y", "-p", "pinta-companion", "pinta-mcp"]
    }
  }
}
```

(The companion itself — `pinta-companion .` — must be running separately
in the project root, which is the same model as Claude Code.)

Now `get_pending_session`, `mark_session_done`, `mark_annotation_done`,
etc. are available as tools in the agent. The user invokes the workflow
with a natural prompt: "Pick up the visual edit session and apply the
changes."

#### 6.3.3 Aider

A custom command in `.aider.conf.yml` or a wrapper script that polls the HTTP API and pipes the session as context into Aider's chat.

#### 6.3.4 Custom

Any agent that can make HTTP requests. The HTTP API is the universal lowest-common-denominator integration.

### 6.4 Vite plugin (optional, opt-in) — Planned

`vite-plugin-pinta` would add `data-source-file` and `data-source-line`
to root elements of components in dev mode. Modeled on
`vite-plugin-svelte-inspector`. ~50 LOC.

**Status:** *consumer side shipped, plugin not yet implemented.* The
extension already reads `data-source-file` / `data-source-line` from
clicked elements (`extension/src/content/capture.ts`) — projects that
hand-add those attributes (or use a similar plugin from another tool)
get instant source-mapping. The Pinta-branded plugin itself is not yet
written; until then, the extension falls back to grep on `nearbyText`.

---

## 7. Data flow examples

### 7.1 Single annotation, source-mapped

```
1. User draws circle around <button> with data-source-file="src/Button.svelte" line 12
2. Extension captures: kind='circle', target.sourceFile='src/Button.svelte', target.sourceLine=12,
   comment="make this tonal"
3. Extension sends annotation.add over WebSocket
4. Companion adds to active session
5. User clicks Submit. Extension sends session.submit with full-page screenshot
6. Companion marks session 'submitted'
7. Claude Code (long-polling) receives session
8. Claude Code reads src/Button.svelte (knows the file directly)
9. Claude Code presents plan: "Change variant from 'filled' to 'tonal' in Button.svelte:12"
10. User confirms. Edits applied. HMR reloads. Status → 'done'.
```

### 7.2 Multiple annotations, mixed mapping

```
Session contains:
  [1] circle on icon, source-mapped to ExpiryBadge.svelte:8,    "remove this"
  [2] arrow at button, no source map, nearbyText="Submit Claim", "tonal not filled"
  [3] rect around card, no source map, nearbyText="GAP Protection", "more padding"

Agent flow:
  - For [1]: open file directly
  - For [2]: grep "Submit Claim" → found in 2 files, pick the one matching the URL route
  - For [3]: grep "GAP Protection" → found in ClaimSummaryCard.svelte
  - Present grouped plan: "I'll edit 3 files: ExpiryBadge.svelte (remove), 
    SubmitButton.svelte (variant change), ClaimSummaryCard.svelte (padding)"
  - Confirm. Apply. Done.
```

---

## 8. Phased build plan

Each phase is shippable on its own — if you stop, you still have a working tool, just less polished.

### Phase 0 — Walking skeleton (1 evening)

**Goal**: prove the pipeline end-to-end with no UI.

- Companion server: HTTP-only, single endpoint accepting hardcoded session JSON.
- Claude Code skill: receives session, edits files in a real project (Insurance Insight or AuditKit).
- Test with `curl` — POST a fake session, watch Claude Code edit the right file.

Exit criteria: a `curl` command results in correct file edits in a real Svelte project.

### Phase 1 — Minimal extension, batch-aware (1–2 evenings)

**Goal**: get a real click-to-edit loop working, however ugly.

- Svelte + CRXJS extension scaffold.
- Side panel UI: list of annotations, each with selector + comment text fields.
- "Add annotation" button → opens a dialog.
- "Submit batch" button → sends to companion.
- WebSocket connection with reconnect logic.
- Claude Code skill long-polls and applies edits.

Exit criteria: open the extension, type a CSS selector + a comment in a form, hit submit, Claude Code edits the file.

### Phase 2 — Element selection (1 evening)

**Goal**: replace manual selectors with point-and-click.

- Content script that injects an overlay.
- Hover highlighting with element labels.
- Click to lock selection. Capture outerHTML, computed styles, nearby text, selector.
- Shadow DOM isolation for overlay styles.
- Comment input appears inline near selected element.

Exit criteria: hover any element on any page, click, type a comment, submit, edits land correctly.

### Phase 3 — Drawing canvas (2 evenings)

**Goal**: enable the actual drawing UX.

- Full-viewport canvas overlay layer above the element selector.
- Tools: arrow, rectangle, circle, freehand, pin.
- Multiple completed annotations render persistently (semi-transparent).
- In-progress stroke renders at full opacity.
- Drawings translate with scroll.
- Edge-aware comment input positioning (Figma-style).

Exit criteria: draw 5 different annotations across the page with different tools, all visible simultaneously, all submittable as a batch.

### Phase 4 — Screenshot + composite (1 evening)

**Goal**: agent sees what the user sees.

- `chrome.tabs.captureVisibleTab` from background worker.
- Composite annotations onto screenshot before sending.
- Per-annotation cropped thumbnails for the side panel.
- Full-page screenshot (scroll-and-stitch) on submit.

Exit criteria: agent receives a screenshot with red circles/arrows visible exactly where the user drew them.

### Phase 5 — MCP server + multi-agent (2 evenings)

**Goal**: works with Cursor, Cline, Continue, Zed, etc.

- Add MCP server layer to companion.
- Define MCP tools (`get_pending_session`, `mark_session_done`, etc.).
- Write Cursor adapter (config snippet + workflow doc).
- Write Aider adapter (script).
- Test each end-to-end with a real session.

Exit criteria: same workflow works in Cursor and Claude Code without changing the extension or companion.

### Phase 6 — Vite plugin for source mapping (1 evening) — Planned

**Goal**: instant, unambiguous edits.

- Vite plugin that injects `data-source-file` and `data-source-line` in dev.
- Extension reads these attributes when present. *Shipped* —
  `extension/src/content/capture.ts` already populates
  `target.sourceFile` / `target.sourceLine` from the attributes if any
  ancestor carries them.
- Falls back gracefully when absent. *Shipped.*
- The plugin itself: **not yet written.** Until then, projects can
  reuse another tool's source-attribute plugin or add the attributes
  by hand and Pinta picks them up.

Exit criteria: edits land in the right file on the first try, every time, in a project with the plugin installed.

### Phase 7 — Polish

Most of Phase 7 has shipped. What's left is genuinely small / nice-to-have.

**Shipped:**
- ~~Keyboard shortcuts.~~ **Shipped** as `Alt+S` (Select) / `Alt+P` (Pen
  / Draw) / `Alt+X` (Exit) / `Esc` (Cancel) / `Cmd+Enter` (submit in
  inline-editor popup). Originally Ctrl+Shift+S/D/R; moved to Alt to
  avoid Ctrl+Shift+R hard-reload collision and away from chord finger-
  twisting.
- ~~Session history view.~~ **Shipped.** Collapsible "History (N)"
  panel at the bottom of the side panel; status badges (drafting /
  submitted / applying / done / error), relative timestamps, applied
  summaries / error messages, screenshot path. Backed by a slim
  `GET /v1/sessions` endpoint (no annotation bodies).
- ~~Per-project `.pinta.json`.~~ **Shipped** as the URL-pattern config
  for multi-project routing (see Phase 9). Will grow into design-system
  context in a later pass.
- ~~Plan-then-execute toggle.~~ **Shipped** as **Auto-apply** toggle in
  the side-panel footer (the inverse semantics — default IS plan-then-
  execute; opt-in to skip the "reply 'go'" gate). Carried on the
  session as `autoApply: boolean`; skill §5 branches on it.
- ~~Copy-to-clipboard handoff.~~ **Shipped.** Secondary "Copy" button
  next to Submit; formats the session as markdown via
  `navigator.clipboard.writeText`. Useful for pasting into claude.ai
  web, ChatGPT, or any agent that doesn't speak Pinta's protocol.
- ~~Multi-project mode.~~ **Shipped** — see Phase 9.
- ~~Token-cost: optional screenshot.~~ **Shipped.** Checkbox in the
  submit footer; off by default so text-only batches skip capture
  (~1.5–2k vision tokens saved). Auto-locks to ON when a drawing
  annotation is in the batch (drawings have no DOM target, so the
  screenshot is the only context the agent has).
- ~~HMR-aware auto-reload.~~ **Shipped.** When a session reaches `done`,
  the side panel injects a one-shot probe via `chrome.scripting.execute
  Script` looking for Vite / Webpack / Next.js / Parcel HMR markers. If
  HMR is detected → no reload, footer shows "HMR detected ✓". If not
  detected → `chrome.tabs.reload(activeTabId)` (toggleable). A manual
  `↻` button is always available.
- ~~Dark mode.~~ **Shipped** across popup, side panel, and landing
  page. Theme persisted in `localStorage`; toggle in the popup; honors
  system `prefers-color-scheme` on first load.
- ~~Persistent pin badges on annotated elements.~~ **Shipped.** A small
  numbered brand-pink badge appears at the top-right corner of each
  annotated DOM element so the user has a visual breadcrumb of what's
  already picked. Survives scroll/resize, re-numbers when annotations
  are removed, clears on cancel-session.
- ~~Cancel-session button.~~ **Shipped.** Small `✕` next to the
  Submit button when status is `submitted` / `applying` / `done`.
  Marks the current session as `error` (agents that pick it up later
  skip cleanly) and creates a fresh `drafting` session. Hint text
  appears below ("Stuck? Click ✕…").

**Planned (still open):**
- Drag-to-reorder annotations.
- Group annotations by file in the side panel (once a session is
  applying — fewer screen-fulls during long batches).
- Undo last edit (git rollback).
- *Token-cost — Cropped composite screenshot.* Stitch only the union of
  annotation bounding rects (+ ~24px margin, tile cap so very-spread-
  out annotations don't degenerate to full-page anyway). Typically
  5–10× smaller than full-page; the agent still sees the annotation in
  visual context.
- Design-token picker integrations on `.pinta.json`.

### Phase 8 — Inline editing

Beyond commenting, let the user **directly tweak elements in the page**
and have the resulting CSS / DOM changes flow into the session as
high-precision annotations the agent can apply verbatim. Closes the gap
between "I want this to look like that" and showing the agent exactly
what "that" is.

**UX (per the design sketch):** when the user picks an element in select
mode, the inline popup gains a tabbed editor:

```
┌──────────────────────────────────────────┐
│  Editing  h2.text-3xl                    │
├──────────────────────────────────────────┤
│ [Content] Font  Sizing  Spacing  CSS     │
│                                          │
│   ▌  Hello world  that could be better   │
│                                          │
│   What should change? (free text)        │
│   ┌──────────────────────────────────┐   │
│   │                                  │   │
│   └──────────────────────────────────┘   │
│   ⌘↵ to save                             │
└──────────────────────────────────────────┘
```

**Tabs:**
- *Content* — text content + (for inputs) placeholder. Pre-filled with
  the live element. Edits apply to the DOM live so the user sees the
  result; the diff is captured.
- *Font* — family, size, weight, line-height, letter-spacing pickers
  populated from `getComputedStyle`.
- *Sizing* — width / height / min / max with unit selectors.
- *Spacing* — margin / padding split per side, with linked-sides toggle.
- *CSS* — free-form CSS textarea for anything else (`box-shadow:
  0 4px 12px rgba(...)`, `border-radius`, `display`, etc.).

**Annotation shape.** Rather than introducing a new `kind: "edit"`,
the shipped design extends the base `Annotation` with optional fields
populated by the inline editor (see §4 for the full type):

```ts
type Annotation = {
  // … existing fields (kind, target, comment, …) …

  customCss?: string;                 // raw CSS textarea
  cssChanges?: Record<string, string>;// kebab-case CSS prop → value
  contentChange?: { textBefore: string; textAfter: string };
  images?: AnnotationImage[];
};
```

The `kind` stays `"select"` (or whichever drawing kind triggered the
editor); the structured-edit payload rides on top. Multiple changes on
the same element collapse into **one annotation** so the agent gets the
full picture in one Edit pass.

**Live preview.** Edits mutate the live DOM via inline styles for instant
visual feedback. We capture a `before` snapshot once the popup opens so
the agent has both the diff and the original. On Cancel we restore.

**Agent semantics.** The skill (and MCP tools) gain a "edit" annotation
case: instead of grepping `nearbyText`, they pattern-match the source
file for the element + apply the captured `changes` as CSS additions or
property overrides. Frameworks vary — best-effort heuristics:
- Tailwind: convert the changed props to closest utility classes,
  modify the `class=` attribute.
- CSS-in-JS / styled-components: append to the rule.
- Plain CSS / Sass: append to the matching selector or open a sibling
  rule.
- Inline `style=` attribute: as a last resort.

**Out of scope for first cut:** drag-to-resize handles, SVG path editing,
animation timeline, design-token picker integrations.

**Status:**

- **8a — Shipped.** Tabbed editor wired into select mode with **7 tabs**
  (Comment, Content, Font, Sizing, Spacing, Grid, CSS — Comment +
  Content render as full word labels; the rest collapse to icon-only
  tabs with tooltips so the bar stays compact). Pickers populated from
  `getComputedStyle` and emit a structured `cssChanges: Record<string,
  string>` (kebab-case CSS properties), `contentChange: {textBefore,
  textAfter}` for the Content tab, and raw `customCss` for the CSS tab.
  Grid tab adds CSS-grid presets (1 / 2 / 3 / 4 / 5 / 6 / Auto-fit
  columns + gap). Agent applies per the project's actual framework
  (detected from `package.json` + the source file being edited) — no
  hardcoded Tailwind / CSS-in-JS assumptions in the payload.

- **8b — Largely shipped.**
  - *Live DOM preview* — **shipped**. As the user changes any
    Font / Sizing / Spacing / Content / CSS field in the popup, the live
    element on the page updates in real time via `style.setProperty`
    and `innerText`. Snapshot of the original `style.cssText` +
    `innerHTML` is taken on first selection.
  - *Cumulative preview (don't revert on Submit)* — **shipped**. The
    inline-style mutations stay applied after the user clicks Add, so
    the page accumulates a visual preview of every queued edit. Removing
    a card in the side panel rolls THAT element back from its stored
    snapshot; Cancel-session rolls all of them back. Re-editing an
    already-annotated element reuses the true-original snapshot as the
    baseline so rollback math stays correct.
  - *Per-side spacing splits with a linked toggle* — planned.
  - *Drag-to-resize handles* — planned.
  - *Design-token picker integrations* — planned.
  - *Inline edit affordance icon on hover* — planned.

- **8c — Image attachments — Shipped.** The annotation popover now
  accepts paste (Cmd/Ctrl+V) and drag-drop of images. Each attached
  image is added to `images: AnnotationImage[]` on the annotation and
  inserts a stable `[image1]`, `[image2]` token at the cursor in the
  comment text. Mirrors how Claude Dock references images in chat.
  Thumbnail strip in the popup with × to remove (renumbers tokens
  automatically). Side-panel cards render the thumbnails inline.
  Skill §7.4 instructs the agent to Read each referenced image for
  visual context before planning.

  ```ts
  type AnnotationImage = {
    id: string;            // "image1", "image2" — used in [imageN] refs
    mediaType: string;     // "image/png", "image/jpeg"
    dataUrl?: string;      // inline base64 (current shape)
    path?: string;         // disk path, set if companion extracts later
    name?: string;         // original filename if dropped from disk
  };
  ```

**Bug fixes that shipped alongside Phase 8 work** (worth noting because
they were each subtle):
- Selecting an element with nested children no longer flattens it —
  snapshot uses `innerHTML` (not `innerText`) so structure survives.
- Clicking inside the inline editor no longer dismisses the host page's
  popovers / dialogs — the shadow host now traps pointer/focus events
  in bubble phase so document-level "outside click" detectors don't see
  them.
- Switching to a different element while edits were typed against the
  previous one now restores the previous element AND wipes editor
  state, so the new pick starts clean.
- Tool button icons switched from Unicode glyphs (▢, ↘, ▭ — some don't
  render in every font) to inline SVG paths that follow `currentColor`.
- Active-tool button "pressed" state no longer paints white — the
  `bg-white` / `bg-brand-pink` tailwind utilities had identical
  specificity; refactored to mutually-exclusive class sets.

### Phase 9 — Protocol & coordination — Shipped

A cluster of cross-cutting capabilities that didn't fit Phases 0–6 but
that Phases 7+8 needed in place. Documented as one phase because they
all touch the wire protocol or the agent ↔ companion ↔ extension
contract.

**Shipped:**

- **SSE push delivery (`/v1/sessions/stream`).** One long-lived SSE
  connection per agent; each newly-submitted session arrives as a
  single `event: session\ndata: {json}` line. Replaces the per-cycle
  Bash-tool noise that long-polling generated in agent transcripts.
  The `/pinta` skill now defaults to push (`Monitor + curl -N`) and
  falls back to long-poll only via `/pinta --polling`. Backlog of
  already-submitted sessions is pushed on connect so reconnects aren't
  lossy. 20s SSE comments keep the connection from idle-closing.

- **Per-annotation status broadcast.** Each annotation has its own
  `status: "applying" | "done" | "error"` field (independent of the
  session-level status). Skill marks each annotation applying →
  `Edit` → done as it works through the batch; the side panel
  re-renders per card live (spinner / ✓ / red bang). When every
  annotation has settled, the companion auto-rolls the session status
  to `done` (or `error` if any failed).
  - HTTP: `POST /v1/sessions/:id/annotations/:annId/status`
  - MCP: `mark_annotation_applying`, `mark_annotation_done`,
    `mark_annotation_error`
  - WS: companion subscribes its store and pushes `session.synced`
    on every state change so the side panel sees agent-driven updates
    in real time without re-fetching (this also fixed an existing bug
    where session-level status updates over HTTP weren't reaching the
    side panel live).

- **Multi-project mode.** One companion process per project, all
  running concurrently:
  - **Auto port allocation** — `--port 7878` increments to the next
    free port (up to `7898` by default) when busy.
  - **Registry** at `~/.pinta/registry.json` — every running companion
    registers itself on startup with `{ id, port, projectRoot,
    urlPatterns, version, pid }`. Cleaned up on graceful shutdown;
    next-startup prunes stale entries as a backstop.
  - **URL-pattern routing** in `.pinta.json` per project. Side panel
    auto-routes the active tab to the matching companion. "Associate
    this URL" button writes the pattern to the project's `.pinta.json`
    so teammates inherit it.
  - `/pinta` skill calls `find-companion.js` which reads the registry
    and prints the port for the companion whose `projectRoot` matches
    cwd — exit codes 0 (found) / 2 (others running, none here) /
    3 (none at all) drive helpful messages back to the user.
  - **Strict per-project scoping.** When the active tab URL doesn't
    match the connected companion's URL patterns, the side panel hides
    the Tool toolbar / annotation list / Submit footer entirely and
    shows only the "associate or pick a different project" prompt.
    Pinta annotations don't bleed across projects.

- **First-claim-wins claim semantics.** When multiple Claude Code
  terminals subscribe to the same project (e.g. Claude Dock), all of
  them see every push. To prevent racing on the same submission, the
  skill calls `POST /v1/sessions/:id/claim` with a stable claimer id;
  the companion sets `claimedBy / claimedAt` on first claim and
  returns 409 to subsequent claimers. Losers silently skip back to
  streaming.

- **Screenshot extraction to disk.** When a session is submitted with
  an inline base64 PNG, the companion writes it to
  `.pinta/sessions/{id}.png` and replaces the field with
  `fullPageScreenshotPath`. Keeps API responses + persisted JSON slim
  and lets the agent `Read` the image directly. Skill notes the same
  pattern will apply to `AnnotationImage` payloads in a future
  optimization.

**Wire-protocol changes (vs the original spec §6.2):**

| Direction | Addition |
|---|---|
| HTTP | `GET /v1/sessions` (slim history list) |
| HTTP | `GET /v1/sessions/stream` (SSE push) |
| HTTP | `POST /v1/sessions/:id/annotations/:annId/status` |
| HTTP | `POST /v1/sessions/:id/claim` |
| HTTP | `GET /v1/registry` (multi-project snapshot) |
| HTTP | `GET /v1/url-patterns`, `POST /v1/url-patterns` |
| HTTP | `GET /v1/health` now returns `{ projectRoot, port, urlPatterns, registryId, version, pid }` |
| MCP | `mark_annotation_applying / done / error` |
| WS  | `session.submit` carries `autoApply?: boolean` |

`Annotation` shape gained `customCss`, `cssChanges`, `contentChange`,
`images`, `status`, `errorMessage`. `Session` gained `autoApply`,
`claimedBy`, `claimedAt`, `fullPageScreenshotPath`. None are breaking
— all are optional fields.

### Phase 10 — Standalone mode — Shipped

Companion-less operation for users who don't have the project on disk
— typically QA / testers hitting deployed staging URLs. The extension
runs fully locally; the companion is optional, only required for the
agent submission path.

**Trigger.** `appMode === "standalone"` whenever no companion is
selected — covers both "no companions running" and "companions exist
but none matched this URL". The picker stays in the side-panel header
as an escape hatch ("or pick project (N)") so a tester whose dev
later starts a companion can still associate the URL.

**Storage.** `extension/src/lib/local-store.ts` — IndexedDB
(`pinta-standalone` DB, single object store keyed by URL `origin`).
Picked over `chrome.storage.local` because the 5 MB cap there dies on
sessions with screenshots; IDB's quota is a fraction of disk space and
stores binary blobs efficiently. Different staging URLs (`example.com`
vs `another.example.com`) get isolated drafts; reload preserves them.

**Replacement actions in the side-panel footer.**
- **Submit to agent** is hidden (no companion to submit to).
- **Copy to clipboard** becomes the primary action — formats the
  session as markdown via the same `formatSessionAsClipboard` used in
  connected mode.
- **Download ▾** dropdown:
  - *Markdown + screenshot (`.zip`)* — captures the page using the
    existing scroll-and-stitch (`extension/src/background/screenshot.ts`),
    composites annotations + numbered badges, then bundles **one PNG
    per scroll section** so fixed sidebars / sticky headers don't appear
    duplicated stacked vertically. The MD references each section image.
  - *Markdown* — text only.
  - *Plain text* — text only.
- **Clear (✕)** wipes the IDB session for the current origin.

**Numbered badges (Phase 10 dependency).** Every annotation — selects,
draws, pin tool — gets a brand-pink numbered badge. Selects render
DOM-attached badges via `Overlay.svelte`; drawings render on the
canvas via `Canvas.svelte`; the composited screenshot bakes the same
numbers in. Numbering is unified via `globalSeq()` (chronological by
`createdAt`) so the on-page number, the side-panel list number, and
the badge in the screenshot all agree.

**Drawings auto-attach a target.** Freehand / arrow / circle / rect /
pin annotations now run `document.elementFromPoint` at their anchor
(arrow's end, shape's centroid) and capture the underlying element's
selector + outerHTML + nearbyText. Means the MD output is meaningful
even without a screenshot. Connected mode benefits too — the agent
sees both the drawing and an actionable selector.

**Out of scope for first cut:**
- Modal / popover capture (clicking Download dismisses page popovers
  via outside-click detection in most popover libraries; deferred to
  a hotkey / delayed-capture follow-up).
- Multi-tab IDB sync (two tabs on the same origin race; last write
  wins).
- Migrating an in-flight standalone session to a companion when one
  appears mid-session.

### Phase 11 — Import / Export `.pinta` for collaboration — Shipped

A round-trippable share format so a developer, designer, or QA tester
can hand a marked-up session to a teammate. Pinta sessions previously
lived in IndexedDB on one machine; the existing `.zip` Markdown +
screenshots download was human-readable but not re-importable. This
phase closes the loop — export to a single `.pinta` file, import on
any other machine, view (read-only) and **act on it** via the
recipient's connected agent or a fork into their own draft.

Partially answers Open question §9.6 (read-only sharing).

**File format.** A schema-versioned JSON envelope, single self-contained
file. Screenshots and per-annotation `images[]` are inlined as base64
dataUrls so the file is portable; transient companion-side fields
(`fullPageScreenshotPath`, `claimedBy`, `claimedAt`) are stripped on
encode. Decoder enforces a 25 MB cap to keep a malicious file from
blowing out IndexedDB on the recipient.

```jsonc
{
  "$pinta": "1",
  "manifest": {
    "title": "Header redesign — round 2",
    "author": "Mark",
    "description": "Spacing tweaks on hero & nav",
    "accentColor": "#7C3AED",
    "exportedAt": 1746360000000
  },
  "session": { /* a Session payload, transient fields stripped */ }
}
```

The manifest sits **outside** the `Session` type — wire contract
between extension ↔ companion stays untouched, shareability is a
side-panel + disk concern. Types in `shared/src/types.ts`:
`SessionManifest`, `ImportedSession`, `PintaFile`. Encoder /
decoder / validator in `extension/src/lib/pinta-file.ts`
(round-trip-tested in `pinta-file.test.ts`).

**Storage.** IDB schema bumped to v2 in `local-store.ts` with a new
`imported_sessions` object store keyed by a fresh local id (so
multiple imports of the same source file remain distinct). CRUD via
`getImportedSessions` / `addImportedSession` / `removeImportedSession`.

**Side-panel UI.**
- **Export** — "Share file (.pinta)" entry in the existing Download
  dropdown (standalone mode) and a separate "Share" button next to
  Copy in the connected-mode footer. Both open an inline form: title,
  author, description, accent color (6-swatch palette + custom). Author
  + last-used accent persist to `chrome.storage.local`.
- **Import** — top-level "Import" pill in the side-panel header
  (visible in any mode). File picker accepts `.pinta` / JSON. On
  successful decode the read-only viewer auto-opens so the user
  immediately sees what they imported (the alternative — silent toast
  + History entry — looked like nothing happened in connected mode).
- **History** — imported sessions render as a separate `Imported (N)`
  group at the top of the History dropdown, each row showing the
  manifest's accent color as a chip + author tag, with View / Fork /
  Remove actions.
- **Read-only viewer** — replaces the active drafting UI when an
  import is open. Title, author chip painted in the manifest's
  accentColor, description, source URL, and `AnnotationCard` list
  with `accentColorOverride + index` props so each card carries a
  numbered colored badge. Footer flips to imported actions:
  - **Send to agent** (connected mode) — submits a fresh `Session`
    payload to the connected companion via HTTP `POST /v1/sessions`
    with `status: "submitted"`, fresh annotation ids, and the
    `autoApply` toggle from the footer checkbox. Active draft is
    untouched.
  - **Copy** — markdown via `formatSessionAsClipboard` for
    claude.ai web / ChatGPT.
  - **Fork** (standalone mode) — clones the imported annotations
    into a new editable session for the current origin, with a
    `confirm()` guard if the existing draft has annotations
    (irreversible IDB overwrite otherwise).

**Content-script overlay.** When a session is being viewed, the
side panel sends `imported.show { manifest, annotations }` over
`chrome.tabs.sendMessage`; the content script renders inside the
existing shadow-DOM host:
- A fixed-position metadata pill in the top-right (`title · by author`,
  accent-colored dot).
- For each imported annotation, a numbered halo + badge in
  `--pinta-accent`. Anchored via `document.querySelector(target.selector)`
  when possible; falls back to the annotation's stored stroke coords
  with a "anchor not found" tooltip. Re-evaluated on every scroll /
  resize via the existing `tick` reactive.
- The user's own draft visuals (`<Canvas />` + `content.annotated[]`
  pin badges) hide while viewing. Data is preserved — closing the
  viewer restores them. Adding a new annotation also auto-closes the
  viewer (the user has shifted from "looking" to "working").

`imported.hide` clears the overlay back to the user's draft.

**Wire-protocol changes (vs the original spec §6.2):**

| Direction | Addition |
|---|---|
| chrome.tabs message | `imported.show` (side panel → content script) |
| chrome.tabs message | `imported.hide` (side panel → content script) |
| HTTP | reuses existing `POST /v1/sessions` for "Send imported to agent" — no new endpoint |

No companion-side changes. The receiving end of a `.pinta` file may
not have the project on disk at all, which matches the standalone-mode
audience (Phase 10).

**Bug fixes that shipped alongside Phase 11 work** (worth noting):
- Glob-pattern matching in `url-patterns.ts` now treats trailing `/*`
  as `(?:/.*)?` so `https://host/login/*` matches the bare `/login`.
  Previous semantics required `/login/...` and the "Save pattern"
  button looked like a no-op for routes whose path was the root of
  a section.
- Display-side dedupe of `app.session.annotations` by id — a corrupt
  imported session or a duplicated WS broadcast no longer crashes
  Svelte's keyed-each diffing with `each_key_duplicate` (which
  previously froze the entire annotation list at "0").
- `each` blocks in the side panel use composite keys (`${id}:${index}`)
  for collision-safe diffing as a second line of defense.

### Phase 12 — Built-in modules + Test Pilot — Shipped

The annotation → agent → source-edits loop covers visual changes, but
real teams need more: filing issues alongside the edit, running UAT
test scripts against the page, design-system checks, etc. Phase 12
adds **built-in modules** — small, agent-side integrations the user
opts into per submit (or per interactive surface). Each module ships
inside the extension with a settings schema and matching agent
instructions in the `/pinta` skill; new modules just add an entry to
`extension/src/lib/modules.ts` plus a §7.9 / §7.10 block in the skill.

Three module surface kinds:

- **`mode: "per-submit"`** — module ticks alongside the user's
  annotation batch and runs after the agent's source edits land
  (e.g. GitLab Issues files one ticket per annotation). Surfaces as a
  footer checkbox; carried on the wire as
  `session.modules: SessionModule[]`.
- **`mode: "interactive"`** — module owns its own tab in the side
  panel and drives the agent directly via one-shot ephemeral sessions
  carrying a `kind: "query"` annotation (Test Pilot). Surfaces as a
  top-level tab; carried on the wire as the new
  `module.query.submit` ClientMessage.
- **`mode: "inquiry"`** — Phase 14 addition. Module is cross-cutting,
  with no tab of its own; the agent answers questions without editing
  source files. Surfaces by lighting up FABs / checkboxes / header
  icons on other tabs when the module is enabled (Chat module lights
  up the global header chat FAB, Annotate's "Just Ask" checkbox, and
  the Test Pilot per-row chat icon). Carried on the wire as
  `module.query.submit` with `op: "chat"`.

**Shipped modules (v0.3.0+):**

- **GitLab Issues (`per-submit`).** Files one issue per annotation via
  the user's `glab` CLI on their machine — auth comes from
  `glab auth login`, **no tokens stored, transmitted, or written to
  disk by Pinta**. Issue body embeds the full-page screenshot
  (uploaded to the project's GitLab uploads endpoint), the selector,
  source file, and annotated page URL. Before filing, the agent
  prompts in chat for batch metadata (domain label, extra tags,
  assignees, or `later` to skip). The screenshot checkbox auto-locks
  ON when this module is ticked. Settings (`project_id`, `labels`)
  are optional overrides; the common case ("blank") just lets `glab`
  auto-detect from the current repo's remote.

- **Test Pilot (`interactive`).** Imports or agent-generates a
  markdown UAT spec, extracts a tested catalog, and lets a manual
  tester step through it row by row. Three operations driven via
  `module.query.submit`:

  - `op: "doc-parse"` — the user imports a hand-written `.md` test
    spec. The query carries the full file content; companion writes
    it to `.pinta/test-docs/{docId}.md` and strips the inline content
    before persisting the session JSON. Agent reads the file via
    standard `Read` tool, extracts sections + test rows, returns a
    `test-pilot-catalog` payload via `mark_session_done`.
  - `op: "generate-doc"` — agent walks the project (routes,
    components, auth flow) and writes a fresh UAT spec from scratch,
    same return shape. ~600s ceiling vs 120s for the other ops.
  - `op: "detail-steps"` — the user clicks `?` on a row; agent
    returns a `test-pilot-detail` payload with 3–6 (default) or 6–12
    (`detailed_steps: true`) step instructions. Side panel renders
    them with light markdown (inline code, fenced code blocks via
    Prism, `> Note:` callouts) and per-block copy-to-clipboard.

  The module exposes one setting — `detailed_steps: boolean` — that
  toggles between tester-friendly short steps (default, fewer tokens)
  and deeper technical steps (verbose, with curl/payload examples).
  Flipping the toggle invalidates every cached `test.detail` in the
  current catalog so the next row-open re-fetches at the new
  verbosity.

  Results persist to `chrome.storage.local` under
  `pinta-test-pilot:current`. Catalog rows can be marked Pass / Fail
  / Untested; the tab exports the whole catalog as a markdown report
  for sharing or PDF conversion via pandoc. Clearing the catalog
  also wipes `.pinta/test-docs/` via `DELETE /v1/test-docs` — UAT
  specs often carry real credentials or internal URLs so retention
  is intentionally tight.

**Annotation shape.** A new `kind: "query"` carries the JSON-encoded
request in `comment`. The annotation has no DOM target, no strokes,
and never appears in the regular annotation list — the extension's
`onMessage` routes the eventual `session.synced` into the matching
module slot instead of the draft.

**Wire-protocol changes (vs the original spec §6.2 / Phases 9 & 11):**

| Direction | Addition |
|---|---|
| Type   | `Annotation.kind = "query"` (interactive-module queries) |
| Type   | `Session.modules: SessionModule[]` + `SessionModule` |
| WS     | `module.query.submit` (extension → companion) |
| WS     | `module.query.created` (companion → extension targeted ack) |
| WS     | `session.submit` carries `modules?: SessionModule[]` |
| HTTP   | `DELETE /v1/test-docs` (wipe `.pinta/test-docs/`) |
| Skill  | `/pinta` §7.9 (per-submit modules) + §7.10 (Test Pilot ops) |
| Storage | `chrome.storage.local["pinta-test-pilot:current"]` (extension) |
| Disk   | `.pinta/test-docs/{docId}.md` (companion) |

**Security posture.** Localhost binding plus an Origin check on every
write endpoint (added with Phase 12): destructive routes like
`DELETE /v1/sessions` and `DELETE /v1/test-docs` reject browser-tab
requests carrying a non-extension Origin so a malicious page in the
user's own browser can't CSRF the companion. Module settings that
carry secrets (e.g. future tokens) are stripped from `.pinta`
share-file exports so they never travel between machines.

**Out of scope for first cut:**
- Per-tester sign-off / completion form on the exported catalog —
  addressed by Phase 13b (tester-sheet .md / .docx export + standalone
  local-parser import).
- Manual catalog editing (delete / add / rename / reorder rows and
  sections) — addressed by Phase 13.
- Custom user-authored modules (today's set is built-in only).
- Multi-catalog concurrency in Test Pilot (one catalog at a time).

---

### Phase 13 — Test Pilot: catalog editing — Shipped

Phase 12 ships a Test Pilot catalog the user can mark Pass / Fail
against but can't edit. In practice AI-generated catalogs (from both
`op: "doc-parse"` and `op: "generate-doc"`) miss rows, mis-word
expected behavior, or include scenarios that don't apply — and the
user's only recourse today is "regenerate and hope". Phase 13 lets
the user fix the spec in place from the side panel.

**Scope:**

- Delete section (and its child tests).
- Delete test.
- Add test to a section (appends an inline-editable blank row;
  agent-style `USER-N` id auto-minted).
- Add section at the catalog bottom.
- Edit existing test's title + expected text in-place.
- Rename section in-place.
- Move test up / down within a section; move section up / down within
  the catalog. (No cross-section moves in v1.)

All affordances reuse the existing inline-edit pattern (`editingField`
state, click-to-edit, Enter-commits) and the kebab menu shape already
used by the per-row status chip.

**Persistence model:** auto-write to disk. Every add / delete / edit /
reorder PUTs the recomposed markdown to a new companion endpoint
(`PUT /v1/test-docs/{docId}`), which rewrites
`.pinta/test-docs/{docId}.md`. With the on-disk file as the source of
truth and the agent's existing "preserve stable ids on regen" rule
(SKILL.md §7.10.1b), user edits naturally survive regenerate — added
rows stay, deleted rows stay deleted, edits stay edited. No new
client-side bookkeeping (no `userAdded` flag, no `hiddenTestIds`
set).

**ID scheme:** reserve prefix `USER-` for user-added tests. The agent
treats any `USER-*` id as permanent on regen — verbatim preservation,
no edits to title / expected. Added as a one-paragraph reinforcement
to SKILL.md §7.10.1b.

**Wire-protocol additions:**

| Direction | Addition |
|---|---|
| HTTP | `PUT /v1/test-docs/:docId` (replace the spec file's content) |
| Skill | SKILL.md §7.10.1b — `USER-*` preservation rule |

No new types, no new WS messages, no new storage keys.

**Out of scope for v1:**

- Cross-section moves (a test stays in its original section).
- Drag-to-reorder (move-up / down arrows only).
- Undo toast / multi-row select.
- Per-test ID renaming (id is the stable join key — renaming would
  break `test.detail` cache, status carry-over, and the agent's
  preservation rule).

**Full implementation plan:** see parked spec memory
`test-pilot-catalog-editing.md`.

**Tester-sheet round-trip (13b).** Layered on top: developer-side
"Export → Tester sheet (.md / .docx)" produces a catalog dump with
the agent's per-row Help steps embedded and the Result column blank.
External testers (typically running standalone Pinta with no
companion) import the .md via the empty-state file picker — a local
JS parser (`parseTestDocMarkdown` in `extension/src/lib/test-pilot-doc.ts`)
reconstructs the catalog + steps without round-tripping through the
agent. .docx is hand-rolled OOXML via the bundled `fflate` zip
helper; no new npm dependency. Round-trip closes when the tester
re-exports the same MD with Result marks filled in; the developer
re-imports and Pass/Fail status comes back populated.

### Phase 14 — Inquiry mode: contextual + global chat — Shipped

Adds *inquiry* as the third module mode alongside the existing
*per-submit* (GitLab Issues) and *interactive* (Test Pilot). Ships
as a **single module** (id: `chat`) with **one Settings toggle** —
when enabled, the same shared bottom-sheet chat surface lights up in
**three places**, all reaching the same agent over `op: "chat"`:

1. **Global chat** — header icon next to Settings. No surface context
   captured beyond session basics (appMode, activeTab, pageUrl,
   projectRoot, version). Quick FAQ-style asks ("how do I disable the
   screenshot opt-in?"). Rolling thread persisted at
   `chrome.storage.local["pinta-global-chat"]`, capped at 200
   messages.
2. **Annotate "Just Ask"** — checkbox in the submit footer. When
   ticked, Submit re-labels to *Ask agent* and opens the chat with
   `context.kind === "annotate-batch"` (annotations + screenshot path).
   Agent answers without editing source files. "Apply to source"
   pivots the thread back into a real submit. Threads keyed by
   session id under `pinta-annotate-chats`.
3. **Test Pilot FAB** — bottom-right of the Test Pilot tab. Opens with
   `context.kind === "test-detail"` (when viewing a row) or
   `"catalog-summary"` (catalog view). Per-row threads live inside
   the existing catalog blob at `TestPilotTest.chat[]`.

**Module gating.** All three surfaces are off by default. Flipping
the **Chat** module's toggle in Settings lights up:
- the header chat icon (global tier)
- the "Just Ask" checkbox in Annotate's submit footer
- the FAB on the Test Pilot tab

Disabling it hides all three; threads persist in storage but stop
rendering. Future setting can split this into per-surface toggles
("Enable global chat / on Annotate / on Test Pilot") — v1 ships as a
single switch to keep the Settings panel uncluttered.

**Wire protocol** extends `module.query.submit` with a new
`op: "chat"`. queryComment carries `{ op, prompt, context, history }`;
agent returns `{ type: "chat", reply }` via `mark_session_done`. Same
envelope as today's `doc-parse` / `detail-steps` ops — no new
ClientMessage variant.

**Why it matters:** today, every Pinta module is *action-shaped* —
file an issue, edit source, mark a test. Inquiry is the missing third
verb. Users repeatedly hit "I want to ask before I commit" moments
and context-switch to a separate agent window. Folding inquiry into
Pinta closes that loop and makes the agent feel like one assistant
surfaced where it's needed, not a per-module bot.

**Replaces** the Test Pilot per-row Notes textarea + `comment` field
that briefly existed pre-v0.3.1. Migration: existing `comment` strings
get seeded as the first user-role message in the row's new `chat[]`
array so typed notes survive the upgrade.

**Per-module verbosity.** `chat` ships with a `detailed_responses`
boolean setting (mirrors Test Pilot's `detailed_steps`). When off,
the agent returns short answers; when on, agent is encouraged to
include code snippets / step-by-step breakdowns. Single setting, all
three surfaces honor it.

**Sequential per-annotation flow.** Annotate "Just Ask" with multiple
annotations no longer bundles them into one ask. Each annotation gets
its own user bubble (with a target-selector chip) and its own focused
agent reply, in order — agent answers row 1, then row 2, etc.
Implemented as a polling `for…await` loop in `App.svelte`
(`askAgentWithBatch`) over `sendAnnotateChatMessageForAnnotation`,
which sets `context.annotationCount: 1` and `context.perAnnotation:
true` per ask so the skill answers focused.

**Module-mode taxonomy after this lands:**

| mode | examples | what it does |
|---|---|---|
| `per-submit` | GitLab Issues | Runs after source edits land |
| `interactive` | Test Pilot | Owns its own tab |
| `inquiry` | Chat | Cross-cutting; surfaces on other views via FAB / checkbox / header icon |

**Foundation plan** (Test Pilot tier only): see
`~/.claude/plans/precious-waddling-treasure.md`. Generalizing to the
three-tier module is the diff outlined in `chat-module-spec.md`.

**Out of scope for first cut:** streaming responses, multi-user
threads, chat history search, "agent proposes Pass/Fail" from reply
analysis, page-level FAB on the user's app (side-panel only).

### Phase 15 — AuditFlow module — 15a + 15b shipped; 15c-e Planned

A Lighthouse-style audit surface as a Pinta module. Module id:
`audit-flow`, mode: `interactive` (own side-panel tab). What makes
this Pinta-shaped rather than yet-another-Lighthouse: every finding
is one click from being **actionable** because the annotation → agent
edit pipeline is already there. The audit becomes the *source* of
work; existing modules become *sinks*.

**Four built-in categories** ship by default:

| Category | What it checks |
|---|---|
| Security | XSS, CSRF, secret leakage, `eval` / `{@html}` misuse, dep advisories |
| Performance | Bundle size, runtime hotspots, lazy-load opportunities, network waterfall |
| Accessibility | axe-core via headless Chrome + LLM semantic checks (ARIA, contrast, focus) |
| Mobile | Viewport diffs @ 375/768/1280, modal overlap, touch-target sizing |

**Framework-specific audits are user-defined.** Sidesteps the "which
version of Svelte do we hard-code for" problem. User pastes guidance,
uploads a `.md`, or supplies a URL (e.g. `svelte.dev/llms.txt`); the
agent reads the source and generates a structured `AuditRule[]` for
user review + edit before save. Stored in
`chrome.storage.local["pinta-custom-audits"]`. Each saved custom audit
appears as a checkbox alongside the four built-ins; ships with a
"Svelte 5" seed users install in one click.

**The "Svelte 5" seed = Svelte's own official skill** (locked
2026-06-01). Rather than hand-author the seed rules, bundle Svelte's
`svelte-core-bestpractices` markdown from `github.com/sveltejs/ai-tools`
(releases + `tools/skills/`) — it covers runes, `$effect`, `{@html}`,
event handling, styling, snippets, context, and legacy-avoidance — and
run it through the same md → `AuditRule[]` step. Optional second layer:
shell out to Svelte's `svelte-autofixer` (`npx @sveltejs/mcp`, via the
`POST /v1/audit/run-tool` endpoint) for a deterministic live-grammar
pass whose findings merge into the same category card. The sibling
`svelte-code-writer` skill carries that autofixer CLI. Ref:
`svelte.dev/docs/ai/skills`.

**Lighthouse-style UI**: big circular **overall score** card at the
top, **per-category cards** with their own ring score + finding tally,
expand to show check rows. Card view default; table view toggle for
bulk action. Each check is one of `pass | warn | fail | info` — passing
checks are first-class (reads better in stakeholder reports than
"5 issues found"). Deterministic scoring:
`(pass*1 + warn*0.5 + fail*0) / (pass + warn + fail) × 100`. Overall
is the average across categories. Ring color: 90-100 green, 50-89
amber, 0-49 red.

**Per-check action menu**:
- 🪄 **Fix with agent** — composes a Pinta annotation pre-filled
  with the check's label / value / where / fixHint; opens the
  Annotate tab with the draft so the user reviews before Submit
  (opt-in setting unlocks direct-apply). Default sink — most fixes
  land this way.
- 💬 **Discuss** — routes the check to Phase 14 chat with
  `context.kind === "audit-check"`. For "explain why" / "show an
  alternative".
- 📋 **File issue** — composes a GitLab issue body via the existing
  GitLab Issues module. Per-check or one rollup per category.
- ··· menu — Won't fix / Ignore / Snooze 30d (persisted across runs).

Table view supports multi-select + **Fix all with agent** for bulk
handoff.

**Cross-run continuity by fingerprint.** Every check has a stable
`sha1(category::label::where.file::where.line)` id; per-fingerprint
disposition (won't-fix reason, snooze deadline, in-flight fix's
sessionId) persists across runs. Run 4 vs. run 3 → "we've fixed 8,
ignored 2, 12 new findings introduced." Trend chart in 15d.

**Wire protocol** extends `module.query.submit` with `op: "audit"` —
no new ClientMessage variant. Agent returns `{type: "audit-flow-run",
runId, overall, categories: [{id, name, score, checks}]}` via
`mark_session_done`. New companion endpoint `POST /v1/audit/run-tool`
shells out to `axe-core` / `lighthouse` / `npx @sveltejs/mcp` etc.
when a category opts in.

**Phasing** (~3.5 weeks total; 15a alone ~4 days ships standalone):
- **15a** — Security only + card view + Fix-with-agent → Annotate
- **15b** — Add Perf / A11y / Mobile + table view + bulk Fix
- **15c** — Custom audits (paste / upload / URL → rules → save)
- **15d** — Cross-run fingerprint persistence + Won't fix / snooze
- **15e** — File-as-issue (GitLab module composition) + Discuss
  handoff (after Phase 14 chat lands)

**Full design** (locked decisions, per-category thresholds, sample
payloads, file-touch estimate, custom-audit safety rules): see parked
spec memory `auditflow-module-spec.md`.

**Out of scope for first cut:** Linear / Jira / Slack issue sinks
(GitLab-only until those modules exist); auto-apply fixes without
preview (opt-in setting); concurrent audit runs (single in-flight);
"agent proposes its own audit rules" meta-feature (deferred to 15d+).

---

### Phase 18 — Agent role routing (multi-terminal specialization) — 18a + 18b shipped

> Phases 16 (Test Pilot sign-off) and 17 (Claude Design) are spec-locked
> in parked memory + the public roadmap timeline; their full sections in
> this doc are still pending writeup.

Today's claim model is "all `/pinta` terminals in a project hear
every session, fastest claim wins" (SKILL.md §3.5). That's right for
redundancy but wasteful when a user runs 4 terminals and wants each
dedicated to a workload — Annotate work fights Test Pilot pings for
the same agent's attention.

Phase 18 adds **role flags** the user passes when starting `/pinta`.
Each agent declares which session kinds it claims; sessions outside
its role get silently skipped to other terminals.

```
/pinta --annotate    → base annotation submits (no chat / test-pilot / audit modules)
/pinta --test-pilot  → modules[].id contains "test-pilot"
/pinta --audit       → modules[].id contains "audit-flow"
/pinta --chat        → modules[].id contains "chat"
/pinta               → role = any (default; current behavior)
```

Flags stack: `/pinta --test-pilot --audit` claims both. At least one
terminal must accept each kind in use, else those sessions time out
unclaimed.

**Why now:** as more modules ship (chat, audit, future inquiry verbs),
the "one agent claims everything" pattern degrades — a long audit
run blocks the user's next annotation submit because both go to the
same terminal. Role routing lets a dedicated annotate agent stay
responsive while a separate audit agent does the heavy read.

**Phasing:**

- **18a — shipped.** Skill-only filter. Each `/pinta` reads its CLI
  args, filters sessions client-side before claiming. SKILL.md §1.5
  + §3.5.0 guard. Trust model: relies on each agent honoring its
  role.
- **18b — shipped.** Companion-enforced role on the claim endpoint.
  `POST /v1/sessions/:id/claim` accepts `role`; mismatches get 403
  with `expectedRole`. Closes the trust-model gap surfaced by an
  off-script agent rationalizing a cross-role "rescue" — see
  `companion/src/store.ts` `tryClaim` and the `Phase 18b` test block
  in `companion/src/store.test.ts`. Generalists (no flag) omit
  `role` and preserve original first-wins behavior.

**Out of scope for v1:** load balancing across terminals with the
same role (first-claim-wins still applies inside a role); auto-role
detection ("watch what this terminal does and infer its role"); UI
in the side panel to see which terminal claimed each session.

---

### Phase 19 — Importable / third-party modules (Module SDK) — v1 Shipped

Today every built-in module (GitLab Issues, Test Pilot, AuditFlow, Chat)
is **bundled**: a `ModuleSpec` in `extension/src/lib/modules.ts` plus a
hardcoded handler in `skill/pinta/SKILL.md`. Phase 19 turns modules into
a first-class **extension point** so third-party developers (and the user
themselves) ship their own without forking/rebuilding Pinta.

**v1 shipped scope (2026-06-03):** **per-submit modules only**, packaged
as a **single self-contained `.pinta-module.json`** file. `interactive` /
`inquiry` imported modules (custom tab/sheet) and zip/URL/registry
packaging are **deferred**.

**Module package — `.pinta-module.json`** (`ModulePackage` in
`shared/src/types.ts`):
```jsonc
{
  "$pintaModule": "1",
  "manifest": { /* ModuleManifest */ },
  "agent": "…markdown the skill loads when a session carries this id…"
}
```
- `ModuleManifest`: namespaced `id` (e.g. `acme.jira-sync` — **must**
  contain a dot), `name`, `version`, `author`, `description`, `mode`
  (v1 honors `per-submit`), `sessionCheckbox*`, `settings`
  (declarative `ModuleSettingSpec[]`, rendered generically),
  `recommendsScreenshot?`, `engines.pintaVersion?`, and `capabilities`
  (`read-files` | `write-files` | `run-tool:<cmd>` | `network:<host>`).
- `agent` is the author-written equivalent of a SKILL.md §7.x handler.
- (Zip + a `tools/` directory of declared shell-outs are a later tier.)

**Install / discovery** (`companion/src/{server,store}.ts`): the
extension reads the file, the user consents to capabilities, then
`POST /v1/modules` → the companion validates (manifest shape +
namespaced-id path-traversal guard) and writes
`.pinta/modules/<id>/{module.json,agent.md,install.json}`.
`GET /v1/modules` returns installed manifests + granted capabilities;
the extension merges them with `BUILTIN_MODULES` (`manifestToSpec`) so
settings forms + footer checkboxes render with zero bundled code.
`DELETE /v1/modules/:id` uninstalls.

**Run** — generic **SKILL.md §7.12 "imported-module dispatch"**: when
`session.modules[].id` is not a built-in, the agent path-guards the id,
loads `.pinta/modules/<id>/agent.md` + `install.json`, and follows it
under a **default-deny sandbox** (read + emit; writes/shell/network only
for the specific capabilities the user granted), after re-asserting the
top-of-skill **compliance covenant** so a hostile `agent.md` can't push
the user's Claude out of the interactive / bring-your-own-Claude lane.

**Security is the load-bearing concern** — an imported module is a
stranger writing instructions for the user's coding agent (and maybe
shell commands). Mandatory trust gate: at import, show the full
manifest + `agent.md` + declared capabilities and require explicit,
per-capability consent; default-deny file-write / shell / network;
apply the same trust-boundary rules as chat (§7.10.3 — module text and
captured page content are *data*, never escalation). Signed modules +
a curated registry (`pinta module add acme.jira-sync`) are a later
trust tier; v1 is local import + explicit review. Ties into the Pro/
marketplace question in the monetization spec.

**Anthropic-compliance hard rules (never cross).** The module platform must
not drift into a pattern Anthropic's terms forbid: (1) modules run inside the
user's own *interactive* Claude Code (`/pinta`) — never a headless / Agent-SDK
/ `claude -p` / cron path; (2) **bring-your-own-Claude per user** — a module
or registry must never route multiple users through one Claude subscription or
proxy credentials; (3) no Claude.ai OAuth. A hosted marketplace must keep each
user on their own API key, and Pinta charges for modules, never for Claude
access. (This is the exact line that got OpenClaw-style tools cut off from
subscriptions in Apr 2026.)

**Files (built in v1):** `shared/src/types.ts` (`ModuleManifest`,
`ModulePackage`, `ModuleCapability`, `InstalledModule` + the moved
`ModuleSettingSpec`/`ModuleMode`); `extension/src/lib/modules.ts`
(`manifestToSpec`); `extension/src/lib/state.svelte.ts`
(`installedModules` + import/uninstall/refresh + submit inclusion);
`SettingsPanel.svelte` (import button + consent dialog + uninstall);
`App.svelte` (footer checkboxes via `allModuleSpecs()`);
`companion/src/{server,store}.ts` (`/v1/modules` routes + write to
`.pinta/modules/` + validation); `skill/pinta/SKILL.md` (§7.12 generic
dispatch + compliance reassertion + capability gating). Sample:
`examples/echo-notes.pinta-module.json`.

**Interactive imported modules — data-driven board tab (tier 2; built,
uncommitted at 2026-06-23).** The "deferred" interactive tier above has
since been implemented: an imported module with `mode: "interactive"` + a
`tab` in its manifest renders its own side-panel tab with **zero bundled
code**, via the generic `ModuleBoardTab.svelte`. The manifest's `ModuleTab`
declares the tab (`name` / `icon` / `op` / `actionLabel` /
`cardActionLabel`) plus optional **`boardActions`** — header buttons next
to Refresh (e.g. the Tasks module's "End Day"). The module's agent returns
a **`ModuleBoard`** (`shared/src/types.ts`) as the session-summary JSON:
`groups` (each optionally a **`featuredSection`** that renders as its own
labelled section in the primary view), `cards`, and a `featured` pickup
list. Each card's `actions[]` has three mutually-exclusive flavours:
**`url`** (deep-link), **`op`** (round-trips to the module's agent, which
performs the action and returns a refreshed board), and **`clientOp`**
(handled entirely in the extension, no round-trip — e.g.
`add-to-test-pilot`, which files the card into the Test Pilot catalog under
a parent section named with today's date). Reference module:
`insclix.workflow-tasks`. Files: `extension/src/sidepanel/ModuleBoardTab.svelte`;
`ModuleTab` / `ModuleBoard*` in `shared/src/types.ts`; `runModuleOp` /
`runModuleClientOp` in `state.svelte.ts`.

**Deferred / open questions:** zip + `tools/` packaging; `inquiry`
imported modules (the `interactive` board tab is now built — see above);
signed modules + a
curated registry (`pinta module add acme.jira-sync`) and the Pro/
marketplace tie-in; richer `engines.pintaVersion` enforcement;
capability granularity (per-path file scope, multi-host network).

---

### Phase 20 — Floating toolkit (Device toolkit) — Planned

A **floating, draggable toolkit** overlaid on the user's page — Photoshop's
floating tool palettes are the mental model — rendered by the content-script
**Shadow DOM overlay** (`extension/src/content/`), NOT the side panel, so it
sits over the app the user is building. **Off by default**, enabled in
**Settings**, which exposes a list of *toolkit entries* the user toggles on
(the extensible part). **v1 ships exactly one entry: the Device toolkit.**

**Device toolkit.** Three buttons — **Mobile / Tablet / Laptop** — that
toggle the rendered **screen width**, plus a **Full / reset** to return to
the natural width. The three widths are **configurable** in their own
Settings sub-panel (defaults: Mobile `375`, Tablet `768`, Laptop `1280` px).
Active device is highlighted; clicking it again resets.

**How the width toggle works — pick at build time (the load-bearing
decision).** Three approaches, increasing fidelity + cost:

1. **In-page device frame (default for v1).** The content script constrains
   the document to the chosen width and centers it with a device frame — a
   responsive *preview*. **Permission-free**, no window disruption, instant,
   stays fully in the bring-your-own-Claude / minimal-permission compliance
   lane. **Caveat:** CSS `@media (max-width: …)` breakpoints do NOT fire
   (they read the real `window.innerWidth`), so it's a layout/width preview
   — excellent for fluid + `@container`-query layouts, approximate for
   breakpoint-driven ones. Ship this first.
2. **Resize the browser window.** The service worker resizes the Chrome
   window (`chrome.windows.update`, + side-panel width allowance) so real
   `@media` breakpoints fire. Truest layout, still permission-free, but it
   resizes the user's whole window on each toggle (disruptive; the side
   panel competes for space; Chrome's min window width makes ~375 borderline).
3. **Device emulation via `chrome.debugger`.** True device mode (viewport +
   device-pixel-ratio + touch + media queries) via CDP
   `Emulation.setDeviceMetricsOverride`, like DevTools' device toolbar. Most
   accurate. **Rejected posture:** needs the `debugger` permission — a new
   Chrome Web Store review item + a persistent "Pinta is debugging this
   browser" banner — the same approach Pinta deliberately rejected for
   Lighthouse. Only revisit if true emulation becomes a must-have.

**Settings shape.** A new **"Toolkit"** section: a master "Enable floating
toolkit" toggle, per-entry toggles (just "Device toolkit" in v1), and the
Device toolkit's editable width presets. Persists to `chrome.storage.local`
like other settings and flows to the content script via the existing
settings channel so the overlay shows/hides the palette live.

**Likely files:** a new floating-toolkit component under
`extension/src/content/` (Shadow DOM overlay, draggable, remembers its
position), the width-toggle logic (in-page CSS for approach 1), a "Toolkit"
block in `SettingsPanel.svelte`, and toolkit settings in `state.svelte.ts`.
No companion or agent involvement — a pure in-browser tool.

**Relation to the Multi-Device Canvas idea:** this is the lightweight,
single-viewport cousin of that parked concept (which renders Mobile/Tablet/
Laptop side-by-side in one pannable canvas). The Device toolkit toggles
*one* viewport in place; the canvas shows *all at once*. They can coexist —
ship the toolkit first.

---

## 9. Open questions

These are real design decisions that need answering before phase 5, but can be deferred until then:

1. **Conflict detection.** If annotation #1 says "make icon blue" and #3 says "remove the section containing it," #1 is wasted. Should the companion detect conflicts, or push that to the agent?

2. **Multi-tab sessions.** What if the user wants to annotate flows that span pages? Single session covering multiple URLs, or one session per URL?

3. **Authentication.** When pages require auth, the screenshot flow works (Chrome sees what's on screen) but the user's session cookies become part of the workflow. Anything special needed?

4. **Iframes / portals.** Element selection across iframe boundaries is awkward. v1 might just not support it.

5. **Persisted annotations.** Should sessions be re-openable for follow-up, or are they single-shot? Probably the latter for v1.

6. **Read-only mode.** Useful to share annotations with a teammate without auto-applying? *Partially answered by Phase 11* — `.pinta` share files round-trip a session between machines and open in a read-only viewer; the recipient can act on it (Send to agent / Copy / Fork) but can't edit the imported annotations themselves.

---

## 10. Risks

- **DOM-to-source mapping reliability.** Without the Vite plugin, grep-based mapping will sometimes pick the wrong file. Mitigation: agent presents the plan first, user confirms before edits.
- **Style isolation in content scripts.** Shadow DOM mostly solves this but some host pages have aggressive CSS resets that bleed in. Tested per-host coverage required.
- **MCP fragmentation.** MCP is young; different agents implement it slightly differently. Plan to test each integration explicitly per release.
- **Claude Code's tooling evolves.** Skills, slash commands, and tool conventions are still being refined. The adapter may need updates as Claude Code matures.
- **Screenshot performance.** Full-page screenshots via scroll-and-stitch are slow on long pages. Consider visible-only as default, full-page as opt-in.

---

## 11. Success criteria

The tool is working when:

- A developer can open Pinta on any of their Svelte projects, draw 3–5 annotations on a page, and Claude Code (or Cursor) applies all the changes correctly in under 60 seconds total.
- The same workflow works in at least three different agents without changing the extension or companion.
- Source mapping is correct >95% of the time on projects with the Vite plugin installed; >80% on projects without it.
- The extension feels good enough to use daily — drawing is responsive, selection is precise, comments are quick to type.

---

## 12. Appendix: tech choices, summarized

| Component | Choice | Rationale |
|---|---|---|
| Extension framework | Svelte 5 + TypeScript | User's stack; small bundles for content scripts |
| Extension build | Vite + @crxjs/vite-plugin | Designed for MV3 + HMR for content scripts |
| Extension styling | Tailwind + shadcn-svelte | User's stack; consistent with their projects |
| Style isolation | Shadow DOM | Standard pattern for content script UIs |
| Drawing | Raw Canvas 2D | Simpler than Fabric.js; <100 LOC for v1 |
| Companion runtime | Node 20+ | Ubiquitous; matches frontend tooling |
| Companion HTTP | Native `http` module | No framework needed for ~5 endpoints |
| Companion WS | `ws` package | De-facto standard, minimal |
| MCP | `@modelcontextprotocol/sdk` | Official SDK |
| Persistence | JSON files in `.pinta/` | Simple, debuggable, version-controllable |
| Reference agent | Claude Code (skill) | User's primary tool |
| Future agents | Cursor, Aider, Cline, Zed | Via MCP or HTTP |
