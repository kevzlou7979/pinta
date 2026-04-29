# Changelog

Notable changes shipped on top of the original V1 pipeline. Newest first.
For the architectural design behind each item, see
[`spec/SPEC.md`](spec/SPEC.md).

## 0.2.0 — 2026-04-29

### Added

- **Standalone mode (Phase 10).** When no companion is running anywhere
  (or when no companion's URL patterns match the active tab), the side
  panel runs locally — annotations land in IndexedDB
  (`pinta-standalone` DB), keyed by URL `origin`. Submit is hidden;
  **Copy to clipboard** becomes the primary action with a
  **Download ▾** dropdown:
  - **Markdown + screenshot (.zip)** — one composited PNG per scroll
    section so fixed sidebars / sticky headers don't duplicate
    vertically. MD references each section image so an agent picks
    them up automatically.
  - **Markdown** — text only.
  - **Plain text** — text only.

  Designed for QA / testers hitting deployed URLs (no project on disk,
  no Node, no companion required). The picker is still in the header
  as an escape hatch — click "or pick project (N)" to associate the URL.

- **Numbered annotation badges.** Every annotation — selects, draws
  (arrow / rect / circle / freehand / pin) — gets a numbered brand-pink
  badge. Selects render DOM-attached badges; drawings render canvas
  badges; the composited screenshot bakes the same numbers in.
  Numbering is unified across kinds via `globalSeq()` (chronological
  by `createdAt`) so the on-page number, the side-panel list number,
  and the badge in the screenshot all agree. Renumbers automatically
  on remove.

- **Drawings get an actionable target.** Freehand / arrow / circle /
  rect / pin annotations now run `document.elementFromPoint` at their
  anchor (arrow's end, shape's centroid) and attach the resulting
  element's selector + outerHTML + nearbyText. The MD output is
  meaningful even without a screenshot.

- **Multi-project hardening.**
  - Skill `find-companion.js` walks up `$CLAUDE_PROJECT_DIR` (else cwd)
    and picks the deepest registered `projectRoot`.
  - `pinta-mcp` three-tier discovery: explicit `--companion-url` →
    registry walk-up for cwd → `localhost:7878` default.
  - Claim TTL: 5-minute window, refreshed on every status update.
    Stale claims auto-release so a crashed agent doesn't orphan a
    session forever.
  - Registry `snapshot()` writes back pruned state and the atomic
    write retries on Windows EPERM/EBUSY/EACCES so concurrent
    companion startup no longer races.
  - Routing-conflict warning in the project picker when more than one
    companion's patterns match the current URL.
  - Pin badges clear in the active tab when switching companions.

- **Inline editing popover (Phase 8a/8b/8c).** When the user picks an
  element in select mode, the popover is now a 7-tab editor:
  - **Comment** — plain-English intent
  - **Content** — text content edit (emits `contentChange`)
  - **Font** — size / weight / color / line-height (icon-only tab `Aa`)
  - **Sizing** — width / height (icon `↔`)
  - **Spacing** — padding / margin / border-radius / background /
    box-shadow (icon `⊞`)
  - **Grid** — CSS-grid presets (1 / 2 / 3 / 4 / 5 / 6 / Auto-fit
    columns + gap) (icon `▦`)
  - **CSS** — free-form raw CSS textarea (icon `{ }`)

  Pickers populated from `getComputedStyle`; emit a structured
  `cssChanges: Record<property, value>` so the agent can translate to
  whatever the project's framework expects (Tailwind, styled-components,
  vanilla-extract, plain CSS) — no hardcoded assumptions in the
  payload.

- **Live DOM preview while editing.** As the user changes any picker /
  textarea, the live element on the page updates in real time via
  `style.setProperty` and `innerText`. Snapshot of the original
  `style.cssText` + `innerHTML` is captured for rollback.

- **Cumulative preview.** Submitting an annotation no longer reverts
  the live preview — the page accumulates a visual of every queued
  edit. Removing a card in the side panel rolls THAT element back from
  its stored snapshot. Cancel-session rolls all of them back.

- **Image attachments on annotations.** Paste (`Cmd/Ctrl+V`) or
  drag-drop an image into the comment popover. Each image attaches as
  `[image1]`, `[image2]` tokens at the cursor position. Thumbnail strip
  in the popup; side-panel cards render the thumbnails inline. Skill
  §7.4 instructs the agent to Read each referenced image for visual
  context.

- **Numbered pin badges on annotated elements.** Persistent brand-pink
  numbered badges at the top-right corner of each annotated DOM element
  so the user has a visual breadcrumb of what's already picked.
  Survives scroll/resize, re-numbers when annotations are removed.

- **Multi-project mode.** Run `npx pinta-companion .` in each project —
  each picks the next free port (7878 → 7879 → 7880 …) and registers
  itself in `~/.pinta/registry.json`. Side panel auto-routes the active
  tab to the right companion via URL patterns set per project in
  `.pinta.json`. Strict per-project scoping: when the active tab URL
  doesn't match the connected companion, the side panel hides the
  annotation UI and shows an "associate or pick another project"
  prompt. Annotations don't bleed across projects.

- **SSE push delivery.** New `GET /v1/sessions/stream` endpoint;
  `/pinta` defaults to `--push` (one long-lived Monitor stream, each
  new session arrives as a single `data: {json}` line). Long-poll loop
  is now the explicit fallback at `/pinta --polling`. No more per-cycle
  Bash-tool noise in the agent transcript during idle.

