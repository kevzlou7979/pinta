---
name: pinta
description: Use when the user wants to visually annotate their running app to make UI changes. Picks up annotation sessions submitted from the Pinta Chrome extension and edits the matching component files in the user's project. Accepts an optional `--push` (default) or `--polling` argument controlling how the agent waits for sessions.
---

# Pinta

Workflow: the user opens the Pinta Chrome extension, draws / picks elements
on their running app, and clicks Submit. The companion server (one process
per project, discovered via `~/.pinta/registry.json`) receives the session.
Your job is to wait for sessions, then edit the matching source files.

## Arguments

`/pinta` accepts an optional flag controlling delivery mode:

| Flag | Behavior | When to use |
|---|---|---|
| `--push` *(default)* | Open one long-lived SSE stream via Monitor. Each new submission arrives as a single notification — no polling noise in the transcript. | Default. Best for Claude Code (which has Monitor). |
| `--polling` | Long-poll loop with `curl --max-time 30`. Each cycle is one Bash call. Generates more transcript lines but works with any shell-only agent. | Reference / fallback. Use when Monitor isn't available, or when debugging the protocol. |

If the user passes neither flag, default to `--push`.

## 1. Discover the companion for this project

Multiple Pinta companions can run at once — one per project. Each
companion registers itself in `~/.pinta/registry.json` on startup. The
helper below reads that registry and prints the port for the companion
whose `projectRoot` matches your cwd.

```bash
DISCOVERY=$(node ~/.claude/skills/pinta/find-companion.js)
DISCOVERY_EXIT=$?
PORT=$(printf '%s' "$DISCOVERY" | cut -f1)
BASE="http://127.0.0.1:$PORT"
```

Possible exit codes:

| Code | Meaning | What to do |
|---|---|---|
| `0` | Found — `$PORT` is set | Continue to step 2 |
| `2` | Other companions running, none for this cwd | Tell user: **"A companion is running, but not for this project. Start one in this project root: `node ~/.claude/skills/pinta/start-companion.js .` (preferred while on the unreleased build) or `npx pinta-companion .` (once a new npm version ships)"** Wait for confirmation before retrying. |
| `3` | No registry / no companions running | Tell user: **"No Pinta companion is running. Start one in this project root: `node ~/.claude/skills/pinta/start-companion.js .` (preferred while on the unreleased build) or `npx pinta-companion .` (once a new npm version ships)"** Wait for confirmation before retrying. |

After the user confirms they've started the companion, re-run the
discovery snippet — the registry only updates on companion startup.

> **Verify** with `curl -sf "$BASE/v1/health"` once `$PORT` is set —
> the response includes `projectRoot` so you can sanity-check you're
> talking to the right one.

## 2. Tell the user you're ready

> "Companion is up on port `$PORT` for `<projectRoot>`. Open the Pinta
> Chrome extension, annotate the page you want changed, and hit Submit.
> I'll wait."

## 3. Wait for sessions

### Default — `--push` (stream)

Open a Monitor on the SSE stream. Each `data:` line is one new session
notification:

```bash
curl -sN "$BASE/v1/sessions/stream" \
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
curl -sf --max-time 30 "$BASE/v1/sessions/poll"
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

> **Sanity-check** the session's `projectRoot` matches your cwd. Multi-
> project mode discovery should make this reliable, but if a stale
> registry entry leaked through, refuse to edit and tell the user.

## 4. Locate source files for each annotation

Each annotation is one of two shapes:

**Element selection (`kind: "select"`)** — `target` is set:
- `target.sourceFile` — if present (Vite plugin installed), open it directly.
- Otherwise grep the project for `target.nearbyText[0]` (most specific text),
  narrow with `target.nearbyText[1..]` if too generic.
- `target.outerHTML` and `target.computedStyles` are useful evidence when
  multiple files match.
- **`customCss`** — if set, the user typed raw CSS in the inline editor's
  CSS tab. Apply it as additions to the matching source rule. See §7.5
  below for framework heuristics.

**Drawing (`kind` is `arrow` / `rect` / `circle` / `freehand` / `pin`)** —
no DOM target. The `comment` describes intent; the screenshot shows what
the drawing points at. Identify the area visually from the screenshot, then
grep the codebase for nearby text you can read off the screenshot.

## 5. Build a unified plan

Group edits by file. For each annotation, state:
- which file you'll edit
- a one-line summary of the change
- which annotation it satisfies (`comment` quote)

Show the plan to the user.

**If `session.autoApply` is true** (user toggled "Auto-apply" in the
side panel), proceed straight to step 6 without waiting — this is opt-in
fast-iteration mode. Still show the plan first so they see what's
happening, but don't ask "reply go to apply."

**Otherwise (default)**: wait for explicit confirmation ("go", "yes",
"apply") before editing anything.

## 6. Mark the session as applying

```bash
curl -sf -X POST "$BASE/v1/sessions/{id}/status" \
  -H "Content-Type: application/json" \
  -d '{"status":"applying"}'
