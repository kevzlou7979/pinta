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

## Test Pilot .docx import (`docx-import.cjs`)

Regression for "a sheet that came back from Google Drive as .docx can't be
imported". Mounts the real `TestPilotTab` (standalone, `?variant=test-pilot`),
picks .docx files through the tab's own file input, and asserts what the user
ends up with:

- a Google-Drive-converted sheet: doc-id recovered from the envelope Google
  Docs mangles, title / author / sections, Pass / Fail marks, numbered steps,
  the on-screen tally, the `.md.docx` → `.md` name;
- Pinta's own results .docx overlays the catalog it came from (imported-run
  banner, identity and steps kept) instead of replacing it;
- a plain Word sheet over a catalog with marks asks "Replace test catalog?"
  (Cancel keeps everything, Replace adopts it);
- an unreadable .docx, and a Word plan with no test rows, each show a named,
  dismissible error and load nothing.

`npm run test:e2e` runs this after the layout harness.

```bash
node e2e-layout/docx-import.cjs            # build + run
node e2e-layout/docx-import.cjs --no-build # reuse the last build
```

Unit coverage for the converter itself: `src/lib/docx-to-md.test.ts`.

## saved-sheets.cjs — standalone saved sheets (real IndexedDB)

Standalone Test Pilot keeps several tester sheets side by side: the open one in
the standalone slot, the rest in IndexedDB (`pinta-standalone` / `test_sheets`).
The component suite uses an in-memory shelf, so this script is what exercises the
real store. It imports two sheets through the tab's own file input, marks tests
and writes a failure note, switches from the popover beside the title, checks the
popover stays inside the 420px panel, reloads the page and reopens the saved
sheet from the empty screen, then deletes one.

```sh
node e2e-layout/saved-sheets.cjs            # build + run
node e2e-layout/saved-sheets.cjs --no-build # reuse the last build
```

## variants-count.cjs — Design Variants count

Regression for "I asked for 5 variants and got 3". Mounts the real
`DesignVariantsTab` (`?variant=design-variants`) and plays the companion: it
captures what the tab sends and answers as the agent. Asserts the query carries
the selected `count` even when the direction box names another number, that a
short run (3 of 5) shows the "You asked for 5, the agent returned 3" notice
inside the 420px panel, and that a full run shows none.

The agent's half of the fix is the `count` rule in SKILL.md §7.16 — not
something a browser can drive.

```sh
node e2e-layout/variants-count.cjs            # build + run
node e2e-layout/variants-count.cjs --no-build # reuse the last build
```

## resubmit-skipped.cjs — annotations the agent skipped

Regression for "some annotations came back with an empty dot". An agent can
close a batch after applying only some of its cards. Mounts the whole side
panel (`?variant=app`), seeds the Submitted tray and plays the companion.
Asserts skipped cards say "Not applied" and carry a resubmit icon; that the
icon copies the card into the draft with a fresh id and no status, relabels
the send button to "Resubmit" and turns the card to "In draft" (then
"Resubmitted" once sent); and that applied cards, cards still in progress and
file-only batches are left alone.

The companion's half (a warning to the agent that closed the batch early) is
covered by `companion/src/skipped-annotations.test.ts`.

```sh
node e2e-layout/resubmit-skipped.cjs            # build + run
node e2e-layout/resubmit-skipped.cjs --no-build # reuse the last build
```

## processing-pulse.cjs — the page-edge processing pulse

Regression for "the processing pulse never shows". The panel used to follow
only the live draft's status, which is never pending now that a sent batch
detaches into the Submitted tray, and module runs never touched it. Mounts the
whole side panel (`?variant=app`) on a stub tab (`window.__tabs`) and reads the
messages it sends to the page (`window.__tabMessages`): `processing.start` in
the chosen colour for a sent batch and for AuditFlow, Report, Design Variants,
Test Pilot, Code Review and chat runs; one pulse for overlapping runs; a re-send
after the page reloads (`overlay.ready`); the setting toggling it mid-run; a tab
switch moving it; `processing.end` when the last run finishes.

`src/sidepanel/agent-busy.repro.test.ts` covers every wait behind
`app.agentBusy`, the flag the pulse follows.

```sh
node e2e-layout/processing-pulse.cjs            # build + run
node e2e-layout/processing-pulse.cjs --no-build # reuse the last build
```

## devices-pulse.cjs — the processing pulse on the Devices canvas

Regression for "when annotating multiple devices only the last is pulsating".
Every device frame's Pinta overlay is hidden unless that frame is the one being
annotated, so a pulse sent to the annotating frame lit one device only. The
canvas now paints the glow on every device itself.

- Canvas half (`?variant=devices`, `window.__currentTab` = its tab): every
  device glows on `devices.processing`, in the chosen colour, without blocking
  clicks; a message for another tab is ignored; the glow is gated on
  `panel.state` (a closed panel can never end it); a device added mid-run glows.
- Panel half (`?variant=app` on a canvas tab, `window.__extRoot` plays the
  extension origin): the panel tells the canvas over chrome.runtime and sends no
  frame a page pulse; a reloaded canvas (`devices.canvas-ready`) is told again;
  switching to a normal tab ends the canvas glow and starts the page one.

