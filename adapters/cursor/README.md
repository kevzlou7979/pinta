# Pinta — Cursor adapter

Wires Pinta into Cursor (or any MCP-compatible agent: Cline, Continue, Zed,
Windsurf) via the `pinta-mcp` stdio server. The MCP server is a thin proxy
to the running companion's HTTP API, so the Chrome extension and the agent
share one source of truth.

## Setup

1. **Install Pinta** (see top-level [README.md](../../README.md)).

2. **Start the companion in your project root** (one per project,
   long-running):

   ```bash
   node ~/.claude/skills/pinta/start-companion.js .
   # or, from the pinta repo:
   npm run dev:companion -- --project .
   ```

3. **Add the MCP server to Cursor**. Edit `~/.cursor/mcp.json` (create if
   missing):

   ```json
   {
     "mcpServers": {
       "pinta": {
         "command": "npx",
         "args": ["-y", "pinta-companion", "pinta-mcp"]
       }
     }
   }
   ```

   `pinta-mcp` ships in the same `pinta-companion` npm package as a second
   bin. No clone, no build.

   For development against TypeScript sources (after cloning the repo):

   ```json
   {
     "mcpServers": {
       "pinta": {
         "command": "npx",
         "args": [
           "tsx",
           "/absolute/path/to/pinta/companion/src/mcp-stdio.ts"
         ]
       }
     }
   }
   ```

   Optional environment override:

   ```json
   "env": { "PINTA_COMPANION_URL": "http://127.0.0.1:7878" }
   ```

4. **Restart Cursor.** Pinta's tools should appear under the MCP indicator.

## Usage

Open the Pinta Chrome extension, draw / pick elements on your running app,
hit Submit. Then in Cursor, prompt:

> Pick up the pending Pinta session and apply the changes. Show me the plan
> before editing.

Cursor will use:

- `get_pending_session` — long-poll for the submission (25s timeout, retry).
- `get_screenshot` — fetch the composited PNG with annotations baked in.
- `mark_session_applying` — flag the side panel that work has started.
- Edits to your source files.
- `mark_session_done` — close the session with a one-line summary.

## Available tools

| Tool | Purpose |
|---|---|
| `get_pending_session` | Long-poll for the next submitted session |
| `get_session(id)` | Re-fetch a session by id |
| `mark_session_applying(id)` | Tell the side panel work started |
| `mark_session_done(id, summary)` | Close session with a summary |
| `mark_session_error(id, errorMessage)` | Surface a failure to the side panel |
| `get_screenshot(id)` | Inline base64 PNG of the composited screenshot |

## Troubleshooting

- **"companion at … is not responding"** in stderr → the companion isn't
  running. Start it in the target project root.
- **Tools don't appear in Cursor** → check the MCP indicator for errors.
  Most common: bad path in `args[0]` (must be an *absolute* path), or the
  companion was built but `dist/mcp-stdio.js` is missing — run
  `npm run build --workspace @pinta/companion`.
- **Wrong file gets edited** → `vite-plugin-pinta` (Phase 6) wires
  `data-source-file` / `data-source-line` into your dev DOM, eliminating the
  guess. Until then, always have the agent show its plan before editing.
