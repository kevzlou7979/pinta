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
  "status": "submitted",
  "modules": [{ "id": "gitlab-issues", "settings": { ... } }]
}
```

> **`modules` (optional).** When the user opts into a built-in
> integration on this submit (currently: GitLab Issues), the array
> rides along on the session. **You MUST run §7.9 after §7** when this
> field is present — skipping it means the user's request to file
> issues / post messages / etc. silently fails. Treat `session.modules`
> as a hard checkpoint, not a footnote.

The screenshot is on disk at `{projectRoot}/{fullPageScreenshotPath}` —
read it with the Read tool (it's a PNG; the visual UI will display it).

> **Multi-page sessions.** Each `annotation` may carry its own `url`
> (set by the extension when the user is reviewing a flow that spans
> multiple routes). Treat `annotation.url ?? session.url` as the
> per-annotation page anchor — use it when grepping for the right
> source file (route-scoped first, project-wide fallback) and when any
> module needs to record the page an annotation belongs to (e.g. the
> GitLab Issues module's per-issue body). The session-level `url` is
> the page the session was first opened on; do not assume it covers
> every annotation.

> **Sanity-check** the session's `projectRoot` matches your cwd. Multi-
> project mode discovery should make this reliable, but if a stale
> registry entry leaked through, refuse to edit and tell the user.

## 3.5 Claim the session — first-wins, prevents race conditions

When multiple Claude Code terminals are open on the same project (e.g.
inside Claude Dock), all of them receive every push. To stop them from
racing on the same submission, **claim it first**. Only the agent that
successfully claims should process the session — the others silently
skip and go back to streaming.

```bash
# Generate a stable claimer id once per /pinta run. The cwd makes it
# debuggable on the companion's logs; the random suffix disambiguates
# multiple terminals in the same cwd.
CLAIMER_ID="${CLAIMER_ID:-$(printf '%s/%s' "$PWD" "$(node -e 'console.log(crypto.randomUUID())')")}"

CLAIM_RESPONSE=$(curl -sf -w "\n%{http_code}" -X POST "$BASE/v1/sessions/$SESSION_ID/claim" \
  -H "Content-Type: application/json" \
  -d "{\"claimerId\":\"$CLAIMER_ID\"}")
CLAIM_HTTP=$(printf '%s' "$CLAIM_RESPONSE" | tail -n1)

if [ "$CLAIM_HTTP" = "409" ]; then
  # Another agent already owns this session. Don't show the user
  # anything — silently skip back to the SSE stream / poll loop.
  continue   # or `return` / next-iter, depending on your loop shape
fi

if [ "$CLAIM_HTTP" != "200" ]; then
  # Network or session-not-found error — surface it.
  echo "claim failed: $CLAIM_RESPONSE" >&2
