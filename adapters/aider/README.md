# Pinta — Aider adapter

Aider doesn't speak MCP, so this adapter is a tiny shell script that polls
the companion's HTTP API and prints a primer (with the session JSON) you can
paste into aider's chat.

## Setup

1. Install Pinta + start the companion (see top-level
   [README.md](../../README.md)).
2. Have aider running in your project root.

## Usage

```bash
bash adapters/aider/pinta-poll.sh
# or, in another terminal, watch indefinitely:
bash adapters/aider/pinta-poll.sh --watch
```

When a session arrives, the script prints:

- A primer telling aider what to do (apply annotations, group by file,
  POST status when done).
- The full session JSON (annotations, comments, optional `target.sourceFile`,
  `fullPageScreenshotPath`).

Copy that block into aider's chat and let it work. Aider will edit the
files; you'll need to mark the session done manually:

```bash
curl -sf -X POST http://127.0.0.1:7878/v1/sessions/<id>/status \
  -H "Content-Type: application/json" \
  -d '{"status":"done","summary":"..."}'
```

(or just leave it — the side panel will keep showing "Submitted" until then,
which is harmless.)

## Notes

- For richer integration with Aider's `--load` / `--message-file` flags,
  pipe the script output into a file and start aider with `aider --load
  pinta-session.txt`.
- The companion stores the composited screenshot at
  `.pinta/sessions/{id}.png` — aider can read it via its multimodal mode.
