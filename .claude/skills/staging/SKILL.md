---
name: staging
description: Use when the user wants a single-shot release-readiness check before shipping Pinta. Runs `/test`, `/audit`, and `/spec` in sequence and produces one consolidated verdict — green-light to publish, fix-the-criticals-and-ship, or hold. Recommended before any `npm publish`, `git tag`, or Chrome Web Store push.
---

# /staging

End-to-end pre-deploy gate. Orchestrates the three existing release-
quality skills and rolls their outputs into one verdict so you don't
have to read three reports separately.

## What it does

Runs in this order — earliest-failing wins (no point auditing if tests
are red, no point spec-checking if the security audit caught a P0):

1. **`/test`** — Vitest suites for `extension` + `companion`.
2. **`/audit`** — security + performance walk of the Chrome extension.
3. **Svelte best-practices audit** — installs the official Svelte AI
   skills (`svelte-code-writer`, `svelte-core-bestpractices`) if not
   already present, then runs `@sveltejs/mcp svelte-autofixer` over
   `extension/src/**/*.svelte` to surface reactivity / `$state` /
   `$effect` mistakes Pinta's own audit checklist can't catch.
4. **`/spec`** — gaps between `spec/SPEC.md` and shipped code.

Each sub-skill produces its own report. `/staging`'s job is to:
- Invoke them in sequence via the **Skill** tool.
- Collect each report's findings + verdict.
- Render one consolidated table, severity-merged across all three.
- Emit a single **release-readiness verdict** the user can act on.

## 0. Sanity check the working directory

```bash
test -f package.json && grep -q '"name": "pinta"' package.json && echo "OK in pinta repo" || { echo "ERROR: run /staging from the pinta repo root"; exit 1; }
```

If that fails, ask the user to `cd` into their pinta clone and re-invoke.

## 1. Run `/test`

Invoke via the Skill tool:

```
Skill(skill="test")
```

Capture the result. Branch:

- **All tests pass** → continue to step 2.
- **Any failure** → STOP. Don't run audit or spec. Report:

  ```
  🛑 HOLD — tests are red.

  Failing: <file>:<test name>
  <assertion message excerpt>

  Fix the test failure(s) and re-run /staging.
  ```

  Do NOT auto-fix. The user triages.

## 2. Run `/audit`

Tests are green — invoke audit:

```
Skill(skill="audit")
```

Audit produces a prioritized findings list (P0 / P1 / P2 typically,
or 🔴 / 🟠 / 🟡). Capture it verbatim — don't re-summarize, you'll
roll it up below.

If audit hits an internal error (couldn't WebFetch Svelte docs, can't
read a file, etc.), surface that too — the audit is genuinely
incomplete and the verdict shouldn't claim coverage it doesn't have.

## 3. Svelte best-practices audit

Pinta's own `/audit` is opinionated about Svelte 5 reactivity but
operates from a static checklist. The Svelte team ships a live
autofixer (`svelte-autofixer` inside `@sveltejs/mcp`) that checks
files against the *current* Svelte 5 grammar — catches missing
`{#each}` keys, `{@html}` callsites, `$effect` malpractice
("assigning a stateful variable inside an $effect"), mutable
`Map` / `Set` usage where `SvelteMap` / `SvelteSet` belongs, and
similar issues that drift as Svelte evolves.

Source: https://svelte.dev/docs/ai/skills
Tool: https://www.npmjs.com/package/@sveltejs/mcp

The "install skills" path documented on the Svelte page is a Claude
Code marketplace flow that doesn't currently expose a CLI install
subcommand on `@sveltejs/mcp` (verified at v1.x — `--help` lists
`list-sections`, `get-documentation`, `svelte-autofixer` only). The
autofixer alone provides the linting value the staging gate needs;
the prompt-style skills (`svelte-code-writer`,
`svelte-core-bestpractices`) are advisory and outside the scope of an
automated check.

### 3.1. Run the autofixer over files touched in this branch

