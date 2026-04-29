---
name: test
description: Use when the user wants to run the Pinta test suite (Vitest) — runs unit tests for the Chrome extension and companion server. Accepts an optional workspace name (`extension` or `companion`) to scope the run; defaults to running both.
---

# test

Runs the Vitest suites for Pinta. Two workspaces have tests today:

- `extension` — pure-logic unit tests under `extension/src/**/*.test.ts`
- `companion` — Node-side unit tests under `companion/src/**/*.test.ts`

## 1. Sanity check the working directory

```bash
test -f package.json && grep -q '"name": "pinta"' package.json && echo "OK in pinta repo" || { echo "ERROR: run /test from the pinta repo root"; exit 1; }
```

If that fails, ask the user to `cd` into their pinta clone and re-invoke.

## 2. Pick the scope

Look at the user's argument to `/test`:

- `/test` (no arg) — run every workspace's tests via `npm test` at the
  repo root.
- `/test extension` — run just the extension suite.
- `/test companion` — run just the companion suite.
- `/test <pattern>` — anything else: pass the argument through as a
  Vitest file/test filter to the root run, e.g.
  `npm test -- <pattern>`. (Vitest treats positional args as a file
  name regex.)

## 3. Run

Default (both workspaces):

```bash
npm test
```

Single workspace:

```bash
npm run test --workspace @pinta/extension     # or
npm run test --workspace pinta-companion
```

With a filter (forwarded to Vitest in every workspace that has a
`test` script):

```bash
npm test -- url-patterns
```

Watch mode is intentionally NOT exposed through `/test` — it would
hang the agent. If the user asks to watch, tell them to run
`npm run test:watch --workspace @pinta/extension` (or the companion
equivalent) themselves in a separate terminal.

## 4. Report

- On success: report total file + test counts per workspace
  (Vitest prints a summary like `Test Files  1 passed (1)` /
  `Tests  14 passed (14)`).
- On failure: surface the first failing test's name, file, and the
  assertion error. Don't try to fix the failure — just report it
  unless the user asks for a fix.

## Notes

- Vitest config lives at `extension/vitest.config.ts` and
  `companion/vitest.config.ts`. Both currently use the `node`
  environment. If we add Svelte component tests later, the extension
  config will need `environment: "jsdom"` and the
  `@sveltejs/vite-plugin-svelte` plugin.
- The extension's `vitest.config.ts` is intentionally separate from
  `vite.config.ts` because the CRX plugin in the latter requires a
  manifest entry that breaks under Vitest's loader.
- If the user adds tests in `shared/`, `adapters/`, or `skill/`,
  those workspaces would also need a `test` script and a
  `vitest.config.ts` before `npm test` will pick them up.
