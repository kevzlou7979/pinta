<p align="center">
  <img src="docs/assets/icons/icon-256.png" alt="Pinta" width="128" height="128" />
</p>

<h1 align="center">Pinta</h1>

<p align="center"><strong>Annotate your running web app. Let an AI agent do the edits.</strong></p>

Circle a button. Point at a heading. Type *"make this tonal"*. Pinta
captures the annotation, snapshots the page, and hands it to your coding
agent — Claude Code, Cursor, or any MCP-compatible tool — which edits the
matching source files for you.

> **Status: V1.** End-to-end pipeline is shipped: Chrome extension,
> companion server, full-page screenshot composite, Claude Code reference
> adapter, and MCP server for Cursor / Cline / Continue / Zed. See
> [`spec/SPEC.md`](spec/SPEC.md) for the design and
> [Roadmap](#roadmap) for what's next.

---

## What V1 includes

| Capability | Status |
|---|---|
| Chrome MV3 extension (Svelte 5, side panel + popup) | shipped |
| Element selection overlay (Shadow-DOM isolated) | shipped |
| Drawing canvas — arrow / rect / circle / freehand / pin | shipped |
| Full-page screenshot with annotations composited in | shipped |
| Companion server: HTTP + WebSocket + JSON session store | shipped |
| Claude Code adapter (skill + installer) | shipped |
| MCP server for Cursor / Cline / Continue / Zed / Windsurf | shipped |
| Aider adapter (poll script) | shipped |
| `vite-plugin-pinta` for instant source mapping | planned (Phase 6) |
| Polish — drag reorder, group by file, undo via git | planned (Phase 7) |

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

**Prerequisites:** Node 20+, Chrome (or Chromium-based browser), and a
coding agent — Claude Code is the reference; Cursor / Cline / Continue / Zed
work via MCP.

**One-shot setup (recommended)** — clone the repo, open Claude Code in
the repo dir, and run:

```
/build-pinta
```

The project-scoped `build-pinta` skill installs deps, builds the extension
and companion in parallel, installs the `/pinta` skill into
`~/.claude/skills/pinta/`, and prints the path to load into Chrome.

**Manual setup** if you'd rather drive it yourself:

```bash
# 1. Clone + install
git clone https://github.com/kevzlou7979/pinta.git
cd pinta
npm install

# 2. Build the extension and the companion
npm run build --workspace @pinta/extension
npm run build --workspace @pinta/companion

# 3. Install the Claude Code skill (optional but recommended)
bash scripts/install-skill.sh

# 4. Load the extension in Chrome
#    chrome://extensions → Developer Mode → Load unpacked → pick ./extension/dist
```

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

The companion listens on `http://127.0.0.1:7878` and writes sessions to
`{project}/.pinta/sessions/{id}.json` (with the screenshot alongside as
`{id}.png`).

### 2. Open your app in Chrome and the Pinta side panel

Toolbar icon → side panel. The side panel will say **Connected** when it
finds the companion.

### 3. Annotate

- Press **`S`** on the page to enter **Select** mode — hover an element,
  click to lock it, type a comment, hit **Add**.
- Press **`D`** to enter **Draw** mode — pick a tool (arrow / rect / circle
  / pen / pin), drag on the page, comment, **Add**.
- Annotations appear as cards in the side panel. Edit, delete, reorder.

### 4. Submit

The extension snaps a full-page screenshot, composites the annotations onto
it, and posts the session.

### 5. Hand off to your agent

**Claude Code:** in Claude Code, type `/pinta`. The skill long-polls the
companion, picks up your session, presents an edit plan grouped by file,
and waits for your confirmation before editing.

**Cursor / Cline / Continue / Zed:** see
[`adapters/cursor/README.md`](adapters/cursor/README.md) for the MCP
config. Then prompt: *"Pick up the pending Pinta session and apply the
changes — show me the plan first."*

**Aider:** see [`adapters/aider/pinta-poll.sh`](adapters/aider/pinta-poll.sh).

**Anything else:** speak the HTTP API (`/v1/sessions/poll`,
`/v1/sessions/:id/status`) — that's the universal lowest-common-denominator.

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
| `S` | Toggle Select mode |
| `D` | Toggle Draw mode |
| `R` | Idle / review |
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
  side panel, undo last edit (rolls back via git), per-project
  `.pinta.json` for design system context, plan-then-execute toggle.
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

## License

MIT — see [`LICENSE`](LICENSE) (TBD).