`svelte-autofixer` takes a single path per invocation (no glob),
so pick the files most likely to have new findings — anything
modified since the last commit on `main`, plus any `.svelte` files
in subdirectories of `extension/src/` that haven't been audited
recently. Use `git status` + `git diff --name-only main...HEAD` to
narrow the set.

For each file:

```bash
npx -y @sveltejs/mcp@latest svelte-autofixer <path> 2>&1
```

(`.svelte.ts` / `.svelte.js` runes modules also work.)

The output is a small JS object literal — `{ issues: [...],
suggestions: [...], require_another_tool_call_after_fixing: bool }`.

- **issues** — concrete things to fix (missing `{#each}` key,
  `{@html}`, etc.). Roll up as `[svelte]` findings.
- **suggestions** — style / idiom advice. Drop unless the user is
  about to refactor anyway.

### 3.2. Filter the output

The autofixer is noisy. Drop these classes of finding when rolling up:

- `{@html}` warnings on callsites already manually verified safe in
  `/audit` (Pinta's `TOOLS[i].svg` constant, Prism-escaped highlight
  output). The autofixer flags every `{@html}` regardless of
  context.
- `$effect` malpractice / "stateful variable assigned inside
  $effect" suggestions on files NOT modified in this branch — they
  are pre-existing patterns; only flag them when the diff actually
  introduces a new one.
- `bind:this` → action/attachment suggestions. Style-only.
- `Found a mutable instance of the built-in Map/Set` — design
  choice; flag in 🟡 only if introduced by this branch.

### 3.3. What to keep

- Missing `{#each}` key on a loop introduced in this branch
  (correctness — Svelte's keyed-each diffing can break with positional
  keys when items are deleted or reordered).
- Any new `{@html}` callsite bound to a non-constant source — these
  need a manual safety review and should appear in the roll-up.
- New `$effect` that assigns a `$state` variable on every fire — real
  reactivity leak.

If the autofixer can't be invoked at all (npm unreachable, package
moved, etc.), report it as "Svelte audit: skipped — <reason>" and
continue. Don't abort the staging run for a tooling gap.

## 4. Supply-chain check — `npm audit`

Run the workspace-wide dependency audit before /spec. The goal is to
catch known-CVE packages — `npm audit` reads the GitHub Advisory
Database and reports any installed version that matches a published
vulnerability. Catches the most common supply-chain attack pattern
(legitimate package shipping a malicious version, or a transitive dep
with a recently-disclosed RCE / prototype-pollution / etc.).

```bash
npm audit --audit-level=high --workspaces --include-workspace-root --json 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const m=j.metadata?.vulnerabilities||{};const hi=(m.high||0)+(m.critical||0);console.log(JSON.stringify({high:m.high||0,critical:m.critical||0,total:hi,advisories:Object.keys(j.advisories||{}).slice(0,10)}))}catch(e){console.log('{\"error\":\"'+e.message+'\"}')}})"
```

Interpret the output:

- `{"total": 0, ...}` — clean. Move on to /spec.
- `{"high": N, "critical": M, ...}` — log the count and advisory ids;
  roll up under 🔴 (any critical) or 🟠 (high only). Surface the
  specific advisory ids so the user can decide per-package whether to
  bump, override, or accept the risk.
- `{"error": "..."}` — `npm audit` itself failed (offline, registry
  outage, malformed manifest). Note as "audit: skipped — <reason>"
  and continue. Don't fail the staging gate on tooling outage.

Don't pass `--fix` from /staging — auto-fix can pull breaking major
versions. The user decides per-advisory whether to bump, override
via `overrides` in package.json, or accept and document.

## 4.5 Keybindings retrospect

Pinta exposes keyboard shortcuts across three surfaces (page overlay,
inline editors, chat input) AND lists them to the user in Settings →
Keyboard shortcuts. The bindings live in code; the Settings display +
docs page are the user's contract. Drift here is sneaky — a tester
follows the docs, the hotkey doesn't fire, the bug looks like "Pinta
broken."

