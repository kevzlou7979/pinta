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
4. **Claude Code / Anthropic policy compliance** — verify Pinta stays
   bring-your-own-Claude + interactive-terminal-only: no credential
   proxying, Agent SDK, headless `claude -p`, or Claude.ai OAuth that
   would move it into Anthropic's banned third-party-tool lane (the
   crackdown that cut off OpenClaw, Apr 2026). A change here is an
   account-ban risk for every user, so it gates the release.
5. **Browser-extension store-policy compliance** — verify the manifest
   stays Chrome-Web-Store-shippable: MV3, no remotely hosted code, CSP
   unloosened, permissions not creeping past the justified baseline,
   privacy disclosure intact. A regression here means CWS review
   rejects the upload (or pulls the live listing), so it gates too.
6. **Token economy** — flag a branch diff that inflates the tokens each
   agent run spends (raised payload caps, new always-on heavy field, raw
   PNG to the agent, materially larger SKILL.md, new unbounded loop).
   Pinta is BYO-Claude, so this is the user's own per-run cost.
7. **`/spec`** — gaps between `spec/SPEC.md` and shipped code.

Each sub-skill produces its own report. `/staging`'s job is to:
- Invoke them in sequence via the **Skill** tool.
- Collect each report's findings + verdict.
- Render one consolidated table, severity-merged across all checks.
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

## 4.6 Claude Code / Anthropic policy compliance

Anthropic restricts third-party tools from routing requests through a
user's Claude **subscription** credentials or the **Agent SDK** (Feb /
Apr / Jun 2026 ToS — the crackdown that cut off OpenClaw and friends).
Pinta stays in the *supported* lane by being **bring-your-own-Claude**
and running as a skill inside the user's **interactive** Claude Code
terminal — it never touches Anthropic credentials. This check guards
against a change quietly moving Pinta into the banned lane, which would
risk an **account ban for every user**, so it is release-gating. Source
of truth: the `feedback-anthropic-compliance` memory + `SKILL.md`'s
compliance declaration. Report hits under `[compliance]`.

### 4.6.1 The hard rules (regressions here are 🔴)

| # | Rule | A violation looks like |
|---|---|---|
| 1 | **No Anthropic-credential handling** | extension or companion stores / reads / transmits an Anthropic API key, OAuth token, or Claude.ai cookie |
| 2 | **No Agent-SDK / headless invocation** | code imports `@anthropic-ai/claude-agent-sdk`, or spawns `claude -p` / `claude --print` / shells out to `claude` from the companion or scripts |
| 3 | **No Claude.ai OAuth / login-on-behalf** | any flow that authenticates a user to Claude, or a remote relay that forwards multiple users' agent requests through one account |
| 4 | **BYO-Claude stays local** | the companion is a localhost relay only — no remote endpoint that brokers agent requests for other users |

### 4.6.2 Bash spot-check

```bash
# 1 — no Anthropic credential handling. Expect "(clean)". The filter
#     drops the §4.6.4 known-safe cases: the secret-scanner (`capture.*`
#     detects/redacts sk-ant keys from page content) and compliance
#     prose that FORBIDS the pattern. Eyeball any survivor.
grep -rniE "ANTHROPIC_API_KEY|sk-ant-|x-api-key|oauth.*claude|claude.*oauth|claude\.ai/(login|oauth)" \
  extension/src companion/src skill/pinta scripts 2>/dev/null \
  | grep -viE "never|do not|must not|forbid|compliance|supported|bring-your-own|scrub|redact|capture\." \
  || echo "  (clean)"

# 2 — no Agent SDK / headless claude invocation in our own code. Expect "(clean)".
grep -rniE "claude-agent-sdk|claude_code_sdk|claude +-p\b|claude +--print|spawn[^)]*claude|exec[^)]*claude" \
  extension/src companion/src skill/pinta scripts 2>/dev/null \
  | grep -viE "never|do not|must not|forbid|compliance|interactive" \
  || echo "  (clean)"

# 3 — bounded loop + compliance declaration still in SKILL.md. Use stable
#     phrases (markdown emphasis / capitalisation vary, so match loosely).
grep -ci "bring-your-own-claude" skill/pinta/SKILL.md                            # expect >= 1 (declaration)
grep -ciE "interactively, not 24/7|idle timeout|self-paus" skill/pinta/SKILL.md  # expect >= 1 (§9 bound)
grep -c "Loop indefinitely. Don't stop on your own" skill/pinta/SKILL.md         # MUST be 0 (regression marker)

# 4 — docs disclose BYO / interactive (🟡 if missing)
grep -lE "bring-your-own-Claude|Anthropic compliance" README.md docs/index.html
```

