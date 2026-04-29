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
A single mark-up: one drawing or selection plus an optional comment.

```ts
type Annotation = {
  id: string;                         // uuid
  createdAt: number;

  // The mark
  kind: 'arrow' | 'rect' | 'circle' | 'freehand' | 'pin' | 'select';
  strokes: Point[];                   // page coordinates
  color: string;

  // What it points at — drawings auto-resolve via elementFromPoint at
  // commit time, so this is populated for every annotation in practice.
  target?: {
    selector: string;                 // computed CSS selector
    outerHTML: string;                // truncated to ~2KB
    computedStyles: Record<string, string>;
    nearbyText: string[];             // for grep fallback
    boundingRect: { x: number; y: number; width: number; height: number };
    sourceFile?: string;              // from Vite plugin if installed
    sourceLine?: number;
  };

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

type AnnotationImage = {
  id: string;            // "image1", "image2" — used in [imageN] refs
  mediaType: string;     // "image/png", "image/jpeg"
  dataUrl?: string;      // inline base64 (current shape)
  path?: string;         // disk path, set if companion extracts later
  name?: string;         // original filename if dropped from disk
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

```
GET  /v1/sessions/active            → current session or null
GET  /v1/sessions/:id               → full session
POST /v1/sessions/:id/status        → update status
GET  /v1/sessions/poll              → long-poll for next submitted session
GET  /v1/health                     → health check
```

**WebSocket protocol** (extension ↔ companion)

```ts
type ClientMessage =
  | { type: 'session.create', url: string }
  | { type: 'annotation.add', annotation: Annotation }
  | { type: 'annotation.update', id: string, patch: Partial<Annotation> }
  | { type: 'annotation.remove', id: string }
  | { type: 'session.submit', screenshot: string };

type ServerMessage =
  | { type: 'session.created', session: Session }
  | { type: 'session.synced', session: Session }
  | { type: 'session.applying' }
  | { type: 'session.done', summary: string }
  | { type: 'error', message: string };
```

**MCP tools exposed**

```
get_pending_session()             → Session | null
get_session(id)                   → Session
mark_session_applying(id)         → void
mark_session_done(id, summary)    → void
mark_session_error(id, error)     → void
get_screenshot(annotation_id)     → base64 PNG (cropped)
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

User adds the bridge to their MCP config:

```json
{
  "mcpServers": {
    "pinta": {
      "command": "npx",
      "args": ["pinta-mcp"]
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

---

## 9. Open questions

These are real design decisions that need answering before phase 5, but can be deferred until then:

1. **Conflict detection.** If annotation #1 says "make icon blue" and #3 says "remove the section containing it," #1 is wasted. Should the companion detect conflicts, or push that to the agent?

2. **Multi-tab sessions.** What if the user wants to annotate flows that span pages? Single session covering multiple URLs, or one session per URL?

3. **Authentication.** When pages require auth, the screenshot flow works (Chrome sees what's on screen) but the user's session cookies become part of the workflow. Anything special needed?

4. **Iframes / portals.** Element selection across iframe boundaries is awkward. v1 might just not support it.

5. **Persisted annotations.** Should sessions be re-openable for follow-up, or are they single-shot? Probably the latter for v1.

6. **Read-only mode.** Useful to share annotations with a teammate without auto-applying? Out of scope for v1.

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