```

## 7.4 Annotation reference images

A `select` annotation may carry an `images: AnnotationImage[]` field —
the user pasted or drag-dropped reference screenshots into the
annotation popover (e.g. "make this look like [image1]"). The comment
text typically uses `[image1]`, `[image2]` placeholders to reference
them.

Each image carries either:

- `dataUrl` — inline base64 PNG/JPEG, OR
- `path` — relative to `projectRoot` (companion may extract large
  attachments to disk in a future version)

When you build the plan, **read each referenced image** for visual
context before deciding how to apply the edit. With the Read tool:

```bash
# If dataUrl is inline, write it to a temp PNG first:
echo "<base64>" | base64 -d > /tmp/pinta-image1.png
# Then Read /tmp/pinta-image1.png — Claude will see it as vision input.

# If `path` is set, just Read $projectRoot/$path directly.
```

Mention each referenced image in the plan ("matching the dropdown
styling shown in [image1]"). The user is using them as ground truth —
respect the visual.

## 7.5 Applying inline-editor changes (Phase 8a)

The inline editor produces up to three structured payloads on a `select`
annotation. Apply each as faithfully as possible:

| Field | What it is | What to do |
|---|---|---|
| `cssChanges` | `{property: value}` from the Font / Sizing / Spacing pickers | Apply each property change |
| `customCss` | Raw CSS the user typed in the CSS tab | Apply as-is |
| `contentChange` | `{textBefore, textAfter}` from the Content tab | Replace the matching text in the source |

**Don't hardcode framework choices.** Detect what the project actually
uses, then apply the changes in the most natural way for that codebase:

- Look at `package.json` dependencies (`tailwindcss`, `styled-components`,
  `@emotion/styled`, `vanilla-extract`, `@stitches/react`, `panda-css`,
  `@material-ui/styles`, framework presence, etc.).
- Look at the source file you're editing — its imports, existing class /
  className patterns, neighboring styles. The same project can mix
  approaches; match what's already there in *that* file.

Some general guides (not exhaustive — adapt):
- Utility-class systems (Tailwind, UnoCSS, Panda): translate properties
  to the closest utilities and add to the element's `class=` /
  `className=`. If a property has no clean utility, fall through to one
  of the other strategies for *that* property only.
- Tagged template / runtime CSS-in-JS (styled-components, Emotion,
  Stitches): append to the matching styled rule.
- Compile-time CSS-in-JS (vanilla-extract, Compiled, Linaria): edit the
  matching style object / template literal.
- Plain CSS / SCSS / Modules: find the rule for `target.selector` (or
  the closest ancestor selector that already exists), append /
  override.
- Inline `style=` attribute: only as a last resort, or when the user
  framed the change as a one-off.

For **`contentChange`**: locate `textBefore` in the source as a string
literal and replace with `textAfter`. Preserve surrounding markup. If
the text appears in multiple places, use surrounding component context
(parent selectors, nearby props) to disambiguate.

**Always present the planned application** before editing — say which
strategy you picked and why, the file(s) you'll touch, and the final
form of the change. Wait for explicit "go" before editing.

## 7. Apply edits — one annotation at a time, with per-card status

For **each** annotation, in order:

1. Mark in-progress (side panel card spins):

   ```bash
   curl -sf -X POST "$BASE/v1/sessions/{id}/annotations/{annId}/status" \
     -H "Content-Type: application/json" \
     -d '{"status":"applying"}'
   ```

2. Apply the Edit tool changes for that annotation.

3. Mark done (card flips to ✓):

   ```bash
   curl -sf -X POST "$BASE/v1/sessions/{id}/annotations/{annId}/status" \
     -H "Content-Type: application/json" \
     -d '{"status":"done"}'
   ```

   Or, if you couldn't apply it:

   ```bash
   curl -sf -X POST "$BASE/v1/sessions/{id}/annotations/{annId}/status" \
     -H "Content-Type: application/json" \
     -d '{"status":"error","errorMessage":"<reason>"}'
   ```

When every annotation is `done` or `error`, the companion auto-rolls the
session status (so step 8 below is optional unless you want a final summary).

After all annotations: run the project's lint / test / typecheck commands
(read package.json scripts; `npm run check`, `npm test`, etc.).

## 8. (Optional) Final session summary

```bash
curl -sf -X POST "$BASE/v1/sessions/{id}/status" \
  -H "Content-Type: application/json" \
  -d '{"status":"done","summary":"Tonalized SubmitButton, removed expiry icon, padded ClaimSummaryCard."}'
```

For total failure (could not start at all):

```bash
curl -sf -X POST "$BASE/v1/sessions/{id}/status" \
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
- Multi-project: every companion picks the next free port (7878, 7879, …).
  Skill discovery uses `~/.pinta/registry.json`, so always rebuild `$BASE`
  if you suspect drift (e.g. user restarted the companion mid-session).
