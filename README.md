# Pinta

Visual annotation tool that hands UI changes to a coding agent.

Annotate your running web app in the browser — circle a button, point at a
heading, type *"make this tonal"* — and an AI agent (Claude Code, Cursor,
Aider) edits the matching source files.

> Status: under active development. Phases 0–4 are complete. See
> [`spec/SPEC.md`](spec/SPEC.md) for the full design.

---

## Quickstart

Prerequisites: Node 20+, Chrome, an agent (Claude Code is the reference).

```bash
# 1. Clone + install
git clone https://github.com/kevzlou7979/pinta.git
cd pinta
npm install

# 2. Build the Chrome extension
npm run build --workspace @pinta/extension

# 3. Install the Claude Code skill
bash scripts/install-skill.sh

# 4. Load the extension in Chrome
#    chrome://extensions → Developer Mode → Load unpacked
#    → pick ./extension/dist
```

## Daily usage

1. **Start the companion** in your project root (the project you want to edit):

   ```bash
   node ~/.claude/skills/pinta/start-companion.js .
   ```

   It listens on `http://127.0.0.1:7878`.

2. **Open your app** in Chrome (e.g. `http://localhost:5173`).

3. **Open the Pinta side panel** (toolbar icon → side panel).

4. **Annotate**:
   - Pick a tool (Select / Arrow / Rect / Circle / Pen / Pin) or press
     `S` (select) / `D` (draw) on the page.
   - Hover + click an element, or drag to draw.
   - Type a comment in the inline popup → Add.

5. **Submit**. The extension takes a full-page screenshot, composites your
   annotations onto it, and posts the session to the companion.

6. **In Claude Code**, run `/pinta`. The skill long-polls, picks up the
   session, presents an edit plan grouped by file, and waits for your
   confirmation before editing.

## Architecture

```
Chrome Extension ─WS─ Companion ─HTTP/MCP─ Coding Agent ─edits─ Project files
```

- **`extension/`** — Svelte 5 + CRXJS Chrome MV3 extension (side panel,
  popup, content-script overlay with shadow-DOM-isolated drawing canvas).
- **`companion/`** — Node 20+ HTTP + WebSocket server. JSON session
  persistence in `{project}/.pinta/sessions/{id}.json`; full-page PNG
  alongside as `{id}.png`.
- **`skill/pinta/`** — Claude Code reference adapter (markdown skill +
  `start-companion.js`).
- **`shared/`** — TypeScript types (Annotation, Session, WS protocol).

Other agents (Cursor / Aider / MCP-compatible) plug into the same companion
HTTP API and (Phase 5b) MCP server — no changes to extension or companion
required.

## Hotkeys

| Key | Action |
|---|---|
| `S` | Toggle select mode |
| `D` | Toggle draw mode |
| `R` | Idle / review |
| `Esc` | Cancel in-progress / pending / mode (in that order) |

## Project layout

```
pinta/
├── spec/SPEC.md              full design spec
├── shared/                   @pinta/shared — types
├── companion/                @pinta/companion — Node server
├── extension/                @pinta/extension — Chrome MV3 (Svelte 5)
├── skill/pinta/              Claude Code reference adapter
└── scripts/                  install + smoke-test scripts
```

## Development

```bash
npm install                                    # install all workspaces
npm run dev:companion -- --project /some/app   # run companion against a target project
npm run dev --workspace @pinta/extension       # vite dev for extension HMR
npm run build --workspace @pinta/extension     # production build
bash scripts/post-fake-session.sh              # smoke-test the loop without a browser
```

License: TBD.
