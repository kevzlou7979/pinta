---
name: spec
description: Use when the user wants to find gaps between Pinta's design spec and the actual codebase before a release. Walks every section of `spec/SPEC.md`, verifies each requirement against the current `extension/`, `companion/`, and `skill/` source, and produces a prioritized punch list of: (a) spec items not implemented, (b) spec sections out of date with shipped code, (c) phases marked Shipped that aren't actually complete, (d) wire-protocol drift between extension and companion, (e) docs (README/CHANGELOG) out of sync. Recommended before cutting any version tag.
---

# /spec

Audit `spec/SPEC.md` against the actual codebase. Output a tight gaps
report grouped by severity, with file:line refs and concrete remediations.
The bar is "does the running code match what the spec says ships?" — not
"is the spec well-written".

## 0. Sanity check

You're auditing **the Pinta repo at `C:/rnd/ux-design-app/`**. The spec
lives at `spec/SPEC.md`; the code lives in three workspaces:

```
extension/         Chrome MV3 extension (Svelte 5 + CRXJS + Tailwind)
  src/background/  service-worker.ts, screenshot.ts
  src/content/     overlay.ts, Overlay.svelte, Canvas.svelte,
                   ElementEditor.svelte, capture.ts, selector.ts,
                   tools/draw.ts, state.svelte.ts
  src/lib/         state.svelte.ts, ws-client.ts, companions.ts,
                   composite.ts, local-store.ts, url-patterns.ts,
                   format-clipboard.ts, theme.svelte.ts
  src/popup/       Popup.svelte
  src/sidepanel/   App.svelte, AnnotationCard.svelte, SessionHistory.svelte
companion/         Node server (HTTP + WebSocket + SSE + MCP)
  src/             cli.ts, server.ts, store.ts, registry.ts,
                   project-config.ts, mcp-stdio.ts, mcp/*
shared/            TS types (Annotation, Session, ClientMessage, ...)
skill/pinta/       Claude Code skill bits (SKILL.md, find-companion.js,
                   start-companion.js)
```

If a finding doesn't apply to one of these, drop it.

## 1. Walk the spec section by section

`spec/SPEC.md` has these top-level sections — work each one in order:

| § | Section | What to verify |
|---|---|---|
| 1 | Problem | (informational — no code check) |
| 2 | Goals & non-goals | Does any *non-goal* leak into shipped code? (e.g. mobile, multi-user, prod-site features) |
| 3 | System overview | Are the four components present (extension, companion, agent, optional Vite plugin)? Is the WS+HTTP+MCP topology accurate? |
| 4 | Core concepts | `Annotation` / `Session` / `Adapter` shapes match `shared/src/types.ts`? Field names, optionality, types? |
| 5 | Workflow (end-to-end) | Each step in the workflow is implementable in current code? Trace one annotation from click → companion → agent. |
| 6.1 | Chrome Extension | Side panel, content overlay, drawing tools, element selector, hotkeys — all present? Hotkey list in spec matches `Overlay.svelte` / `App.svelte` actual bindings? |
| 6.2 | Companion Server | Every documented HTTP endpoint exists in `server.ts`? Status codes + payload shapes? Long-poll semantics? |
| 6.3 | Adapters | Claude Code skill (`skill/pinta/`), Cursor MCP config snippet, Aider script — all present and current? |
| 6.4 | Vite plugin | Implemented at all? Marked optional? |
| 7 | Data flow examples | Sample payloads in spec parse against the current `Session`/`Annotation` types? |
| 8 | Phased build plan | Each Phase header marked "Shipped"/"Planned" — does the code agree? Specifically check Phases 7, 8, 9 (the ones we've actively touched). |
| 9 | Open questions | Any have been answered in code but not closed in spec? |
| 10 | Risks | Any risk now realized as a bug we're tracking? |
| 11 | Success criteria | Can the criteria currently be met (drawing → submit → 60s edit, etc.)? |
| 12 | Tech choices | Listed deps actually in `package.json` of each workspace? Versions sane? |

## 2. Wire-protocol drift check

The most expensive bug class is extension and companion disagreeing on
message shapes. Specifically check:

1. **`shared/src/types.ts`** — `ClientMessage` and `ServerMessage`
   discriminated unions. Every variant the extension sends must be
   handled by `companion/src/server.ts` / `companion/src/store.ts`. Every
   variant the companion broadcasts must be handled by
   `extension/src/lib/state.svelte.ts` `onMessage`.
2. **HTTP endpoints** — every `POST /v1/*` documented in spec §6.2 must
   exist in `server.ts`; every endpoint in `server.ts` must be
   documented (or deliberately undocumented for testing).
3. **Annotation shape** — spec §4 lists fields. Every documented field
   exists on `Annotation` in `shared/src/types.ts`. Every field on the
   type is documented (or has a `// internal` comment justifying it).

Report any drift as `🔴 Wire drift` regardless of severity — it's the
class of bug agents and extensions catch worst.

## 3. Phase reality check

For each phase in spec §8, the spec marks it "Shipped" or "Planned".
Verify by grepping for the named files / features:

- **Phase 7 (Polish)** — hotkeys, session history, .pinta.json, copy-to-clipboard, multi-project, dark mode, HMR auto-reload, pin badges, cancel-session. Each of these has a specific file the spec hints at.
- **Phase 8 (Inline editing)** — 8a (7-tab editor), 8b (live preview), 8c (image attachments). Verify in `ElementEditor.svelte` + `Overlay.svelte`.
- **Phase 9 (Protocol & coordination)** — SSE push, per-annotation status, multi-project, first-claim-wins, screenshot extraction. Verify `companion/src/store.ts` (claim semantics), `companion/src/registry.ts` (multi-project), and `companion/src/server.ts` (SSE).

If a phase says "Shipped" but the code only half-implements it, report
🟠 Phase drift.

## 4. Docs sync

- **`README.md`** — does the "What's new" / capability table reflect the
  actual current state? Any feature shipped post-README that needs a
  mention?
- **`CHANGELOG.md`** — any `## Unreleased` section needs to be cut
  before the next release. Anything shipped since the last released
  version must be listed.
- **`spec/SPEC.md`** — does §8 / §9 reflect what's actually shipped?

## 5. Output format

Group findings by severity. Use `file:line` refs (verified via Read or
Grep — don't guess line numbers). Keep each finding to ~3 lines.

```
🔴 CRITICAL — must fix before release
  • [Wire drift] companion/src/server.ts:142 — POST /v1/sessions/ingest
    is documented in spec §6.2 but not present. Extension's
    standalone-bundle export (extension/src/sidepanel/App.svelte:308)
    posts to it; will 404 once shipped.
    Fix: add the route, or remove from spec.

🟠 IMPORTANT — should fix or knowingly accept
  • [Phase drift] spec/SPEC.md:497 — Phase 8b marked Shipped but
    cumulative preview rollback (extension/src/content/Overlay.svelte
    `restoreFromSnapshot`) doesn't handle... [etc]

🟡 NICE TO FIX — defer if pressed for time
  • [Doc sync] README.md doesn't mention standalone mode (introduced
    by extension/src/lib/local-store.ts). One-line addition under
    "What's new".
```

Then a final **Release readiness verdict**:
- ✅ ship as-is
- ⚠️ fix the 🔴s and ship
- 🛑 hold the release; meaningful gaps remain

## 6. What NOT to flag

Skip these — they waste reader attention:

- TypeScript strictness warnings (Svelte's `state_referenced_locally`,
  a11y autofocus). They're style, not gaps.
- Pre-existing `// TODO:` comments unless they correspond to a spec
  promise.
- Comment-style nits in the spec itself.
- Unimplemented v1.x features that are explicitly *not* in the spec
  (use the spec as the contract, not your own wishlist).

## 7. After producing the report

Don't auto-fix anything. The user uses this as a release-decision tool;
they'll triage which findings to act on.

If the user immediately says "fix the criticals", then proceed —
otherwise return the report and stop.