- **Per-annotation status broadcast.** Each annotation tracks its own
  `status: "applying" | "done" | "error"`. Skill marks per-annotation
  status as it works through the batch; the side panel shows a spinner
  / ✓ / red bang per card live via WS. When all settle, the companion
  auto-rolls the session status to `done` (or `error` if any failed).

- **First-claim-wins session claim.** `POST /v1/sessions/:id/claim`
  with first-wins semantics. When multiple Claude Code terminals
  subscribe to the same project (Claude Dock), exactly one claims any
  given submission; the others silently skip. No double-edits.

- **Auto-apply toggle.** Side-panel checkbox; when on, sessions submit
  with `autoApply: true` and the skill skips its "reply 'go' to apply"
  step (still shows the plan briefly).

- **HMR-aware auto-reload.** When a session reaches `done`, the side
  panel injects a one-shot probe for Vite / Webpack / Next.js / Parcel
  HMR markers. If detected → no reload, footer shows "HMR detected ✓".
  If not → `chrome.tabs.reload(activeTabId)`. Toggleable; manual `↻`
  always available.

- **Session history view.** Collapsible "History (N)" panel at the
  bottom of the side panel. Status badges, relative timestamps,
  applied summary / error message, screenshot path. Backed by the new
  `GET /v1/sessions` slim list endpoint.

- **Copy-to-clipboard handoff.** Secondary "Copy" button next to
  Submit; formats the session as markdown via
  `navigator.clipboard.writeText`. For pasting into claude.ai web,
  ChatGPT, or any agent that doesn't speak Pinta's protocol.

- **Optional screenshot toggle** (Phase 7 token cost). Side-panel
  checkbox, off by default — text-only batches skip the full-page
  capture and save ~1.5–2k vision tokens per submit. Auto-locks to ON
  when a drawing annotation is in the batch (drawings have no DOM
  target).

- **Cancel-session button** (`✕`). Marks the current session as `error`
  on the companion and creates a fresh `drafting` one. Escape hatch for
  stuck `submitted` / `applying` state.

- **Dark mode.** Popup, side panel, content overlay, landing page.
  Theme persisted in `localStorage`; toggle in the popup; honors system
  `prefers-color-scheme` on first load.

- **`pinta-companion` published to npm.** `npx pinta-companion .` runs
  the latest companion bundle in your project root — no clone, no
  build. Bundle is a self-contained ~210 KB CJS; companion is rooted at
  the bundled `dist/cli.cjs`.

- **`/build-pinta` setup skill.** Project-scoped Claude Code skill at
  `.claude/skills/build-pinta/SKILL.md`. One-shot installs deps, builds
  the extension + companion in parallel, installs the `/pinta` skill
  into `~/.claude/skills/pinta/`, and prints the path to load into
  Chrome.

### Changed

- **Hotkeys**: Ctrl+Shift+S/D/E → **Alt+S** (Select) / **Alt+P** (Pen /
  Draw) / **Alt+X** (Exit). Avoids the Ctrl+Shift+R hard-reload
  collision and the chord finger-twist. `Esc` cancels (unchanged);
  `Cmd/Ctrl+Enter` submits in the inline-editor popover.
- **Tool button icons**: Unicode glyphs (▢ ↘ ▭ ✎ ●) replaced with
  inline SVG paths so they render reliably across fonts/OSes and follow
  `currentColor` in both light and dark.
- **Active-tool button "pressed" state** — refactored to mutually-
  exclusive class sets so `bg-brand-pink` actually wins over
  `bg-white`. Adds an inset shadow + brand-pink ring for the pressed
  feel.

### Fixed

- Selecting an element with nested children no longer flattens it.
  Snapshot uses `innerHTML` instead of `innerText`.
- Clicking inside the inline editor popover no longer dismisses host-
  page popovers / dialogs (Radix, Headless UI, Floating UI). Shadow
  host now traps pointer/focus events in bubble phase.
- Switching to a different element while edits were typed against the
  previous one now restores the previous element AND wipes editor
  state, so the new pick starts clean.
- Session-level status updates over HTTP now reach the side panel live
  (companion subscribes its store and broadcasts `session.synced`).
- `Select` tool button no longer renders blank — was a flaky Unicode
  glyph; replaced with a solid mouse-pointer SVG.
- Screenshot capture respects Chrome's
  `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` (`SETTLE_MS` bumped from
  180 → 600).
- Friendlier error in side panel when content script isn't injected on
  the active tab (refresh the tab vs. `chrome://`).

## V1 — initial pipeline

End-to-end loop shipped (Phases 0–5b):

- **Phase 0** — Walking skeleton: companion HTTP + JSON store + skill
  stub.
- **Phase 1** — Chrome MV3 extension scaffold (Svelte 5 + CRXJS + Tailwind),
  side panel + popup + background worker, WebSocket round-trip.
- **Phase 2** — Element selection overlay (Shadow-DOM isolated),
  hover-highlight, click-to-lock, computed selector + outerHTML +
  computed styles + nearby text capture.
- **Phase 3** — Drawing canvas (arrow / rect / circle / freehand / pin),
  page-relative coords, scroll-aware redraw.
- **Phase 4** — Full-page screenshot via scroll-and-stitch, annotations
  composited onto the PNG.
- **Phase 5a** — Polished Claude Code reference adapter (skill +
  `start-companion.js` + screenshot extracted to disk).
- **Phase 5b** — MCP server for Cursor / Cline / Continue / Zed /
  Windsurf via the `pinta-mcp` stdio bridge.