fi
```

The 200 response body is the full session (with `claimedBy` and
`claimedAt` set). Keep going — proceed to the plan.

## 4. Locate source files for each annotation

Each annotation is one of three shapes:

> **Per-annotation URL.** If `annotation.url` is set and differs from
> `session.url`, the user captured this annotation on a *different*
> route within the same review. When grepping (no Vite plugin), prefer
> the source files associated with that route first — most projects
> have a router file (e.g. `src/routes/`, `pages/`, `app/`) where the
> URL path maps to a component file. Fall back to a project-wide grep
> only if a route-scoped search returns nothing. This avoids
> false-positive matches when two pages share text/selectors.

**Element selection (`kind: "select"`)** — `targets` is set (one or more):
- `targets[]` — list of DOM targets the user picked. Single-click yields
  one entry; Ctrl/Cmd+click on multiple elements yields N entries. Older
  sessions may carry `target` (singular) instead — treat it as `[target]`
  if `targets` is unset.
- For each target: `target.sourceFile` — if present (Vite plugin
  installed), open it directly. Otherwise grep the project for
  `target.nearbyText[0]` (most specific text), narrow with
  `target.nearbyText[1..]` if too generic. `target.outerHTML` and
  `target.computedStyles` are useful evidence when multiple files match.
- **`groupingMode`** (multi-target only) controls how to apply the comment:
  - `"single-edit"` *(default)* — find **one** change that satisfies every
    target. Look for a shared selector, a design-system token, or a
    common ancestor that lets you make the change once. If targets span
    different files, you may still need multiple Edit calls, but they
    should express the *same* underlying decision.
  - `"per-element"` — apply the comment as N independent edits, one per
    target. The user has signaled they want each element changed
    individually (e.g. "give all of these consistent spacing").
- **`customCss`** — if set, the user typed raw CSS in the inline editor's
  CSS tab. Apply it as additions to the matching source rule. See §7.5
  below for framework heuristics.

**Drawing (`kind` is `arrow` / `rect` / `circle` / `freehand` / `pin`)** —
no DOM target. The `comment` describes intent; the screenshot shows what
the drawing points at. Identify the area visually from the screenshot, then
grep the codebase for nearby text you can read off the screenshot.

**Placed image (`kind: "image"`)** — the user dropped a reference image
*on the page* at a specific location to indicate "make this region look
like this." `images[0]` carries the bitmap (`dataUrl` or `path`) and a
`placement: {x, y, width, height}` in page-space coords (includes
scrollY). To act on it:
1. Read the image (see §7.4 for the data-URL → temp file pattern).
2. Find the DOM region under `placement` — the composite screenshot
   shows the image stamped at that spot, so visually identify the
   element(s) it covers, then grep for nearby text from the original
   screenshot region (or from anywhere `placement.y` would land).
3. Apply the change in the codebase to make that region match the
   reference visually.

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

**If `session.modules` includes a per-submit module (e.g.
`gitlab-issues`) AND `session.autoApply` is false** — this is
**file-only mode**. The user wants a ticket, not a code edit. Read
the side panel's "File issues" button literally: skip every source
edit. Concretely:

- **Skip §6 and §7 entirely.** Do not mark per-annotation `applying`
  for source edits, do not run Edit on any file, do not lint or test.
- **Build the plan as a list of issue titles instead of file edits**
  (one bullet per annotation: "1. *short title from the comment* —
  selector / nearby text"). Show it so the user sees what's about to
  be filed; proceed without waiting for `go`.
- **Mark the session `applying` once**, then **jump straight to §7.9**
  to file the issues. The per-annotation `applying → done` lifecycle
  still applies during issue creation (mark `applying` right before
  `glab issue create`, mark `done` right after — `done` here means
  "addressed via ticket", not "source edited").
- **Then §8** as usual. The session-level `appliedSummary` should be
  "Filed N issues: !123, !124, …" so the side panel surfaces the
  list. Do not say "edited" — nothing was.

This combo is intentional UX: the user opted into the module but
withheld auto-apply, signalling "don't touch my code without
permission, just file the ticket." Honoring it builds trust.

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
session status. **Do not jump to §8 yet** — there are two checkpoints
between source-edits-applied and session-done.

After all annotations:

1. Run the project's lint / test / typecheck commands (read
   package.json scripts; `npm run check`, `npm test`, etc.).
2. **CHECK `session.modules`.** If it exists and is non-empty, you
   **must** run §7.9 now, in array order. Skipping it silently breaks
   the user's opt-in (e.g. they checked "Create GitLab issues" and got
   nothing). If `session.modules` is empty / undefined, skip §7.9.
3. Only then proceed to §8.

## 7.9 Modules — run after the source edits land

If the session has `modules` set, the user has opted into one or more
built-in Pinta integrations for this submit. Run each module after the
annotations are applied (and tests/lints pass), in array order. Match
on `module.id`.

> **Module modes:** §7.9 covers **per-submit** modules (e.g. GitLab
> Issues) that run *after* source edits land. **Interactive** modules
> (e.g. Test Pilot, §7.10) own the entire session lifecycle and
> replace the apply/lint/test loop instead of following it. The
> session shape distinguishes them: a `test-pilot` session always
> carries exactly one `kind: "query"` annotation. If you see that
> pattern, jump straight to §7.10 and skip everything above.

**Pinta does not store or transmit credentials.** Modules delegate auth
to whatever tool the user already has configured on their machine
(typically a CLI authed via its own login command). Never ask the user
for a token; if a tool isn't authed, surface that and stop.

If a module fails partway through, mark the session `error` with a
descriptive message and stop further modules. Do NOT roll back actions
that have already happened (e.g. issues already created) — match how
source edits behave today.

### Module: `gitlab-issues`

Create one GitLab issue per annotation using the **`glab` CLI** on the
user's machine. `glab` reads its own auth from the user's keyring /
config (set up once via `glab auth login`). Pinta never sees the token.

**Preflight — once per session, before iterating annotations:**

```bash
# 1. glab is installed?
command -v glab >/dev/null 2>&1 || {
  curl -sf -X POST "$BASE/v1/sessions/$SESSION_ID/status" \
    -H "Content-Type: application/json" \
    -d '{"status":"error","errorMessage":"glab CLI not found. Install it (https://gitlab.com/gitlab-org/cli) and run `glab auth login`, then re-submit."}'
  exit 0
}

