<p align="center">
  <img src="docs/assets/icons/icon-256.png" alt="Pinta" width="128" height="128" />
</p>

<h1 align="center">Pinta</h1>

<p align="center"><strong>Annotate your running web app. Let an AI agent do the edits.</strong></p>

<p align="center">
  <img src="docs/assets/screens/app.gif" alt="Pinta annotation flow — circle a UI element, type a comment, and an agent edits the source." width="860" />
</p>

Circle a button. Point at a heading. Type *"make this tonal"*. Pinta
captures the annotation, snapshots the page, and hands it to your coding
agent — Claude Code, Cursor, or any MCP-compatible tool — which edits the
matching source files for you.

> **Status: V1.** End-to-end pipeline is shipped: Chrome extension,
> companion server, full-page screenshot composite, Claude Code reference
> adapter, and MCP server for Cursor / Cline / Continue / Zed. See
> [`spec/SPEC.md`](spec/SPEC.md) for the design and
> [Roadmap](#roadmap) for what's next.

<p align="center">
  <a href="https://kevzlou7979.github.io/pinta/"><strong>Website</strong></a>
  &nbsp;·&nbsp;
  <a href="https://chromewebstore.google.com/detail/pinta/gnobpbogpbgdcpfjhbajfnbcfpbcnhah">Chrome Web Store</a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/pinta-companion">npm</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/kevzlou7979/pinta/releases">Releases</a>
</p>

---

## What's new

Recent additions on top of the original V1 pipeline:

- **Test Pilot — interactive UAT module in its own side-panel tab** *(post-v0.3.1)*.
  Import a hand-written markdown test spec (or let the agent generate
  one from project context), get a tested catalog of sections + rows
  to step through manually. Each row can be marked **Pass / Fail /
  Untested**; clicking the **?** asks the agent for step-by-step
  instructions, rendered with light markdown (inline `code`, fenced
  blocks with syntax highlighting, `> Note:` callouts) and per-block
  copy-to-clipboard. A **Detailed help steps** setting in the module
  config toggles between short tester-friendly steps (default, fewer
  tokens) and deeper technical context (curl, payloads, env vars).
  Export the whole catalog as a markdown report with pass/fail/total
  tallies (pipe through `pandoc results.md -o results.pdf` for PDF).
  Wire-protocol-wise this is a new **interactive module surface**:
  `kind: "query"` annotations carry the JSON-encoded request via a new
  `module.query.submit` WS message; the agent answers via
  `mark_session_done` with a structured payload that the extension
  routes back into the Test Pilot tab. UAT specs live in
  `.pinta/test-docs/` and are wiped when the catalog is cleared
  (specs often carry real credentials). See `spec/SPEC.md` §8 Phase 12.
- **Built-in modules — agent-side integrations triggered per submit** *(v0.3.0)*.
  Pinta now ships with built-in *modules* that ride along on a session and
  hand the agent extra work after the source edits land. The first one is
  **GitLab Issues**: enable it once in **Settings**, tick **Create GitLab
  issues** in the footer before submitting, and the agent files one issue
  per annotation via the user's `glab` CLI — auth comes from
  `glab auth login`, **no tokens stored or transmitted**. Issue body
  embeds the full-page screenshot (uploaded to the GitLab project's
  uploads endpoint), the selector, source file, and the annotated page
  URL. Before filing, the agent prompts in chat for batch metadata —
  domain (`client` / `server` / `shared` → label `domain:<choice>`),
  extra tags, assignees, or `later` to defer entirely. The screenshot
  is auto-checked + locked when the module is ticked so issues never
  go out without visual context. Module spec lives in
  `extension/src/lib/modules.ts`; new modules just add an entry there
  plus matching agent instructions in `skill/pinta/SKILL.md` §7.9.
- **Per-page annotations across navigation** *(v0.3.0)*. Reviews of a
  multi-route flow no longer fall apart on the first link click. Each
  annotation now carries its own `url`; the side panel filters the
  list to the page you're currently looking at and surfaces a chip
  *"N on M other pages"* with **Open** buttons to jump between routes.
  Pin badges repaint automatically after navigation / hard reload via
  an `overlay.ready` handshake — open the page again, the halos come
  back. One Send-to-agent submits the whole multi-page batch as a
  single session; the skill keys off `annotation.url` so the GitLab
  module files each issue against the right page, and route-scoped
  grep narrows source-file lookup. Stays connected when the user
  briefly visits a URL the project doesn't claim — drafts no longer
  silently wipe.
- **`.pinta` share files — collaboration without source access** *(v0.2.0)*. Export
  any session as a single self-contained `.pinta` file (manifest with
  title / author / description / accent color, plus the session JSON
  with screenshots inlined). A teammate, designer, or QA tester can
  drop the file into their Pinta extension and it lands in **History →
  Imported (N)**, opens in a read-only viewer, and surfaces three
  actions: **Send to agent** (submits to *their* connected companion
  as a new session — your machine isn't in the loop), **Copy** (the
  markdown for claude.ai web / ChatGPT), and **Fork** (clone into
  their own editable draft, in standalone mode). The page itself
  shows a metadata pill in the top-right and accent-colored numbered
  halos at each annotation's target so a recipient sees at a glance
  whose marks are whose. **In v0.3.0** the Import button also
  accepts the markdown the Copy button produces (`.md` /
  `.markdown`) — lossy compared to `.pinta` (no screenshot bitmap,
  no drawing geometry) but enough to view, **Send to agent**, or
  **Fork**. When viewing an imported session, an emerald/amber pill
  ("3 of 4 located") shows how many selectors actually resolved on
  the current page so a recipient knows whether they're on the
  matching route. See `spec/SPEC.md` §8 Phase 11.
- **Standalone mode** — the side panel works fully without a companion.
  Designed for QA / testers hitting deployed URLs (no Node, no project
  on disk, no companion to start). Annotations live in the browser
  (IndexedDB, keyed by URL origin); **Copy to clipboard** is the
  primary action and a **Download ▾** dropdown ships either pure
  Markdown / Plain text, or a **`.zip` of MD + per-section composited
  PNGs** (one PNG per scroll position so fixed sidebars don't duplicate
  vertically). Hand the zip to Claude / Cursor / any agent that reads
  files — it picks up the screenshots automatically.
- **Numbered annotation badges** — every annotation (selects + draws +
  pins) gets a brand-pink numbered badge on the page, in the side
  panel, and baked into the screenshot. Numbering is unified across
  kinds (chronological by creation), so "annotation 3" means the same
  thing everywhere.
- **Drawings get an actionable target** — freehand / arrow / circle /
  rect / pin annotations now resolve the element under the drawing's
  anchor and attach selector + outerHTML + nearbyText. The MD output
  is meaningful even without a screenshot.
- **Inline editing popover** — pick an element, get a 7-tab editor
  (Comment / Content / Font / Sizing / Spacing / Grid / CSS). Live DOM
  preview as you type; the page accumulates a visual preview of every
  queued edit and rolls back per-card on Remove. Pickers emit
  framework-neutral `cssChanges`; the agent translates to whatever the
  project actually uses (Tailwind / styled-components / vanilla-extract /
  plain CSS — no hardcoded assumptions).
- **Image attachments** — paste (Cmd/Ctrl+V) or drag-drop images into
  the popover; they attach as `[image1]`, `[image2]` tokens in the
  comment. Agent reads each as visual context.
- **Multi-project mode** — `npx pinta-companion .` in each project root
  picks the next free port, registers in `~/.pinta/registry.json`, and
  the side panel auto-routes the active tab to the right one via URL
  patterns. Strict per-project scoping: annotations don't bleed across
  projects.
- **SSE push delivery** — `/pinta` defaults to `--push` (one long-lived
  Monitor stream, no polling noise in the agent transcript). Long-poll
  fallback via `/pinta --polling`.
- **Per-annotation status** — each card flips to ✓ as the agent
  finishes it, live via WS broadcast.
- **First-claim-wins** — when multiple Claude Code terminals subscribe
  to the same project (Claude Dock), one of them claims each session
  and the others silently skip. No double-edits.
- **Auto-apply toggle** — opt-in fast-iteration mode that skips the
  agent's "reply 'go'" confirmation step.
- **HMR auto-reload** — when a session lands and HMR isn't detected on
  the active tab, the side panel reloads it for you. Toggleable.
- **Dark mode** — popup, side panel, landing page.
- **Auto-detect tool icons** — replaced flaky Unicode glyphs with inline
  SVG paths that follow `currentColor` in light + dark.
- **Hotkeys** — `Alt+S` (Select) / `Alt+P` (Pen) / `Alt+X` (Exit) /
  `Esc` (Cancel) / `Cmd+Enter` (submit in popover). Avoid Ctrl+Shift+R
  hard-reload collision.

See [`spec/SPEC.md` §7–9](spec/SPEC.md) for the full status of each.

---

## What V1 includes

| Capability | Status |
|---|---|
| Chrome MV3 extension (Svelte 5, side panel + popup, Shadow-DOM overlay) | shipped |
| Element selection — selector + outerHTML + computedStyles + nearbyText | shipped |
| Drawing canvas — arrow / rect / pen / pin (page-relative coords) | shipped |
| Inline editing popover — Comment / Content / Font / Sizing / Spacing / Grid / CSS | shipped |
| Live DOM preview while editing (mutate inline styles, snapshot for rollback) | shipped |
| Cumulative preview — kept on the page as you Add; rolled back per-card on Remove | shipped |
| Image attachments — paste / drop into the popover with `[image1]` tokens | shipped |
| Numbered pin badges on annotated elements (per-page session breadcrumb) | shipped |
| Full-page screenshot composite — opt-in, auto-on for drawings | shipped |
| Per-annotation status — spinner / ✓ / ! per card, live via WS broadcast | shipped |
| Session history view + applied summary persisted | shipped |
| Auto-reload after edits — HMR detection (Vite / Webpack / Next.js / Parcel) | shipped |
| Dark mode — popup, side panel, landing page (system + localStorage) | shipped |
| Auto-apply toggle — skip the agent's "reply 'go'" gate, opt-in | shipped |
| Live submit-footer status — pending pill while submitted/applying, "Annotate again" once every card has settled | shipped |
| Companion server — HTTP + WebSocket + SSE push + JSON store + per-project registry | shipped |
| Multi-project mode — auto port allocation, URL-pattern routing, strict per-project scoping | shipped |
| First-claim-wins session claim (multi-terminal coordination, e.g. Claude Dock) | shipped |
| Claude Code adapter — push handoff (default) + polling fallback | shipped |
| MCP server for Cursor / Cline / Continue / Zed / Windsurf | shipped |
| Aider adapter (poll script) | shipped |
| Copy-to-clipboard fallback for claude.ai web / ChatGPT / etc. | shipped |
| Import / Export `.pinta` share files (+ markdown import, "N of M located" indicator) — round-trippable session collaboration | shipped |
| Per-page annotations across navigation — per-annotation URL, side-panel filter, halo replay | shipped |
| Built-in modules — GitLab Issues via `glab` CLI (no tokens stored), screenshot embed, chat-based metadata prompt | shipped |
| Test Pilot — interactive UAT module (import / agent-generate spec, Pass/Fail catalog, per-step copy, markdown export) | shipped |
| `pinta-companion` published to npm — `npx pinta-companion .` | shipped |
| `vite-plugin-pinta` for instant source mapping | planned (Phase 6) |
| Drag-reorder annotations, group by file, undo last edit via git | planned (Phase 7) |
| Drag-to-resize handles, per-side spacing splits, design-token pickers | planned (Phase 8) |
| Cropped composite screenshot (5–10× smaller, only annotation bboxes) | planned |

---

## How it works

```
   Annotate                  Capture                  Edit
   ────────                  ───────                  ────
  ┌────────┐               ┌────────┐               ┌────────┐
  │ Chrome │  WebSocket    │ Pinta  │  HTTP / MCP   │ Claude │
  │  ext.  │ ◄──────────►  │ comp-  │ ◄──────────►  │  Code  │
  │        │               │ anion  │               │ Cursor │
  └────────┘               └────────┘               └────────┘
   side panel                 :7878                  edits files
   + overlay              .pinta/sessions/           runs HMR
```

1. **Draw / point** at things in your running app.
2. **Submit** — the extension takes a full-page screenshot, bakes the
   annotations onto it, and sends the session to the companion.
3. **Agent picks up** the session, presents a per-file edit plan, and (with
   your confirmation) applies the changes. HMR shows the result.

---

## Quickstart

**Two steps.** Node 20+, Chrome (or any Chromium-based browser), and a
coding agent — Claude Code is the reference; Cursor / Cline / Continue / Zed
work via MCP.

### 1. Install the Chrome extension

[**Install Pinta for Chrome →**](https://chromewebstore.google.com/detail/pinta/gnobpbogpbgdcpfjhbajfnbcfpbcnhah)
(Chrome Web Store). Open the side panel from the toolbar.

### 2. Run the companion in your project

```bash
npx pinta-companion .
```

Then in Claude Code:

```
/pinta
```

That's it. Annotate, hit **Send to agent**, and Claude Code picks up
the session and edits the source files. No clone, no build, no token
to copy.

For Cursor / Cline / Continue / Zed, drop this into your agent's MCP
config:

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

> **Hacking on Pinta itself?** See [Development](#development) below for
> the source build (`git clone` → `npm install` → `npm run build`,
> load unpacked in Chrome).

---

## Daily workflow

### 1. Start the companion in your project root

```bash
npx pinta-companion .
```

No clone or build needed — `pinta-companion` is published to npm as a
self-contained bundle (~210 KB). Runs on Node 20+. Alternatives if you've
cloned the repo: `node ~/.claude/skills/pinta/start-companion.js .` or
`npm run dev:companion -- --project /path/to/your/app`.

The companion listens on `http://127.0.0.1:7878` (auto-incrementing to
the next free port if 7878 is busy — useful when you're running Pinta
on multiple projects in parallel) and writes sessions to
`{project}/.pinta/sessions/{id}.json` (with the screenshot alongside as
`{id}.png`).

Each running companion registers itself in `~/.pinta/registry.json` so
the side panel and the `/pinta` skill can find the right one for the
project / tab you're working on. See [Multi-project mode](#multi-project-mode).

### 2. Open your app in Chrome and the Pinta side panel

Toolbar icon → side panel. The side panel will say **Connected** when it
finds the companion.

### 3. Annotate

- Press **`Alt+S`** on the page to enter **Select** mode — hover an
  element, click to lock it, type a comment, hit **Add**.
- Press **`Alt+P`** to enter **Draw** mode — pick a tool (arrow /
  rect / pen / pin), drag on the page, comment, **Add**.
- Annotations appear as cards in the side panel. Edit, delete, reorder.

### 4. Submit

Hit **Send to agent**. The extension posts the session over the WS to the
companion. The screenshot is **opt-in** (off by default) and auto-locks-on
when there's a drawing in the batch — selectors + nearby text are usually
enough for `select`-kind annotations, and skipping the capture saves
~1.5–2k vision tokens per submit.

### 5. Hand off to your agent

**Claude Code:** type `/pinta` (push mode, default — wakes the moment the
companion has a session) or `/pinta --polling` (long-poll fallback for
sandboxed setups). The skill picks up your session, presents an edit plan
grouped by file, and waits for your confirmation before editing.

**Cursor / Cline / Continue / Zed:** see
[`adapters/cursor/README.md`](adapters/cursor/README.md) for the MCP
config. Then prompt: *"Pick up the pending Pinta session and apply the
changes — show me the plan first."*

**Aider:** see [`adapters/aider/pinta-poll.sh`](adapters/aider/pinta-poll.sh).

**Anything else (claude.ai web, ChatGPT, etc.):** the side panel has a
**Copy** button that formats the session as markdown — paste into the
agent's chat. Useful when you can't run a CLI.

**Custom HTTP:** speak `/v1/sessions/poll` and `/v1/sessions/:id/status` —
that's the universal lowest-common-denominator.

### 6. Watch the result

After the agent applies the edits, the side panel detects HMR
(Vite / Webpack / Parcel) on the active tab and offers to refresh
automatically. Each annotation card flips to **✓** as it lands; the
screenshot, plan, and applied summary stay in **History** for later.

---

## Multi-project mode

Run Pinta on more than one project at once — each `npx pinta-companion .`
picks the next free port (7878 → 7879 → 7880 …). All running companions
register themselves in `~/.pinta/registry.json`, which lets:

- **The side panel** show a project picker in the header. The active tab
  is auto-routed to the right project via URL patterns (e.g.
  `http://localhost:5173/*` → `claims-forms`). Click a tab once and use
  the **Associate this URL** button — the pattern is committed to that
  project's `.pinta.json` so teammates inherit it.
- **The `/pinta` skill** find the companion whose `projectRoot` matches
  the agent's `pwd`. No more "wrong project" submits when you forget to
  restart in a different repo.

Project-scoped `.pinta.json` (committed):

```json
{
  "urlPatterns": [
    "http://localhost:5173/*",
    "https://*.staging.example.com/*"
  ]
}
```

`*` matches one path segment, `**` matches multiple. If a tab matches
zero or multiple companions, the picker stays open so you choose
explicitly — no silent mis-routing.

---

## Architecture

```
pinta/
├── spec/SPEC.md           full design spec
├── shared/                @pinta/shared  — TypeScript types
├── companion/             @pinta/companion — Node 20+ HTTP / WS / MCP server
├── extension/             @pinta/extension — Chrome MV3 (Svelte 5 + CRXJS)
├── skill/pinta/           Claude Code reference adapter (skill + installer)
├── adapters/
│   ├── cursor/            Cursor / Cline / Continue / Zed MCP setup
│   └── aider/             Aider poll script
├── scripts/               install + smoke-test scripts
└── docs/                  GitHub Pages landing page
```

**Boundaries that matter:**

- The extension knows nothing about agents.
- The companion knows nothing about specific agents — it exposes a generic
  HTTP API and an MCP server.
- Agents know nothing about the extension — they consume sessions from the
  companion.

That separation is the whole point. It's why "works with any coding agent"
is real and not aspirational.

---

## Hotkeys

| Key | Action |
|---|---|
| `Alt+S` | Toggle Select mode |
| `Alt+P` | Toggle Draw mode |
| `Alt+X` | Exit to idle (alternative to Esc) |
| `Esc` | Cancel in-progress stroke → pending comment → exit mode |

---

## HTTP API

Versioned at `/v1/`. Used by every non-MCP adapter.

```
GET  /v1/health                      → 200 OK
GET  /v1/sessions/active             → current session or null
GET  /v1/sessions/:id                → full session
GET  /v1/sessions/poll               → long-poll for next submitted session (25s)
POST /v1/sessions/:id/status         → { status, summary?, errorMessage? }
```

Full WebSocket protocol and MCP tool list are in
[`spec/SPEC.md`](spec/SPEC.md#62-companion-server-node).

---

## Development

```bash
npm install                                    # install all workspaces
npm run dev:companion -- --project /some/app   # run the companion against a target project
npm run dev --workspace @pinta/extension       # vite dev for extension HMR
npm run build                                  # build all workspaces
bash scripts/post-fake-session.sh              # smoke-test the loop without a browser
```

The smoke-test script is the fastest way to verify a fresh install — it
posts a fake session to the companion and confirms the agent-facing
endpoints respond as specified.

---

## Roadmap

V1 covers the core loop. What's next, in priority order:

- **Phase 6 — `vite-plugin-pinta`.** Inject `data-source-file` /
  `data-source-line` in dev so the agent doesn't have to grep. Targets >95%
  source-mapping accuracy.
- **Phase 7 — Polish.** Drag-to-reorder annotations, group by file in the
  side panel, undo last edit (rolls back via git), plan-then-execute
  toggle. (Per-project `.pinta.json` shipped alongside multi-project
  mode and is already wired up.)
- **Beyond.** Conflict detection, multi-tab sessions, read-only sharing.
  See [`spec/SPEC.md` §9](spec/SPEC.md#9-open-questions) for the open
  design questions.

---

## Contributing

Issues and PRs welcome. Before opening a PR:

1. Read [`spec/SPEC.md`](spec/SPEC.md) — the design's load-bearing pieces
   are documented there.
2. Run `npm run build` and `bash scripts/post-fake-session.sh` to confirm
   the end-to-end loop still works.
3. Keep the boundaries clean. Agent-specific code lives under
   `adapters/` or `skill/`, not in `companion/` or `extension/`.

---

## Creator

**Mark Kevin Baldemor** ([@kevzlou7979](https://github.com/kevzlou7979)) — designed
and built Pinta because the gap between "I can see what's wrong on this page"
and "the agent edits the right file" was bigger than it had to be.

If Pinta saved you time, the cheapest thank-you is a ⭐ on the
[GitHub repo](https://github.com/kevzlou7979/pinta). Issues and PRs welcome
too — see [Contributing](#contributing) above.

---

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Mark Kevin Baldemor.
