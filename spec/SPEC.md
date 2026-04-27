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
  strokes: Point[];                   // canvas coordinates, page-relative
  color: string;
  
  // What it points at (optional — pure drawings have no target)
  target?: {
    selector: string;                 // computed CSS selector
    outerHTML: string;                // truncated to ~2KB
    computedStyles: Record<string, string>;
    nearbyText: string[];             // for grep fallback
    boundingRect: DOMRect;
    sourceFile?: string;              // from Vite plugin if installed
    sourceLine?: number;
  };
  
  // The intent
  comment: string;
  
  // Context
  viewport: { scrollY: number; width: number; height: number };
};
```

### Session
A batch of annotations submitted together.

```ts
type Session = {
  id: string;
  url: string;
  projectRoot: string;                // companion was started in this directory
  startedAt: number;
  submittedAt?: number;
  annotations: Annotation[];
  fullPageScreenshot: string;         // base64 PNG, captured at submit
  status: 'drafting' | 'submitted' | 'applying' | 'done' | 'error';
  appliedSummary?: string;            // agent's summary of what it did
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

User adds the companion to their MCP config:

```json
{
  "mcpServers": {
    "pinta": {
      "command": "node",
      "args": ["/path/to/companion/server.js", "--mcp-only", "--project", "."]
    }
  }
}
```

Now `get_pending_session`, `mark_session_done`, etc. are available as tools in the agent. The user invokes the workflow with a natural prompt: "Pick up the visual edit session and apply the changes."

#### 6.3.3 Aider

A custom command in `.aider.conf.yml` or a wrapper script that polls the HTTP API and pipes the session as context into Aider's chat.

#### 6.3.4 Custom

Any agent that can make HTTP requests. The HTTP API is the universal lowest-common-denominator integration.

### 6.4 Vite plugin (optional, opt-in)

`vite-plugin-pinta` — adds `data-source-file` and `data-source-line` to root elements of components in dev mode. Modeled on `vite-plugin-svelte-inspector`. ~50 LOC. Without it, the extension still works (greps text). With it, edits are instant and unambiguous.

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

### Phase 6 — Vite plugin for source mapping (1 evening)

**Goal**: instant, unambiguous edits.

- Vite plugin that injects `data-source-file` and `data-source-line` in dev.
- Extension reads these attributes when present.
- Falls back gracefully when absent.

Exit criteria: edits land in the right file on the first try, every time, in a project with the plugin installed.

### Phase 7 — Polish (ongoing)

- Drag-to-reorder annotations.
- Group annotations by file in side panel.
- Keyboard shortcuts (D/S/R modes, Esc to cancel, Cmd+Enter to submit).
- Session history view.
- Undo last edit (rolls back via git).
- Per-project config file (`.pinta.json`) for design system context.
- Plan-then-execute toggle (require explicit confirmation before edits).
- ~~**Copy-to-clipboard handoff.**~~ **Shipped.** Secondary "Copy"
  button next to Submit; formats the session as markdown via
  `navigator.clipboard.writeText`. Useful for pasting into claude.ai web,
  ChatGPT, or any agent that doesn't speak Pinta's protocol.
- **Multi-project mode.** Today the companion is pinned to one
  `projectRoot` at startup — switching projects means restarting it. Make
  the companion hold N project roots; add a small project picker to the
  side panel header that ships the chosen root with `session.create`; have
  agents read `projectRoot` off the session payload they polled (already
  there, just enforced). Aim is "never restart the companion when
  bouncing between repos." Estimated ~50 LOC across companion store +
  WS protocol + side panel; no breaking change to the HTTP API.
- **Token-cost optimizations.** The full-page composite screenshot is the
  single biggest item in the agent's input context (~1.5–2k vision
  tokens per submit). Two cheap wins:
  - *Optional screenshot* — checkbox in the submit footer; off by default
    so text-only batches skip capture entirely. **Shipped.**
  - *Cropped composite* — instead of stitching the full page, render
    only the union of annotation bounding rects (with ~24px margin and a
    tile cap so very-spread-out annotations don't degenerate into a
    full-page capture anyway). Typically 5–10× smaller than the full
    page; the agent still sees the annotation in visual context.

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

**Annotation shape.** A new `kind: "edit"` carries:

```ts
type EditAnnotation = Annotation & {
  kind: "edit";
  changes: {
    content?: { textBefore: string; textAfter: string };
    css?: Record<string, string>;       // property → value, normalized
    customCss?: string;                 // raw block from the CSS tab
  };
};
```

Multiple changes on the same element collapse into **one annotation** so
the agent gets the full picture in one Edit pass.

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

**Estimated scope:** this is a real product feature, not a polish item.
Probably two full phases on its own (8a — popup tabs + Content / CSS
free-form; 8b — Font / Sizing / Spacing pickers + agent-side
Tailwind/CSS-in-JS heuristics). Ship 8a first to validate the loop.

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