### 4.6.3 Severity

- Any **real** hit on checks **1 or 2** (credential handling / Agent-SDK
  / headless `claude` path) → **🔴 `[compliance]`** — this is the exact
  pattern that gets tools banned. Block the release until removed or
  proven a false positive.
- **Bounded-loop regression** (check 3: the `Loop indefinitely…` string
  returns, or the idle-timeout / compliance declaration is gone) →
  **🟠 `[compliance]`**.
- **Docs missing** the BYO / compliance disclosure (check 4) →
  **🟡 `[compliance]`**.

### 4.6.4 What NOT to flag

- `/audit`'s secret-scan **regexes** that *look for* `sk-…` / tokens —
  they detect secrets, they don't store them.
- SKILL.md / README / SPEC prose that *describes* the banned patterns in
  order to **forbid** them (the compliance declaration, trust-boundary
  rules, the Phase 19 hard rules). Quoting a rule isn't violating it.
- The user pasting *their own* key into *their own* Claude Code or
  `.npmrc` outside Pinta — Pinta never sees it; out of scope.

## 4.7 Browser-extension store-policy compliance (Chrome Web Store)

Pinta ships through the Chrome Web Store, whose **Developer Program
Policies** gate publication and can pull a *live* listing on review.
The §4.6 check guards the *Anthropic* lane; this one guards the
*store* lane. The failure mode is different but just as fatal: a
manifest change that trips CWS review means the release can't ship
(or an existing listing gets suspended). Source of truth: the
manifest at `extension/manifest.config.ts`, the privacy disclosure at
`docs/privacy.html`, and Chrome's policies
(https://developer.chrome.com/docs/webstore/program-policies/).
Report hits under `[ext-policy]`.

### 4.7.1 The hard rules (regressions here are 🔴)

| # | Rule | A violation looks like |
|---|---|---|
| 1 | **Manifest V3 only** | `manifest_version` drops below 3, or a deprecated MV2 key (`background.scripts`, `browser_action`, `page_action`) appears |
| 2 | **No remotely hosted code** | `eval(` / `new Function(` / `import("http…")` / a remote `<script src>`/`<link href>` in any packaged HTML — MV3 forbids executing code not in the package |
| 3 | **CSP not loosened** | a `content_security_policy` entry adding `unsafe-eval`, `unsafe-inline`, or a remote `script-src` origin |
| 4 | **Single purpose preserved** | the manifest `description` / `name` no longer matches the annotate-and-hand-to-agent purpose, signalling scope creep a reviewer flags |

### 4.7.2 Scope creep — permissions diff (🟠 unless justified)

CWS review time and rejection risk scale with permission breadth.
The known, justified set is the baseline; **anything beyond it is a
new ask a reviewer will question** and must be deliberate:

- `permissions`: `sidePanel`, `tabs`, `activeTab`, `scripting`, `storage`
- `host_permissions`: `<all_urls>` (needed — Pinta annotates *any*
  app the user is building; this is the single most-scrutinised line,
  so a *narrowing* is good, a *widening* is impossible)
- `content_scripts[].matches`: `<all_urls>`

A **newly added** permission (e.g. `webRequest`, `cookies`,
`<all_urls>` creeping into a second declaration, `declarativeNetRequest`,
`downloads`, `nativeMessaging`) not in this list → 🟠 `[ext-policy]`
with the note "new permission `<x>` — needs a store-listing
justification + may extend review." Removing one is always fine.

### 4.7.3 Privacy disclosure (🟠 if data flow undisclosed)

Pinta reads page DOM/content and captures screenshots, then ships
them over the localhost companion socket to the user's own agent.
That is **user-data handling** under CWS even though it never leaves
the user's machine — the store listing's privacy practices + a
reachable privacy policy must disclose it. The repo's policy lives at
`docs/privacy.html`. If that file is gone or no longer describes what
Pinta reads/transmits, that's 🟠 `[ext-policy]`.

### 4.7.4 Bash spot-check

```bash
# 1 — MV3, no MV2 leftovers. Expect the first to print 3, rest "(clean)".
grep -E "manifest_version" extension/manifest.config.ts
grep -nE "background\.scripts|browser_action|page_action|\"persistent\"" extension/manifest.config.ts || echo "  (clean)"

# 2 — no remotely hosted / dynamic code in PACKAGED source (exclude tests &
#     AuditFlow's own checklist prose, which name eval() as a finding to detect).
grep -rniE "\beval\(|new Function|\bimport\((['\"])https?:|<script[^>]+src=(['\"])https?:|<link[^>]+href=(['\"])https?:" \
  extension/src 2>/dev/null \
  | grep -vE "\.test\.|audit-flow|label:|description:|finding" \
  || echo "  (clean)"

# 3 — CSP not loosened (no override at all is the current, correct state).
grep -niE "content_security_policy|unsafe-eval|unsafe-inline" extension/manifest.config.ts \
  || echo "  (clean — MV3 default CSP)"

# 4 — permission set unchanged from the §4.7.2 baseline. Eyeball the diff.
grep -nE "^  permissions:|host_permissions:|matches:" extension/manifest.config.ts

# 5 — privacy disclosure still present.
test -f docs/privacy.html && echo "  privacy.html present" || echo "  MISSING privacy.html — 🟠"
```

### 4.7.5 Severity

- Any **real** hit on **1, 2, or 3** (MV3 downgrade / remote code /
  loosened CSP) → **🔴 `[ext-policy]`** — these are automatic CWS
  rejections. Block the release until removed or proven a false
  positive.
- **New permission** beyond the §4.7.2 baseline, or a **missing /
  stale privacy disclosure** → **🟠 `[ext-policy]`** — shippable only
  if the user knowingly accepts the added review risk and updates the
  store listing's justification + privacy fields.
- **Single-purpose drift** in the description that's cosmetic (a
  reworded but still-accurate tagline) → 🟡; a description that now
  advertises an unrelated capability → 🟠.