# 2. glab is authenticated?
glab auth status >/dev/null 2>&1 || {
  curl -sf -X POST "$BASE/v1/sessions/$SESSION_ID/status" \
    -H "Content-Type: application/json" \
    -d '{"status":"error","errorMessage":"glab is not authenticated. Run `glab auth login` and re-submit."}'
  exit 0
}
```

**Settings** the extension provides on `module.settings` (all optional):
- `project_id` — numeric id or `group/project` path. **Leave-blank
  default**: glab uses the GitLab remote of the current git repo
  (your cwd). Set this only when you want to file issues against a
  different project than the code lives in.
- `labels` — comma-separated string. Apply to every issue.

**Ask the user for batch metadata — once per session, before filing.**
Before invoking `glab issue create` (in standard mode this runs *after*
source edits land; in file-only mode this is the first agent action
after the plan-preview), prompt the user in chat for three things that
apply to the entire batch (same values used on every issue). Stay
concise — one message, three fields, fixed format. **Do not file
anything until they reply.**

```
Before I file these GitLab issues:

- **Domain?** client / server / shared / skip
- **Extra tags?** comma-separated (e.g. "polish, a11y") or skip
- **Assignees?** comma-separated usernames (e.g. "@kevin, @maria") or skip

Reply with the values you want, e.g. `domain: client, tags: polish, assignees: @kevin`,
`skip` to file with just the defaults, or `later` to defer and not file
anything on this submit.
```

**`later` short-circuit.** If the user's reply is `later` (case-insensitive,
trimmed) or some clear intent variant ("not now", "defer", "hold off"),
**do not run `glab issue create` at all** for this submit. Tell the user
briefly:

- **Standard mode** (source edits already applied — not rolled back):
  > Skipped GitLab filing for this batch. Source edits are still in
  > place — re-submit anytime with `Create GitLab issues` re-ticked
  > when you're ready to file.

- **File-only mode** (no source edits happened):
  > Skipped GitLab filing for this batch. Nothing was applied to your
  > code either — re-submit when you're ready.

Then proceed to §8 / §9. Do **not** mark the session as `error` — this
is a normal exit, not a failure.

Otherwise, parse the user's reply leniently. Treat each field as optional —
missing / "skip" / empty values are fine, just omit them downstream.
Compose the final label set for `glab` like this:

```
FINAL_LABELS = (settings.labels)              # from module Settings (may be empty)
             + ("domain:" + DOMAIN)           # if user picked client/server/shared
             + EXTRA_TAGS                     # if user gave any
