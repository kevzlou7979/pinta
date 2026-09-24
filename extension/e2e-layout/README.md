# e2e-layout — real-Chromium layout regression harness

Guards the Settings → Modules toggle scroll bug: clicking or tabbing to a
module toggle must never scroll the side-panel shell (header shoved off-screen,
dead empty area below). happy-dom has no layout, so this runs headless Chromium.

## What it does

- Builds a small page (`index.html` + `main.ts`) with Vite. It mounts the
  **real** `src/sidepanel/SettingsPanel.svelte` inside `Shell.svelte`, a copy
  of the App shell classes (`overflow-clip` root > `shrink-0` header >
  `flex-1 relative flex flex-col min-h-0` body > scrolling `<main>` + absolute FAB).
  A `window.chrome` stub is defined before the module script; `fetch` is stubbed offline.
- Serves the build over a throwaway `127.0.0.1` HTTP server (file:// blocks module scripts).
- At 420 × {480, 560, 700, 900}: opens **Modules**, scrolls `<main>` to the bottom,
  then for Chat, Report, Devices, Code Review, Test Pilot scrolls `<main>` (only) so
  the card is visible and raw-mouse-clicks the toggle. Then Tab-presses 30× from the
  Modules header.
- After every step it asserts: shell root `scrollTop === 0`,
  `document.scrollingElement.scrollTop === 0`, header `getBoundingClientRect().top === 0`,
  `<main>` bottom flush with the viewport, and a focused toggle input lies inside
  `<main>`'s scrollport. It also checks each click actually flipped the toggle and
  that ≥3 toggle inputs were reached by Tab.

## Negative control

`Shell.hidden.svelte` (`?variant=control`) simulates the pre-fix panel: root
`overflow-hidden` plus a runtime rule `label.relative{position:static!important}`.
With `--control`, the run succeeds only if the real shell PASSES **and** the
control FAILS — proof the harness can see the bug.
`--matrix` adds informational rows for each half of the fix alone
(`clip-only`: real root, pre-fix labels; `rel-only`: pre-fix root, real labels).

## Run (from `extension/`)

```sh
node e2e-layout/run.cjs --control            # build + real + control
node e2e-layout/run.cjs --matrix             # + per-fix diagnostic rows
node e2e-layout/run.cjs --no-build           # reuse the last build
node e2e-layout/run.cjs --out <dist> --shots <dir>
```

Default dist: `$E2E_LAYOUT_OUT` or `<os tmp>/pinta-e2e-layout-dist` (outside the
repo); screenshots go next to it in `e2e-layout-shots/`. Playwright is loaded from
`C:/rnd/puwersa/node_modules/playwright`, then `playwright` / `@playwright/test`.
Exit code: 0 pass, 1 assertion failure, 2 harness error.

Keep `Shell.svelte` in sync with the shell in `src/sidepanel/App.svelte` — the
harness only proves something while the two match.