### 4.7.6 What NOT to flag

- The existing `<all_urls>` host permission and `<all_urls>` content-
  script match — they are the *justified baseline*, not a finding.
  Pinta genuinely must run on any page the user is building.
- `eval` / `new Function` strings inside `*.test.ts` or the AuditFlow
  checklist (`audit-flow.*`) — those *describe* the anti-pattern as a
  security finding to detect; they don't execute it.
- The localhost companion socket (`ws://127.0.0.1:…`) — connecting to
  localhost is permitted under MV3 and is the BYO-Claude design, not a
  remote-code or remote-host violation.
- `@crxjs/vite-plugin` HMR / dev-server injection in a *dev* build —
  only the production `extension/dist` build is what ships; flag dev-
  only CSP relaxation only if it leaks into the packaged manifest.

## 4.8 Token economy (BYO-Claude cost)

Pinta is **bring-your-own-Claude** in the user's *interactive* terminal,
so every annotate / AuditFlow / Test Pilot / chat run spends the user's
own Claude tokens (see the `feedback-token-economy` memory). Token cost
is a first-class product cost — a release that quietly inflates it makes
Pinta expensive and slow to run for every user. `/audit` §3.7 already
audits the *extension's* agent-facing payloads; this step is the
**release-diff gate** — it flags when *this branch* raises token cost
across the whole repo (extension + skill + companion), including the
SKILL.md prompt size that `/audit` deliberately leaves out. Report hits
under `[token]`.

### 4.8.1 What raises token cost (flag in the branch diff)

| # | Regression | Severity |
|---|---|---|
| 1 | A per-page payload **cap raised or removed** (`HTML_TRUNCATE`, `NEARBY_LEVELS`, `NEARBY_TEXT_MAX` in `content/capture.ts`) | 🟠 (🔴 if removed entirely → unbounded) |
| 2 | A **new always-on heavy field** added to a wire payload / annotation / audit query (vs lazy / opt-in) | 🟠 |
| 3 | A **raw full-res / PNG image** path to the agent (should be JPEG + downscaled) | 🟠 |
| 4 | **SKILL.md grew materially** — it's loaded into the agent's context on *every* run, so its line count is a per-invocation tax (baseline ~2285 lines at 2026-06-04). A large jump from duplicated tables/prose (vs reusing existing sections) | 🟡 (🟠 if it balloons, e.g. +20%) |
| 5 | A **new unbounded agent loop** or many round-trips where one tightly-scoped turn would do (ties to the §4.6 bounded-loop check) | 🟠 |

### 4.8.2 Bash spot-check

