---
name: pinta
description: Use when the user wants to visually annotate their running app to make UI changes. Picks up annotation sessions submitted from the Pinta Chrome extension and edits the corresponding component files.
---

# Pinta

When invoked:

1. **Verify the companion is running.** Hit `GET http://127.0.0.1:7878/v1/health`.
   - If it responds: continue.
   - If not: tell the user to start the companion in their project root with
     `npm run dev:companion -- --project .` (from the pinta repo) or
     `node ~/.claude/skills/pinta/start-companion.js {project_root}` if the
     installer set that up.
2. **Tell the user**: "Companion is running. Open the Pinta Chrome extension,
   draw your annotations, and hit Submit. I'll wait."
3. **Long-poll** `GET /v1/sessions/poll` (returns 200 + Session JSON when one is
   ready, 204 on timeout — re-poll). Keep going until a session arrives.
4. **For each annotation in the session:**
   - If `target.sourceFile` is set, open that file directly.
   - Otherwise, grep the codebase for `target.nearbyText[0]` (and successive entries
     if the first is too generic) to locate the component.
5. **Build a unified plan**, grouped by file. Show the user which files you intend
   to edit and what each annotation maps to.
6. **POST status updates** as you work:
   - `POST /v1/sessions/{id}/status` body `{"status": "applying"}` when you start.
   - `{"status": "done", "summary": "..."}` when finished.
   - `{"status": "error", "errorMessage": "..."}` on failure.
7. **Wait for user confirmation** before applying edits.
8. **Apply edits**, then run any project-defined test/lint commands.

## Notes

- The screenshot (`fullPageScreenshot`, base64 PNG) is on the session payload — view
  it with the Read tool by writing it to a temp file first if needed.
- Annotations carry `comment` (intent), `target.outerHTML` (truncated source HTML),
  `target.computedStyles` (color, spacing, typography), and `viewport` info.
- Source mapping accuracy is highest with `vite-plugin-pinta` installed in the
  user's project. Without it, grep-based mapping is best-effort — always present the
  plan before editing.