```

Comma-join the non-empty pieces. Pass to `--label`. If the user says
`skip` or replies with no parseable fields, fall back to just
`settings.labels` (which may itself be empty — that's fine, glab
handles no `--label`).

For assignees, pass each as a separate `--assignee` to `glab` (the
flag is repeatable). Strip leading `@` if the user typed it — `glab`
expects bare usernames.

**Screenshot upload — once per session, before iterating annotations.**
If `session.fullPageScreenshotPath` is set, the user opted into
"Include full-page screenshot" on this submit and wants the image
*embedded in every issue*. Upload it to GitLab once and reuse the
returned markdown reference across all issues:

```bash
SCREENSHOT_MD=""
if [ -n "$FULL_PAGE_SCREENSHOT_PATH" ]; then
  ABS_SCREENSHOT="$PROJECT_ROOT/$FULL_PAGE_SCREENSHOT_PATH"
  if [ -f "$ABS_SCREENSHOT" ]; then
    # `glab api projects/:id/uploads` returns JSON with a pre-rendered
    # `markdown` field like `![screenshot](/uploads/abc/file.png)`.
    # Use the user's project_id override if set; otherwise resolve the
    # current repo's project id via `glab repo view`.
    if [ -n "$module_settings_project_id" ]; then
      UPLOAD_PROJECT_ID="$module_settings_project_id"
    else
      UPLOAD_PROJECT_ID=$(glab repo view --output json 2>/dev/null \
        | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
    fi
    if [ -n "$UPLOAD_PROJECT_ID" ]; then
      # URL-encode group/project paths (they contain `/`).
      ENCODED_ID=$(python -c "import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=''))" "$UPLOAD_PROJECT_ID")
      UPLOAD_RESPONSE=$(glab api "projects/$ENCODED_ID/uploads" \
        -F "file=@$ABS_SCREENSHOT" 2>/dev/null || true)
      SCREENSHOT_MD=$(printf '%s' "$UPLOAD_RESPONSE" \
        | python -c "import sys,json; print(json.load(sys.stdin).get('markdown',''))" 2>/dev/null || true)
    fi
  fi
fi
```

If the upload fails (auth scope missing, network blip, project not
writable), `SCREENSHOT_MD` ends up empty — proceed and skip the
screenshot embed; don't fail the whole submission. Issues still get
filed without the image.

**Per-issue body template** (one issue per annotation):
- Title: first sentence of `annotation.comment`, capped at ~80 chars.
  If the comment is empty, fall back to `annotation.target.selector` or
  the annotation kind.
- Body (Markdown):
  ```
  {full annotation.comment}

  - **Selector:** `{annotation.target.selector}`
  - **Source file:** `{annotation.target.sourceFile}` (omit line if absent)
  - **Page:** {annotation.url ?? session.url}

  {SCREENSHOT_MD if non-empty — emits an inline image embed. Omit the
  whole line otherwise.}

  *Filed by Pinta · session `{session.id}` · annotation `{annotation.id}`*
  ```

**glab invocation** (per annotation):

```bash
# Build the body in a temp file so newlines/quotes don't fight the shell.
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
{
  printf '%s\n\n' "$ANNOTATION_COMMENT"
  printf -- '- **Selector:** `%s`\n' "$SELECTOR"
  [ -n "$SOURCE_FILE" ] && printf -- '- **Source file:** `%s`\n' "$SOURCE_FILE"
  printf -- '- **Page:** %s\n' "$PAGE_URL"
  if [ -n "$SCREENSHOT_MD" ]; then
    printf '\n%s\n' "$SCREENSHOT_MD"
  fi
  printf '\n*Filed by Pinta · session `%s` · annotation `%s`*\n' \
    "$SESSION_ID" "$ANNOTATION_ID"
} > "$BODY"

# Optional --repo only when the user explicitly overrode project_id.
# FINAL_LABELS is the comma-joined result from the chat prompt step
# above (settings.labels + domain:X + extra tags). May be empty.
# ASSIGNEE_FLAGS is the array form: --assignee user1 --assignee user2
# (glab accepts the flag repeatedly). May be empty.
glab issue create \
  ${module_settings_project_id:+--repo "$module_settings_project_id"} \
  --title "{first sentence}" \
  --description "$(cat "$BODY")" \
  ${FINAL_LABELS:+--label "$FINAL_LABELS"} \
  ${ASSIGNEE_FLAGS} \
  --no-editor
```

`glab issue create --no-editor` prints the new issue URL on stdout —
capture it into the per-annotation status update so the user sees
"filed as #42" alongside the ✓.

If a single `glab issue create` invocation fails, mark **that
annotation** as error (with stderr captured into `errorMessage`),
continue with the next annotation, and at the end mark the session
`error` if any failed.

## 7.10 Module: `test-pilot` (interactive)

`test-pilot` is an **interactive** module — it does **not** edit
source files and does **not** follow the normal apply/lint/test loop
in §7. A `test-pilot` session always carries exactly one annotation
with `kind: "query"` whose `comment` is a JSON string describing the
operation. The agent's job is to answer the question and return
structured JSON via `mark_session_done(id, appliedSummary)`.

If you see a session with:
- `modules[].id === "test-pilot"`, AND
- exactly one annotation with `kind: "query"`

then handle it via this section. Skip §7 entirely. Skip §7.9. The
session's lifecycle is just `submitted → applying → done | error`.

Always start by parsing the query annotation's `comment` as JSON. It
will have an `op` field that picks the sub-handler.

### 7.10.1 `op: "doc-parse"` — extract the test catalog

The user just imported a markdown test spec. The companion has
already written it to `.pinta/test-docs/{docId}.md` and stripped the
inline content from the annotation. The query comment after the
companion is:

```json
{ "op": "doc-parse", "docId": "abc-123", "filename": "qa-spec.md" }
```

1. `mark_session_applying({id})`.
2. Read `.pinta/test-docs/{docId}.md` with the `Read` tool.
3. Parse the markdown. The conventional shape is:
   - **Sections** are H1/H2/H3 headings (e.g. `## 1.1 Authentication (Email -> DOB -> PIN)`).
   - **Tests** under each section are a markdown table with columns
     like `ID | Test | Expected Result | P/F`. Tolerate variants —
     more / fewer columns, different header text, numbered lists,
     `**ID:** ...` patterns, even Gherkin Given/When/Then.
   - Extract per test: `id` (e.g. `AUTH-01`), `test` (description),
     `expected` (expected outcome).
4. Build the catalog payload:

```json
{
  "type": "test-pilot-catalog",
  "docId": "abc-123",
  "filename": "qa-spec.md",
  "sections": [
    {
      "title": "1.1 Authentication (Email -> DOB -> PIN)",
      "tests": [
        {
          "id": "AUTH-01",
          "test": "Open a valid claim deep-link (SUT token in URL)",
          "expected": "Redirects to the claim and lands on the email-entry step"
        }
      ]
    }
  ]
}
```

5. `mark_session_done({id, summary: JSON.stringify(payload)})`.

If the doc has no recognizable test catalog, call
`mark_session_error({id, errorMessage: "Couldn't find any test tables in {filename}. Expected markdown tables with columns like ID | Test | Expected Result, or a numbered list under section headings."})`.

Keep the JSON faithful to the doc — don't invent tests that aren't
there. The user is going to check them off; spurious rows are worse
than missing ones.

### 7.10.1b `op: "generate-doc"` — write a UAT spec for the whole app

The user clicked **"Generate Test Script"** in the Test Pilot tab.
Your job is to produce a markdown UAT spec from project context, write
it to disk, and return the parsed catalog in the same shape
`doc-parse` would return.

The query annotation's `comment`:

```json
{ "op": "generate-doc", "docId": "abc-123" }
```

**The `docId` is the same one the user has seen on their last
regenerate** — Pinta now keeps it stable across regenerations so
`.pinta/test-docs/{docId}.md` is a maintained artifact, not a fresh
UUID per click. This matters: it means an existing file at that path
is *the user's current test spec*, possibly with team additions, and
your job on regenerate is to **update it in place**, not start over.

1. `mark_session_applying({id})`.

2. **Check whether the spec already exists.** Try to `Read`
   `.pinta/test-docs/{docId}.md`. Two paths from here:

   **(a) File doesn't exist (first-time generate).** Skip to step 3
   and produce a fresh spec.

   **(b) File exists (regenerate / spec revision).** This is the
   common case after the first generate. Your goal is to bring the
   spec in line with the *current* code while preserving as much of
   the existing spec as possible:
   - **Read the existing spec carefully.** Note every section title
     and every test id (`AUTH-01`, `CLAIM-03`, etc.). These ids are
     load-bearing — the user's Pass/Fail marks survive in the
     browser only when the *id* stays stable across regen.
   - **Scan the current code** the same way you would for a fresh
     spec (step 3 below) — routes, components, auth flow, etc.
   - **Reconcile**:
     - **Unchanged scenarios → keep the same id and the same row.**
       Even if the wording could be polished, don't rewrite it — the
       row id is what the marks key off, but a recipient comparing
       the spec against the prior version will read the row text
       too. Leave it alone unless the underlying scenario has
       genuinely changed.
     - **Renamed / refactored scenario → keep the same id, update
       the row text.** A login flow that moved from email-then-DOB
       to email-then-PIN keeps `AUTH-01`; only its description /
       expected change.
     - **New scenarios in the code that aren't in the spec → assign
       the next free id within the right section.** If the
       authentication section's highest existing id is `AUTH-07`,
       new auth tests start at `AUTH-08`.
     - **Scenarios that no longer exist in the code → remove from
       the spec.** Don't leave dead rows behind.
     - **Brand new feature areas → add a new section** with a fresh
       id prefix.
   - **Write the updated markdown back to the same path.** Overwrite,
     don't create a sibling.

3. **Design the test catalog** (first-time, or after the read above
   if you need to fill in genuinely missing parts). Group tests by
   user-facing area (Authentication, Dashboard, Settings, etc.) —
   these become H2/H3 sections. Inside each section, enumerate
   concrete pass/fail tests the user can run in a browser.
   Conventions:
   - Each test gets a stable ID (`AUTH-01`, `DASH-02`, …).
   - Each test has a one-line description and a one-line expected
     result.
   - **Don't invent flows that don't exist.** If a route or feature
     isn't actually in the code, omit it.
   - **Don't bake in real credentials** — use placeholders
     (`<test-email>`, `<staging-token>`).
4. **Write the markdown to disk** at
   `.pinta/test-docs/{docId}.md`. Use a conventional layout the
   companion's parser handles natively — section headings followed by
   pipe tables, e.g.:

   ```markdown
   # UAT — <app name>

   ## 1.1 Authentication

   | ID | Test | Expected Result |
   |----|------|-----------------|
   | AUTH-01 | Open valid claim deep-link | Lands on email-entry step |
   | AUTH-02 | Submit registered email | Generic confirmation; moves to DOB |
   ```

5. **Re-parse the markdown you just wrote** the same way as
   `doc-parse` (§7.10.1) and build the catalog payload — same JSON
   shape, with the `filename` set to a sensible default like
   `generated-tests.md`:

   ```json
   {
     "type": "test-pilot-catalog",
     "docId": "abc-123",
     "filename": "generated-tests.md",
     "sections": [ ... ]
   }
   ```

6. `mark_session_done({id, summary: JSON.stringify(payload)})`.

**Rules specific to `generate-doc`:**

- **Do not ask the user clarifying questions.** This is autoApply mode;
  the user expects a result, not a back-and-forth. If you genuinely
  can't determine what to test (empty project, no recognizable
  framework), `mark_session_error` with a clear explanation rather
  than guessing.
