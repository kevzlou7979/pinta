---
name: pinta
description: Use when the user wants to visually annotate their running app to make UI changes. Picks up annotation sessions submitted from the Pinta Chrome extension and edits the matching component files in the user's project. Accepts an optional `--push` (default) or `--polling` argument controlling how the agent waits for sessions.
---

# Pinta

Workflow: the user opens the Pinta Chrome extension, draws / picks elements
on their running app, and clicks Submit. The companion server (running on
`localhost:7878`) receives the session. Your job is to wait for sessions,
then edit the matching source files.

## Arguments

`/pinta` accepts an optional flag controlling delivery mode:

| Flag | Behavior | When to use |
|---|---|---|
| `--push` *(default)* | Open one long-lived SSE stream via Monitor. Each new submission arrives as a single notification — no polling noise in the transcript. | Default. Best for Claude Code (which has Monitor). |
| `--polling` | Long-poll loop with `curl --max-time 30`. Each cycle is one Bash call. Generates more transcript lines but works with any shell-only agent. | Reference / fallback. Use when Monitor isn't available, or when debugging the protocol. |

If the user passes neither flag, default to `--push`.

## 1. Verify the companion is running

```bash
curl -sf http://127.0.0.1:7878/v1/health || echo "DOWN"
```

If empty / "DOWN", tell the user to start it in their project root:

```bash
npx pinta-companion .
```

(falls back to `node ~/.claude/skills/pinta/start-companion.js .` or
`npm run dev:companion -- --project .` if they've cloned the repo). Wait
for the user to confirm before continuing.

## 2. Tell the user you're ready

> "Companion is up. Open the Pinta Chrome extension, annotate the page you
> want changed, and hit Submit. I'll wait."

## 3. Wait for sessions

### Default — `--push` (stream)

Open a Monitor on the SSE stream. Each `data:` line is one new session
notification:

```bash
curl -sN http://127.0.0.1:7878/v1/sessions/stream \
  | grep --line-buffered '^data:' \
  | sed -u 's/^data: //'
```

- One Monitor call covers many sessions for the entire working session.
- **Backlog**: sessions already in `submitted` state are pushed immediately
  on connect — reconnecting after the user submitted earlier isn't lossy.
- 20s SSE keepalive comments are filtered out by the grep above.
- When the user says "stop" / "exit" / "done", call **TaskStop** on the
  Monitor and exit.

### Fallback — `--polling`

```bash
curl -sf --max-time 30 http://127.0.0.1:7878/v1/sessions/poll
```

Returns 200 + JSON when a session arrives, 204 on timeout. Re-poll
indefinitely (see §9 — loop after each session, never stop on your own).

### Session payload (same in both modes)

```json
{
  "id": "uuid",
  "url": "http://localhost:5173/...",
  "projectRoot": "/abs/path",
  "annotations": [...],
  "fullPageScreenshotPath": ".pinta/sessions/{id}.png",
  "status": "submitted"
}
```

The screenshot is on disk at `{projectRoot}/{fullPageScreenshotPath}` —
read it with the Read tool (it's a PNG; the visual UI will display it).

## 4. Locate source files for each annotation

Each annotation is one of two shapes:

**Element selection (`kind: "select"`)** — `target` is set:
- `target.sourceFile` — if present (Vite plugin installed), open it directly.
- Otherwise grep the project for `target.nearbyText[0]` (most specific text),
  narrow with `target.nearbyText[1..]` if too generic.
- `target.outerHTML` and `target.computedStyles` are useful evidence when
  multiple files match.

**Drawing (`kind` is `arrow` / `rect` / `circle` / `freehand` / `pin`)** —
no DOM target. The `comment` describes intent; the screenshot shows what
the drawing points at. Identify the area visually from the screenshot, then
grep the codebase for nearby text you can read off the screenshot.

## 5. Build a unified plan

Group edits by file. For each annotation, state:
- which file you'll edit
- a one-line summary of the change
- which annotation it satisfies (`comment` quote)

Show the plan to the user. Wait for explicit confirmation ("go", "yes",
"apply") before editing anything.

## 6. Mark the session as applying

```bash
curl -sf -X POST http://127.0.0.1:7878/v1/sessions/{id}/status \
  -H "Content-Type: application/json" \
  -d '{"status":"applying"}'
```

## 7. Apply edits — one annotation at a time, with per-card status

For **each** annotation, in order:

1. Mark in-progress (side panel card spins):

   ```bash
   curl -sf -X POST http://127.0.0.1:7878/v1/sessions/{id}/annotations/{annId}/status \
     -H "Content-Type: application/json" \
     -d '{"status":"applying"}'
   ```

2. Apply the Edit tool changes for that annotation.

3. Mark done (card flips to ✓):

   ```bash
   curl -sf -X POST http://127.0.0.1:7878/v1/sessions/{id}/annotations/{annId}/status \
     -H "Content-Type: application/json" \
     -d '{"status":"done"}'
   ```

   Or, if you couldn't apply it:

   ```bash
   curl -sf -X POST http://127.0.0.1:7878/v1/sessions/{id}/annotations/{annId}/status \
     -H "Content-Type: application/json" \
     -d '{"status":"error","errorMessage":"<reason>"}'
   ```

When every annotation is `done` or `error`, the companion auto-rolls the
session status (so step 8 below is optional unless you want a final summary).

After all annotations: run the project's lint / test / typecheck commands
(read package.json scripts; `npm run check`, `npm test`, etc.).

## 8. (Optional) Final session summary

```bash
curl -sf -X POST http://127.0.0.1:7878/v1/sessions/{id}/status \
  -H "Content-Type: application/json" \
  -d '{"status":"done","summary":"Tonalized SubmitButton, removed expiry icon, padded ClaimSummaryCard."}'
```

For total failure (could not start at all):

```bash
curl -sf -X POST http://127.0.0.1:7878/v1/sessions/{id}/status \
  -H "Content-Type: application/json" \
  -d '{"status":"error","errorMessage":"..."}'
```

## 9. Stay live for the next submission

**`--push`**: nothing to do — the Monitor keeps streaming. Just go back to
waiting for the next notification.

**`--polling`**: immediately re-enter `/v1/sessions/poll` for the next
session. Loop indefinitely. Don't stop on your own — the queue holds the
next submission only as long as someone is calling poll.

In both modes, only stop when:
- The user explicitly says "stop" / "exit" / "done".
- The companion goes down (`/v1/health` fails repeatedly) — surface and ask.

## Notes

- Source-mapping accuracy is ~80% with grep alone; ~95%+ with
  `vite-plugin-pinta` installed in the user's project (Phase 6).
- Always present the plan before editing — grep can pick the wrong file.
- Multiple annotations may target the same file. Make all edits in one Edit
  pass per file when possible.
- The HMR refresh in the browser is the user's verification step. If they
  spot a regression, expect a follow-up session.