```bash
# 1 — caps unchanged from baseline. Expect: 2000 / 3 / 200. A higher
#     number (or a missing line) is a regression — eyeball the diff.
grep -nE "HTML_TRUNCATE|NEARBY_LEVELS|NEARBY_TEXT_MAX" extension/src/content/capture.ts

# 1b — did THIS branch touch those caps? Any hit here → inspect closely.
git diff main...HEAD -- extension/src/content/capture.ts \
  | grep -E "^\+.*(HTML_TRUNCATE|NEARBY_LEVELS|NEARBY_TEXT_MAX)" || echo "  (caps untouched)"

# 4 — SKILL.md prompt-size delta vs main. A big +N is a per-run token tax.
base=$(git show main:skill/pinta/SKILL.md 2>/dev/null | wc -l); head=$(wc -l < skill/pinta/SKILL.md)
echo "SKILL.md: main=$base  branch=$head  delta=$((head - base)) lines"

# 3 — no new raw-PNG / un-resized image path to the agent in the diff.
git diff main...HEAD -- extension/src \
  | grep -E "^\+.*(toDataURL\(.image/png|image/png)" || echo "  (no new PNG-to-agent path)"

# 5 — no new unbounded loop language re-introduced (mirrors §4.6 check 3).
grep -c "Loop indefinitely. Don't stop on your own" skill/pinta/SKILL.md   # MUST be 0
```

### 4.8.3 Severity + what NOT to flag

- Treat the table's severities as written; **a removed cap (unbounded
  page-text collection) is 🔴** — it's both a token blowup and a privacy
  leak.
- **Don't** flag the existing `<all_urls>` / screenshot / outerHTML
  capture *baseline* — only a diff that makes them bigger. A feature that
  *reduces* payload (tighter cap, lazy field, JPEG downscale) is the goal,
  not a finding.
- **Don't** flag SKILL.md growth that's genuinely new capability with no
  cheaper encoding — note it 🟡 so the user is aware of the per-run cost,
  but it's shippable. The target is "no *gratuitous* bloat," not "never
  add instructions."
- A dev-only / test-only payload (fixtures, `*.test.ts`) never reaches a
  real agent run — out of scope.

## 5. Run `/spec`

Independent of audit — invoke unconditionally (you want to know about
spec drift even if the audit already caught the same code path from a
different angle):

```
Skill(skill="spec")
```

Capture verbatim.

## 6. Roll up

Merge findings from steps 2, 3, 4, 4.5, 4.6, 4.7, 4.8, and 5 into a
single severity-grouped table. Drop duplicates (audit and spec both
flagging the same issue gets listed once, with attributions in parens):

```
🔴 CRITICAL — must fix before deploy
  • [audit]       <finding>
  • [svelte]      <finding from svelte-autofixer>
  • [supply-chain] <critical CVE in dep>
  • [keybindings] <missing binding-site or unguarded form-field intercept>
  • [compliance]  <credential proxy / Agent-SDK / headless claude path — Anthropic ban risk>
  • [ext-policy]  <MV3 downgrade / remote code / loosened CSP — CWS auto-reject>
  • [token]       <a payload cap removed entirely — unbounded page-text to the agent>
  • [spec]        <finding>
  • [audit + spec] <finding flagged by both>

🟠 IMPORTANT — should fix or knowingly accept
  • [audit]       <finding>
  • [svelte]      <finding>
  • [supply-chain] <high CVE in dep>
  • [keybindings] <Settings/docs mismatch with implementation>
  • [compliance]  <bounded-loop / compliance-declaration regression in SKILL.md>
  • [ext-policy]  <new permission past baseline / missing privacy disclosure>
  • [token]       <raised cap / new always-on heavy field / raw PNG to agent / new unbounded loop>
  • [spec]        <finding>

🟡 NICE TO FIX — defer if pressed for time
  • [keybindings] <docs page lagging Settings copy>
  • [ext-policy]  <cosmetic single-purpose description drift>
  • [token]       <materially larger SKILL.md — per-run prompt tax>
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
  mismatch, audit P0 security finding, **any 🔴 `[compliance]` finding
  (credential proxying / Agent-SDK / headless `claude` path — moves
  Pinta into Anthropic's banned third-party-tool lane)**, **any 🔴
  `[ext-policy]` finding (MV3 downgrade / remotely hosted code /
  loosened CSP — an automatic Chrome Web Store rejection)**, **any 🔴
  `[token]` finding (a removed payload cap — unbounded page-text to the
  agent, both a token blowup and a privacy leak)**, missing
  release artifact (unbumped version, `## Unreleased` heading still
  present, etc.).

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