- **Bound your scan.** Don't read more than ~30-40 files. The goal is
  a useful starter spec, not exhaustive coverage. The user will
  iterate.
- **Prefer breadth over depth.** A catalog with 8 sections of 4-6
  tests each is better than one section of 30 deep tests.
- **No source edits.** Like the other Test Pilot ops, the only file
  you write is `.pinta/test-docs/{docId}.md`.
- **Stable ids are load-bearing.** When the file already exists,
  carrying ids over from the prior spec is the difference between the
  user's Pass/Fail marks surviving and the user losing all their
  testing progress. If you renumber a scenario that hasn't changed
  (e.g. AUTH-01 → AUTH-02 just because the section was reordered),
  the browser-side merge can't match it up and the mark drops. Treat
  ids like primary keys, not display strings.
- **`USER-*` ids are user-owned. Preserve them verbatim.** Any test
  whose id starts with `USER-` (e.g. `USER-1`, `USER-12`) was added
  manually by the tester from Phase 13's catalog-edit affordances —
  side panel kebab → "Add test below". They live in the same on-disk
  spec file you read on regen. Treat them as **permanent**: keep them
  in the same section, in the same position relative to the
  surrounding rows, with **no edits to title or expected text**. The
  user owns their content; touching it silently destroys their work.
  If you add a new section during regen, do not insert `USER-*` rows
  into it — they stay where the user put them.

