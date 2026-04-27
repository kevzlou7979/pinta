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

## 7. Apply edits

Use the Edit tool, one annotation at a time. Run the project's lint / test /
typecheck commands afterward (read package.json scripts; `npm run check`,
`npm test`, etc.).

## 8. Mark the session done (or error)

On success:

```bash
curl -sf -X POST http://127.0.0.1:7878/v1/sessions/{id}/status \
  -H "Content-Type: application/json" \
  -d '{"status":"done","summary":"Tonalized SubmitButton, removed expiry icon, padded ClaimSummaryCard."}'
```

On failure:

```bash
curl -sf -X POST http://127.0.0.1:7878/v1/sessions/{id}/status \
  -H "Content-Type: application/json" \
  -d '{"status":"error","errorMessage":"..."}'
```

The Chrome extension surfaces this status in the side panel.

## Notes

- Source-mapping accuracy is ~80% with grep alone; ~95+% with
  `vite-plugin-pinta` installed in the user's project (Phase 6).
- Always present the plan before editing — grep can pick the wrong file.
- Multiple annotations may target the same file. Make all edits in one Edit
  pass per file when possible.
- The HMR refresh in the browser is the user's verification step. If they
  spot a regression, expect a follow-up session.
