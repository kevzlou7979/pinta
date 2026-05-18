# Changelog

Notable changes shipped on top of the original V1 pipeline. Newest first.
For the architectural design behind each item, see
[`spec/SPEC.md`](spec/SPEC.md).

## Unreleased

### Added

- **Test Pilot — interactive UAT module** in its own side-panel tab.
  Import a hand-written markdown test spec or let the agent generate
  one from project context; step through the resulting catalog row by
  row with **Pass / Fail / Untested** marking. Per-row **?** fetches
  step-by-step instructions from the agent — rendered with light
  markdown (inline `code`, fenced code blocks with Prism syntax
  highlighting, `> Note:` callouts) and per-block copy-to-clipboard.
  Verbosity is controlled by a **Detailed help steps** module setting:
  off (default) gives short tester-friendly steps; on gives deeper
  technical context (curl, payloads, env vars). Toggling the setting
  invalidates every cached `test.detail` so the next row-open
  re-fetches at the new verbosity. The whole catalog exports as a
  markdown report with pass/fail/total tallies. Specs and results
  persist to `chrome.storage.local` (`pinta-test-pilot:current`) and
  `.pinta/test-docs/{docId}.md` respectively; clearing the catalog
  wipes both via the new `DELETE /v1/test-docs` endpoint (UAT specs
  often carry real credentials, so retention is intentionally tight).
  Wire-protocol-wise this is a new **interactive module surface**:
  `kind: "query"` annotations carry a JSON-encoded request via a new
  `module.query.submit` WS message, and the agent answers via
  `mark_session_done` with a structured payload that the extension
  routes back into the Test Pilot tab. See `spec/SPEC.md` §8 Phase 12.

- **`module.query.created` server message** — companion's targeted ack
  for `module.query.submit`. Lets the extension pin the resulting
  session id to the right interactive-module slot.

- **`session.create` flags `ephemeral` and `force`** — ephemeral
  sessions (Test Pilot queries) don't take over `activeId` so the
  user's annotation draft is preserved alongside; `force: true`
  discards any existing drafting session so the side-panel "Clear"
  button doesn't resurrect cleared annotations via the server's
  drafting-idempotency.

### Fixed

- **Detailed help steps toggle now invalidates cached row detail.**
  Flipping `detailed_steps` in Settings used to leave previously-fetched
  steps in place — the user would untick the deep-help setting and
  still see the verbose technical version. `setModuleSetting` now
  walks the catalog and clears `test.detail` on every row when the
  setting changes for the `test-pilot` module, so the next row-open
  re-fetches at the new verbosity.

- **CORS / CSRF hardening on companion writes.** `DELETE /v1/sessions`,
  `DELETE /v1/test-docs`, and `POST /v1/url-patterns` previously
  allowed `Origin: *` writes. A malicious page in the user's own
  browser could have wiped session history or injected URL patterns
  by fetching `http://127.0.0.1:7878/v1/sessions` with method DELETE.
  The companion now mirrors the Origin for `chrome-extension://*`
  requests and rejects cross-origin writes from any other browser
  page (no-Origin tools like curl / native CLIs still work).

### Changed

- **Test Pilot button labels.** Renamed "Generate MD with Agent" →
  **Generate Test Script** and "Import .md test spec" → **Import Test
  Script** for clarity in the empty-state CTA.

## 0.3.1 — 2026-05-13

### Fixed

- **Per-page annotation URLs survive hash routing.** Stamp
  `annotation.url` from the content script's `location.href` so
  hash-only navigations (e.g. `/#claims/active`) no longer fall back
  to the stale `lastUrl` that Chrome's `tabs.onUpdated` failed to
  report. Side panel adopts the content script's URL on every
  `overlay.ready` ping; `formatOtherPageUrl` now includes the hash so
  routes are distinguishable in the "other pages" chip.

- **Side panel detects hash + pushState changes.** Content script
  pings `overlay.ready` on `hashchange`, `popstate`, and
  monkey-patched `history.pushState` / `replaceState`. SPAs that
  route without a full page reload now update `pageUrl` reactively.

- **Pin badges persist through SPA re-renders.** Each annotated
  entry stores selector + outerHTML + nearbyText so a debounced
  MutationObserver can re-resolve the element via a 3-tier fallback
  (selector → outerHTML exact match → nearbyText snippet) when the
  SPA tears down and re-renders the DOM. Last-known page-coord rect
  is cached so badges stay pinned at their previous position until
  the new element is found.

- **`rectOf` no longer renders badges at (0,0) for detached elements.**
  Returns `null` when `!el.isConnected`. Badges are filtered by URL
  (`entry.url === currentUrl`) so the cached rect can't bleed badges
  from one SPA route onto another.

