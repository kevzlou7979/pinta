---
name: pinta
description: Use when the user wants to visually annotate their running app to make UI changes. Picks up annotation sessions submitted from the Pinta Chrome extension and edits the matching component files in the user's project.
---

# Pinta

Workflow: the user opens the Pinta Chrome extension, draws / picks elements
on their running app, and clicks Submit. The companion server (running on
`localhost:7878`) receives the session. Your job is to long-poll for it and
edit the matching source files.

## 1. Verify the companion is running

Check health:

```bash
curl -sf http://127.0.0.1:7878/v1/health || echo "DOWN"
```

If the response is empty / "DOWN", tell the user to start it in another
terminal in their project root:

```bash
npx pinta-companion .
```

(falls back to `node ~/.claude/skills/pinta/start-companion.js .` or
`npm run dev:companion -- --project .` if they've cloned the repo). Wait
for the user to confirm before continuing.

## 2. Tell the user you're ready

> "Companion is up. Open the Pinta Chrome extension, annotate the page you
> want changed, and hit Submit. I'll wait."

## 3. Long-poll for a submitted session

```bash
curl -sf --max-time 30 http://127.0.0.1:7878/v1/sessions/poll
```

Returns 200 + JSON when a session arrives, 204 on timeout. Re-poll up to a
few times (loop). The JSON has shape:

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
- Otherwise grep the project for `target.nearbyText[0]` (the most specific
  text), narrow with `target.nearbyText[1..]` if it's too generic.
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

1. Mark it as in-progress so the side-panel card shows a spinner:

   ```bash
   curl -sf -X POST http://127.0.0.1:7878/v1/sessions/{id}/annotations/{annId}/status \
     -H "Content-Type: application/json" \
     -d '{"status":"applying"}'
   ```

2. Apply the Edit tool changes for that annotation.

3. Mark it done (card flips to ✓):

   ```bash
   curl -sf -X POST http://127.0.0.1:7878/v1/sessions/{id}/annotations/{annId}/status \
     -H "Content-Type: application/json" \
     -d '{"status":"done"}'
   ```

   Or, if you couldn't apply it (file not found, ambiguous match the
   user should resolve, etc.):

   ```bash
   curl -sf -X POST http://127.0.0.1:7878/v1/sessions/{id}/annotations/{annId}/status \
     -H "Content-Type: application/json" \
     -d '{"status":"error","errorMessage":"<reason>"}'
   ```

When every annotation is `done` or `error`, the companion auto-rolls the
session status (so step 8 below is optional unless you want to attach a
final summary or skip per-annotation tracking entirely).

After all annotations: run the project's lint / test / typecheck commands
(read package.json scripts; `npm run check`, `npm test`, etc.).

## 8. (Optional) Mark the session done with a summary

If you want to attach a one-line summary the side panel surfaces below
the "Done" button:

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

The Chrome extension surfaces all status changes in real time via WebSocket.

## 9. Immediately re-enter the poll loop

This is important — **do not stop polling after one session.** The Pinta
extension queues sessions one at a time as the user submits them, and the
companion only hands a session out when an agent calls `/v1/sessions/poll`.
If you stop polling, the next submission waits in the queue forever (the
user has to run `/pinta` again to wake you up).

After step 8 (or step 7 if you skipped the optional summary), go straight
back to step 3 and call `/v1/sessions/poll` again. Loop indefinitely:

- 204 means "no session yet" — re-poll. The companion long-polls 25s per
  call so this is cheap.
- 200 means a new session — process it (steps 4–8), then loop again.

The user can interrupt the loop at any time. Only stop polling if:
- The user explicitly tells you to stop ("done", "stop", "exit").
- The companion goes down (`/v1/health` fails several times in a row) —
  surface that and ask the user.

Default behavior: stay in the poll loop until told otherwise.

## Notes

- Source-mapping accuracy is ~80% with grep alone; ~95+% with
  `vite-plugin-pinta` installed in the user's project (Phase 6).
- Always present the plan before editing — grep can pick the wrong file.
- Multiple annotations may target the same file. Make all edits in one Edit
  pass per file when possible.
- The HMR refresh in the browser is the user's verification step. If they
  spot a regression, expect a follow-up session.