### 7.10.2 `op: "detail-steps"` — generate concrete steps for one test

The user clicked the "?" icon on a row in the catalog. The query
comment:

```json
{
  "op": "detail-steps",
  "docId": "abc-123",
  "testId": "LIST-05",
  "sectionTitle": "1.2 Claim Listing"
}
```

1. `mark_session_applying({id})`.
2. Read `.pinta/test-docs/{docId}.md`.
3. Locate the row by `testId`. Capture the full row (description +
   expected) plus the section context.
4. **Determine the verbosity mode.** The query comment now carries the
   per-call signal directly. Read it like this:

   ```
   detailedSteps = queryComment.detailedSteps  // canonical, per-call
   if detailedSteps === undefined:
     detailedSteps = modules[i].settings.detailed_steps  // legacy fallback
       where modules[i].id === "test-pilot"
   if detailedSteps === undefined:
     detailedSteps = false  // default = simple mode
   ```

   **Always check `queryComment.detailedSteps` FIRST.** The user has an
   inline "Details" checkbox in the row detail view that flips this
   per Re-ask; the module-wide setting is just the default. If you
   ignore the per-call signal you'll be writing simple steps when the
   user explicitly asked for deep ones (the common complaint).

   ---

   **`detailedSteps === false` (default — token-saver mode):**
   Write simple steps a manual QA tester can follow. This is *not* a
   dev runbook — assume the tester is clicking around a browser, not
   running shell scripts.
   - **3–6 steps**, almost always. If you have 10, you're over-engineering.
   - **One UI action per step**: navigate, click, type, observe.
   - **Plain English**, short sentences. No curl, no API endpoints, no
     headers, no JSON bodies, no env vars, no internal class names.
   - **No fenced code blocks** unless the step truly requires a literal
     string the tester must paste (rare). Inline `` `code `` is fine
     for short things like a URL path, a field name, or a button label.
   - **No "preconditions" step that mints data via the backend.** If
     the test needs a specific account state, describe it in plain
     words ("Use a test account whose CFR expired > 90 days ago — see
     the QA seed list") and let the tester pick from the team's seed
     data. Don't generate setup commands.
   - **Last step is the verification** — what they should see.

   Good vs bad (default mode):
   - ✅ *"Open `/claims` in an Incognito window and sign in as the
     expired-CFR test user."*
   - ❌ *"Run `curl -X POST http://localhost:8083/api/v1/admin/claims ...`
     to register a CFR."*

   **`detailedSteps === true` (deep-help mode):**
   Tester wants real technical depth — they're debugging, writing a
   new test from scratch, or trying to understand the full mechanics.
   Treat "this test looks simple" as a sign you should *go deeper*,
   not as permission to dial back. **Minimum bar:**
   - **At least 6 steps. Aim for 6–12.** Even if the surface action is
     "click a URL," break out the prep, the click, the network/URL
     verification, the DOM verification, the cleanup. If you're under
     6 steps in deep mode, you're failing the user.
   - **At least one fenced code block per response** — a curl, a sample
     request/response body, a DB query, a console snippet, an env
     export, *something* the user could paste. If the test is purely
     UI, fence the literal URL or the expected DOM fragment so the
     code-block density signals "deep mode" visually.
   - **Reference specific endpoint paths, query params, header names,
     internal flag names, and env vars** where they help. Don't hide
     behind "the API endpoint" — name it (`POST /v1/sessions`).
   - **Add `> Note:` callouts** for at least one optional / expert
     observation per response (e.g. "verify the JWT `exp` claim in
     DevTools → Application → Cookies", "the token query param is
     stripped after first read — refresh leaks no PII").
   - **Verification step** still goes last, but in deep mode it spans
     multiple checks: visual + network + storage where applicable.

   Good vs bad (deep mode), same test as above:
   - ✅ Multi-line step like:
     ```
     Open DevTools → Network before the click. Paste the deep link:
     ```bash
     # claim-auth?token=eyJhbGc...
     ```
     Confirm the request returns 302 to `/email`, then the `token`
     query string is stripped from the address bar.
     ```
   - ❌ *"Open the URL and confirm it loads"* — that's simple-mode
     output regardless of which mode was requested.

   Either way: **the last step is always the verification.**

5. Build the detail payload:

```json
{
  "type": "test-pilot-detail",
  "docId": "abc-123",
  "testId": "LIST-05",
  "title": "Open Claim List with an EXPIRED CFR (>90d)",
  "expected": "Expired CFR shown as EXPIRED, deep-link disabled",
  "steps": [
    "Sign in as a test user whose CFR expired more than 90 days ago.",
    "Open the Claim List page.",
    "Find the expired CFR row — confirm it shows the `EXPIRED` label.",
    "Click the row and confirm nothing happens (the deep link is disabled)."
  ]
}
```

6. `mark_session_done({id, summary: JSON.stringify(payload)})`.

If the test isn't in the doc, `mark_session_error` with a clear
message ("Test {testId} not found in {filename}.").

### `test-pilot` operating rules

- **No source edits.** Don't touch any file outside
  `.pinta/test-docs/`. Don't `git add`, don't run tests, don't lint.
- **No annotations to apply.** The query annotation isn't a bug
  report; it's a request.
- **Skip §7 entirely.** The normal annotation loop doesn't apply.
- **Skip §7.9 (other modules).** Interactive modules own the entire
  session lifecycle.
- **`appliedSummary` is structured JSON.** Always
  `JSON.stringify({...})` your payload. The extension parses it on
  the other side. If the JSON is malformed the user sees a parse
  error in the Test Pilot tab.

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