- **Removed transient session wipe in `rescan()`.** Was setting
  `this.session = null` and immediately re-hydrating, which fired a
  spurious `annotated.clear` to the content script via the
  `session.id` `$effect`. Root cause of "badge appears then
  vanishes" on every standalone-mode rescan.

- **Clear button truly clears everything.** Top trash icon now
  delegates to `cancelSession` — full reset of session annotations,
  on-page badges, inline DOM mutations, pending draft, and the
  per-entry rect cache. Standalone mode spawns a fresh empty session
  so the user can keep annotating without an extra click.

### Added

- **`/release` skill.** Automates version bumps, CHANGELOG, build,
  zip, git tag, npm publish, and GitHub release in one command.
  Chrome Web Store upload remains manual.

## 0.3.0 — 2026-05-11

### Added

- **Per-page annotations across navigation.** Multi-route reviews no
  longer fall apart on the first link click. Each `Annotation` now
  carries its own `url`, stamped at creation time. The side panel
  filters the list to the active page and surfaces a small chip
  *"N on M other pages"* with **Open** buttons to jump back to any
  annotated route. After navigation or hard reload, an
  `overlay.ready` handshake re-pushes the page's select-mode
  annotations to the freshly-injected content script so pin halos
  repaint automatically. One **Send to agent** still submits the
  whole multi-page batch as a single session — the skill keys off
  `annotation.url` (falling back to `session.url`) so GitLab issues
  file against the correct page and source-file grep can scope to
  the matching route. `rescan()` no longer wipes the in-progress
  draft when the user briefly visits a URL the project doesn't claim
  — the draft survives and re-arms once they navigate back.

- **Built-in modules — agent-side integrations triggered per submit.**
  Sessions can now carry a `modules` field listing per-submit
  integrations to run after the source edits land. Module spec lives
  in `extension/src/lib/modules.ts`; new modules add an entry plus
  matching agent instructions in `skill/pinta/SKILL.md` §7.9.
  Per-module settings (auth, defaults) are persisted in
  `chrome.storage.local` under `pinta-modules`; the side-panel
  footer renders each enabled module as a tickable checkbox so the
  user opts in per submit. A "Will run" emerald pill confirms the
  selection before submit.

- **GitLab Issues module.** First built-in module. Enable once in
  **Settings → GitLab Issues** (project ID + base URL), tick
  **Create GitLab issues** in the footer before submit, and the
  agent files one issue per annotation. Auth is delegated to the
  user's local `glab` CLI (`glab auth login`) — **no tokens stored
  or transmitted**. The full-page screenshot is uploaded to the
  project's `/uploads` endpoint once per session and embedded as
  markdown in each issue body, alongside the selector, source file,
  and per-annotation page URL. Before filing, the agent prompts in
  chat for batch metadata:

  - **Domain** — `client` / `server` / `shared` → `domain:<choice>` label
  - **Extra tags** — comma-separated (e.g. `polish, a11y`)
  - **Assignees** — comma-separated usernames

  Reply `skip` to file with just the defaults, or `later` to defer
  filing entirely on this submit (source edits still apply).

- **Screenshot lock for module dependencies.** Modules can declare
  `recommendsScreenshot: true` (GitLab Issues does). When such a
  module is ticked, **Include full-page screenshot** auto-checks
  AND locks — the side panel disables the checkbox and updates the
  hint to explain why. Prevents filing GitLab issues without visual
  context.

- **Markdown import.** The Import button now accepts both `.pinta`
  share files and the markdown the Copy button produces (`.md` /
  `.markdown`). The MD format is lossy compared to `.pinta` — no
  screenshot bitmap, no drawing geometry, no inline-editor data —
  but selectors + outerHTML + nearbyText + comments survive, which
  is enough to view, **Send to agent**, or **Fork** into an editable
  draft. Dispatch is by file extension with a JSON sniff as
  fallback so missing/wrong extensions still route correctly.

- **"N of M located" indicator for imported sessions.** When viewing
  an imported `.pinta` / `.md` session, the side panel now shows an
  emerald/amber pill — *"3 of 4 located"* — counting how many of
  the imported annotations' selectors actually resolved on the
  current page. Emerald when all hit, amber when any miss, so a
  recipient instantly knows whether they're on the right route /
  deployment for the share file.

### Changed

- Side panel splits annotations into `annotationsHere` /
  `annotationsElsewhere` and surfaces the latter via the chip.
  `canSubmit` and `allDone` still gate off the full session set so
  multi-page submits remain one shot.

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