Walk the binding-site → docs/Settings mapping. Anything missing,
mismatched, or no-op gets reported under `[keybindings]` in the
roll-up (step 6).

### 4.5.1 The expected matrix

These are the bindings the user is told about (Settings panel +
`docs/docs.html` Hotkeys section). Each row names the surface, the
keys, what they should do, and where to find the implementation.

| Surface | Keys | Behavior | Binding site |
|---|---|---|---|
| Page overlay | `Alt+S` | Toggle Select mode | `extension/src/content/Overlay.svelte` keydown handler |
| Page overlay | `Alt+P` | Toggle Draw mode | `extension/src/content/Overlay.svelte` keydown handler |
| Page overlay | `Alt+X` | Exit to idle | `extension/src/content/Overlay.svelte` keydown handler |
| Page overlay | `Esc` (select) | Clear selection OR exit to idle | `extension/src/content/Overlay.svelte` select-mode $effect |
| Page overlay | `Esc` (draw) | Cancel pending / in-progress / exit | `extension/src/content/Overlay.svelte` draw-mode $effect |
| Page overlay | `Esc` (image) | Cancel pending image | `extension/src/content/Overlay.svelte` image-mode $effect |
| Element editor | `Ctrl/Cmd+Enter` | Submit (if `canSubmit`) | `extension/src/content/ElementEditor.svelte` onKey |
| Element editor | `Esc` | Cancel + close | `extension/src/content/ElementEditor.svelte` onKey |
| Comment popover | `Ctrl/Cmd+Enter` | Submit comment | `extension/src/content/CommentInput.svelte` onKey |
| Comment popover | `Esc` | Cancel + close | `extension/src/content/CommentInput.svelte` onKey |
| Chat input | `Enter` (alone) | Send message | `extension/src/sidepanel/ChatSheet.svelte` onKeyDown |
| Chat input | `Alt+Enter` / `Shift+Enter` / `Ctrl+Enter` | Newline | `extension/src/sidepanel/ChatSheet.svelte` onKeyDown |

### 4.5.2 What to verify

For each row above:

1. **Implementation exists.** Grep the binding site for the key
   literal (e.g. `key === "Enter"`, `altKey`, `metaKey`, etc.). If the
   handler is missing or short-circuited, that's a 🔴.
2. **Settings display matches.** Read
   `extension/src/sidepanel/SettingsPanel.svelte` "Keyboard shortcuts"
   block and check the displayed `kb.keys` arrays + labels match the
   table. Drift = 🟠 (user-visible lie).
3. **Docs page matches.** Grep `docs/docs.html` for the Hotkeys list —
   currently in the **Annotate → Hotkeys** section. Drift = 🟡.
4. **Esc → toolbar sync.** A subtle one: hotkey-driven mode changes
   (Alt+S/P/X) AND Esc-driven exits on the page must flow back to the
   side panel's `activeTool` so the toolbar pressed-state matches the
   actual mode. Look for a `chrome.runtime.sendMessage({type:
   "mode.changed", ...})` in `Overlay.svelte` and the matching
   `m?.type === "mode.changed"` handler in `App.svelte`. If either is
   absent, the Select toggle stays lit after Esc — 🟠.
5. **Hotkeys ignore form fields.** The page overlay keydown handler
   must early-out when `document.activeElement` is INPUT / TEXTAREA
   / contenteditable. If a user types "p" into a textarea on their
   app and it toggles Draw, that's 🔴 (intercepts every keystroke).

### 4.5.3 Quick bash for the binding-site spot-check

```bash
# Page overlay hotkeys must be present
grep -nE 'key === "(s|p|x)"|altKey' extension/src/content/Overlay.svelte | head -10

# Esc handlers across the three modes
grep -nE 'key.*"Escape"|"Escape"' extension/src/content/Overlay.svelte

# Element editor / comment popover Ctrl+Enter + Esc
grep -nE 'metaKey|ctrlKey|"Escape"' extension/src/content/ElementEditor.svelte extension/src/content/CommentInput.svelte

# Chat Enter / Alt+Enter
grep -nE 'isComposing|altKey|metaKey|ctrlKey' extension/src/sidepanel/ChatSheet.svelte

# mode.changed sync (Esc → toolbar dehighlight)
grep -nE 'mode\.changed' extension/src/content/Overlay.svelte extension/src/sidepanel/App.svelte
```

