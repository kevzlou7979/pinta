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
3. **`/spec`** — gaps between `spec/SPEC.md` and shipped code.

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

## 3. Run `/spec`

Independent of audit — invoke unconditionally (you want to know about
spec drift even if the audit already caught the same code path from a
different angle):

```
Skill(skill="spec")
```

Capture verbatim.

## 4. Roll up

Merge findings from steps 2 + 3 into a single severity-grouped table.
Drop duplicates (audit and spec both flagging the same issue gets
listed once, with both attributions in parens):

```
🔴 CRITICAL — must fix before deploy
  • [audit] <finding>
  • [spec]  <finding>
  • [audit + spec] <finding flagged by both>

🟠 IMPORTANT — should fix or knowingly accept
  • [audit] <finding>
  • [spec]  <finding>

🟡 NICE TO FIX — defer if pressed for time
  • [spec] <finding>
```

Then a separate **Tests** line stating the pass count from step 1
(e.g. `✅ Tests: 6 + 14 passing across companion + extension`).

## 5. Final verdict

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

## 6. After the report

Don't auto-fix anything. `/staging` is a decision tool, not an action
tool. Two follow-ups the user might invoke:

- "fix the criticals" → start working through the 🔴 list.
- "ship it anyway" → that's their call; acknowledge and stop.

## Notes

- Run-time budget: roughly 30–90s wall clock depending on how
  recently the codebase was scanned. /test is sub-second; /audit
  fetches Svelte docs (skippable in offline mode); /spec walks
  ~800 lines of spec + cross-references.
- If any sub-skill is missing on disk (`.claude/skills/<name>/SKILL.md`
  not present), STOP and tell the user which one is missing — don't
  silently skip it. The whole point of /staging is unified coverage.
- Don't run `/staging` inside `/staging` (no recursion). If the user
  re-invokes, treat it as "rerun" and start fresh from step 0.
- Use the Skill tool to invoke each sub-skill — do NOT cargo-cult
  their output by re-running their bash steps inline. The skills are
  the contract.