```sh
node e2e-layout/devices-pulse.cjs            # build + run
node e2e-layout/devices-pulse.cjs --no-build # reuse the last build
```

## devices-frames.cjs — annotating across several devices

Regression for the Devices QA audit (2026-10-14): the panel only knew the
device it was annotating in right now. Three halves:

- Panel (`?variant=app` on a canvas tab, playing a Mobile frame = frameId 3
  and an iPad frame = frameId 5; the stub records each send's `frameId`):
  deleting a card sends `annotated.remove` to both frames, Redo re-applies
  in Mobile only, Send to agent clears both; the iPad frame replays only the
  iPad pin and a keep-alive `ping` replays nothing; an imported session is
  re-sent to the frame that takes over; "Open" on another page asks the
  canvas (`devices.open-url`) and never navigates the tab; a manual task
  gets the frame's width (no answer = no viewport); a cut-off device shot
  shows a notice; a finished batch asks the frame for HMR (`frame.hmr`) and
  reloads the devices (`devices.refresh-all`), never the tab;
  `devices.annotate-frame`, a send to a gone frame and `devices.canvas-ready`
  each end "Device frame connected". Adding annotations replays only the
  annotating device's pins; frames are remembered per tab, so after leaving
  the canvas and coming back undo/redo still reach Mobile (a merged Free
  Transform too); redo skips a source frame that navigated away and falls
  back to the annotating frame only on the same width and page; Reload
  drops the old frame ids; no HMR answer from any device = no auto-reload.
- Normal tab (`?variant=app` on an http tab): remove and Clear all stay
  plain tab-wide sends, "Open" calls `tabs.update`, a finished batch without
  HMR calls `tabs.reload`, a manual task takes the page's width.
- Canvas (`?variant=devices`): removing the annotating device tells the
  panel; the screenshot rect carries the scroll surface below the toolbar
  and raises the device; `devices.refresh-all` / `devices.open-url` act on
  the devices (open-url from a content script is ignored, and "Open" on the
  URL already shown still brings every device back); a typed custom size
  says "custom size", not "removed"; a frame on a slow
  server (`/slow.html`) is not reloaded mid-load, only 2.5s after it loads.
- Overlay (`?variant=overlay` inside `/frame-host.html`, activated with the
  canvas's `pinta-annotate` ping): `overlay.ready` carries the width and
  marks the keep-alive as a ping; `frame.hmr` answers; `annotated.remove`,
  `annotated.clear` and `annotated.reapply` work in an inactive frame while
  other messages are ignored; going inactive drops an imported overlay and
  restores a variant preview (telling the panel).

Unit coverage: `src/lib/devices-frame.test.ts` (crop to the scroll surface,
`onDeviceShot`, `isDeadFrameError`) and `src/lib/composite.test.ts` (the
device shot paints only included annotations, keeping global numbers).

```sh
node e2e-layout/devices-frames.cjs            # build + run
node e2e-layout/devices-frames.cjs --no-build # reuse the last build
```

## motion.cjs — Motion module (Phase 25)

Two halves. The panel (`?variant=motion`: the whole side panel with Motion
on): every message sent to "the tab" is captured, and the page's replies
(`motion.picked` / `rehearse-ready` / `tick` / `finished` / `rehearse-failed`)
are delivered through the panel's own `chrome.runtime.onMessage` listener with a
`sender.tab.id`. Asserts the pick → rank → rehearse → scrub / speed / loop
state machine, the re-arm on token and reduced changes, the leave-tab cleanup,
the error banner, and that a message from another tab id changes nothing. The
runner (`?variant=motion-runner`): `src/content/motion-run.ts` on a fixture DOM
in real Chromium — jsdom has no `Element.animate`. Asserts timeline length,
play / reverse / seek / setRate / stop, the stagger clamp and per-child delays,
count-up text + `aria-hidden` restore (including a run started mid-frame), and
the reduced-motion plan.

```sh
node e2e-layout/motion.cjs            # build + run
node e2e-layout/motion.cjs --no-build # reuse the last build
```

## report-owner.cjs — Report: declare the owner

Regression for the owner setting. Mounts the whole side panel with Report
on (`?variant=report`) at 380 × 760 (one pass at 600 wide) and plays the
companion: captures `module.query.submit` and answers as the agent through
`__app.onMessage`. Asserts the owner line ("Owner" + "All committers"),
the gear → "Report settings" dialog and its Owner copy, add (Enter and
Add) / remove, normalization and every refusal (repeat, too short,
flag-like, empty, the 5 cap with the input disabled), persistence under
`pinta-report-owners` (and sanitizing a tampered blob), `author` /
`authors` on the query (one owner = `author` only), the stamp on the
finished run, the stale flag + regenerate, the "This report covers only …"
mismatch banner with its ✕, the markdown export's owner line, and a
pending run with no `authors` (the loading-states walk) with no page error.

```sh
node e2e-layout/report-owner.cjs            # build + run
node e2e-layout/report-owner.cjs --no-build # reuse the last build
```

`npm run test:e2e` runs all the scripts above.