Each grep must surface at least one match. Empty result = missing
binding → 🔴.

### 4.5.4 What NOT to flag

- Browser-default shortcuts the user might mention (`Ctrl+F`, etc.)
  that Pinta deliberately doesn't intercept. Out of scope.
- Hotkey aliases (`Shift+Enter` for newline alongside `Alt+Enter` in
  chat) — multiple bindings for the same action are intentional.
- IME composition guards (`isComposing`) — those are correctness
  scaffolding, not user-facing bindings.

## 5. Run `/spec`

Independent of audit — invoke unconditionally (you want to know about
spec drift even if the audit already caught the same code path from a
different angle):

```
Skill(skill="spec")
```

Capture verbatim.

## 6. Roll up

Merge findings from steps 2, 3, 4, 4.5, and 5 into a single
severity-grouped table. Drop duplicates (audit and spec both flagging
the same issue gets listed once, with attributions in parens):

```
🔴 CRITICAL — must fix before deploy
  • [audit]       <finding>
  • [svelte]      <finding from svelte-autofixer>
  • [supply-chain] <critical CVE in dep>
  • [keybindings] <missing binding-site or unguarded form-field intercept>
  • [spec]        <finding>
  • [audit + spec] <finding flagged by both>

🟠 IMPORTANT — should fix or knowingly accept
  • [audit]       <finding>
  • [svelte]      <finding>
  • [supply-chain] <high CVE in dep>
  • [keybindings] <Settings/docs mismatch with implementation>
  • [spec]        <finding>

🟡 NICE TO FIX — defer if pressed for time
  • [keybindings] <docs page lagging Settings copy>
  • [spec]        <finding>
```

Then a separate **Tests** line stating the pass count from step 1
(e.g. `✅ Tests: 6 + 14 passing across companion + extension`).

## 7. Final verdict

Pick exactly one based on the merged severity:

- **✅ SHIP IT** — no 🔴, no 🟠. Tests green. Spec aligned. Safe to
  `npm publish` / `git tag` / push to Chrome Web Store.
- **⚠️ FIX THE 🔴s AND SHIP** — 🔴s present but mechanical / scoped.
  No 🟠 architectural gaps. List the 🔴s as a punch list.
- **🛑 HOLD** — any of: 🔴 architectural drift, 🟠 wire-protocol
  mismatch, audit P0 security finding, missing release artifact
  (unbumped version, `## Unreleased` heading still present, etc.).

The verdict line is the most important sentence in the report — make
it the last line and put it in bold.

## 8. After the report

Don't auto-fix anything. `/staging` is a decision tool, not an action
tool. Two follow-ups the user might invoke:

- "fix the criticals" → start working through the 🔴 list.
- "ship it anyway" → that's their call; acknowledge and stop.

## Notes

- Run-time budget: roughly 60–120s wall clock depending on how
  recently the codebase was scanned. /test is sub-second; /audit
  fetches Svelte docs (skippable in offline mode); the Svelte
  autofixer first run takes ~15-30s to fetch the npm package,
  subsequent runs are near-instant; /spec walks ~800 lines of spec +
  cross-references.
- If any sub-skill is missing on disk (`.claude/skills/<name>/SKILL.md`
  not present), STOP and tell the user which one is missing — don't
  silently skip it. The whole point of /staging is unified coverage.
- Don't run `/staging` inside `/staging` (no recursion). If the user
  re-invokes, treat it as "rerun" and start fresh from step 0.
- Use the Skill tool to invoke each sub-skill — do NOT cargo-cult
  their output by re-running their bash steps inline. The skills are
  the contract.
