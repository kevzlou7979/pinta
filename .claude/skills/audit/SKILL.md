---
name: audit
description: Use when the user wants a security + performance audit of the Pinta Chrome extension. Walks the manifest, content scripts, service worker, message passing, WebSocket / HTTP layer, IndexedDB store, composite + screenshot pipeline, and Svelte 5 runes usage; produces a prioritized findings list with file:line refs and concrete fixes.
---

# /audit

Audit the Pinta Chrome extension (`extension/`) for security and
performance regressions. Output a tight findings report — severity, what,
where (file:line), why it matters, and the concrete fix. Skip nitpicks
that don't change behavior or cost.

## 0. Sanity check

You're auditing **Pinta's Chrome extension**, not the companion or the
landing page. The relevant tree is `extension/src/`:

```
background/    service-worker.ts, screenshot.ts
content/       overlay.ts (entry), Overlay.svelte, selector.ts,
               capture.ts, Canvas.svelte, ElementEditor.svelte,
               CommentInput.svelte, tools/draw.ts, state.svelte.ts
lib/           state.svelte.ts, ws-client.ts, companions.ts,
               composite.ts, local-store.ts, url-patterns.ts,
               theme.svelte.ts, format-clipboard.ts
popup/         Popup.svelte + index.html
sidepanel/     App.svelte, AnnotationCard.svelte, SessionHistory.svelte,
               StatusPill.svelte, index.html
styles/        app.css
manifest.config.ts
tailwind.config.js
vite.config.ts
```

If a finding doesn't apply to the extension, drop it.

## 1. Auto-load Svelte 5 conventions

Before reviewing reactivity / runes / `$effect` usage, fetch Svelte's
official AI guidance so your review aligns with current Svelte 5 idiom:

```
WebFetch https://svelte.dev/docs/ai/overview
WebFetch https://svelte.dev/llms-medium.txt   (optional, large)
```

Pay attention to:

- `$state`, `$derived`, `$effect`, `$props`, `$bindable` semantics.
- Cleanup functions returned from `$effect` callbacks.
- `mount()` vs `new Component()` for Svelte 5.
- When `{@html …}` is acceptable (constant data only, never user input).

## 2. Security review checklist

Walk each item. For every hit, write a finding (`S<n>`) with severity
**critical / high / medium / low**.

### 2.1 Manifest surface (`manifest.config.ts`)

- `permissions` and `host_permissions` — flag anything wider than required.
  `<all_urls>` is justified by the product but should be disclosed in the
  store listing.
- `content_scripts.matches` — confirm `<all_urls>` and that there's a
  user-controlled opt-out at runtime if needed.
- `web_accessible_resources` — anything exposed should not leak data.
- `content_security_policy` — MV3 default is `script-src 'self'; object-src 'self'`.
  Note any extensions that loosen it, especially `unsafe-eval` / `unsafe-inline`.

### 2.2 Content script + Shadow DOM (`content/`)

- `overlay.ts` — Shadow DOM isolation is mandatory; any `appendChild` to
  `document.body` instead of the shadow root is a leak.
- Event-trapping list (`mousedown / pointerdown / focusin` etc.): make
  sure host-page handlers can't see synthetic events that originated
  inside Pinta.
- Any `innerHTML` on an element under the host page → flag.
- `selector.ts` `escape()` fallback: confirm CSS.escape is preferred and
  the fallback only escapes non-`[\w-]` chars.
- `capture.ts` `outerHTML` truncation (`HTML_TRUNCATE`) — must be enforced;
  oversized HTML risks performance + privacy bleed.
- `nearbyText` collection — bound depth (`NEARBY_LEVELS`) and length per
  level (`NEARBY_TEXT_MAX`). No unbounded walk.

### 2.3 Service worker + screenshots (`background/`)

- `chrome.scripting.executeScript` — every call must pass typed args, not
  string-template a function body. Inspect every `func:` callsite.
- `chrome.tabs.captureVisibleTab` rate limit (2/s) → must be respected,
  else you flood the tab. `SETTLE_MS = 600` covers it.
- The bitmap-stitch step in `stitch()` keeps every viewport bitmap in
  memory simultaneously. Long pages (>20 viewports) can OOM the worker.
- `OffscreenCanvas` → `convertToBlob({ type: "image/png" })` — flag if PNG
  is not necessary (JPEG would shrink payload by 5–10×).

### 2.4 Message passing (`onMessage` listeners)

- Every `chrome.runtime.onMessage` handler should validate `msg.type`
  with a string equality and **discriminate** on it before reading other
  fields. Anything that runs `.executeScript` or fetches secrets without
  type-checking the message → critical.
- Origin check: only accept messages from the extension's own
  pages/content scripts. Verify `sender.id === chrome.runtime.id` (or
  rely on Chrome's default behavior — the API only delivers same-extension
  messages). If `externally_connectable` is set in the manifest, this
  becomes load-bearing.

### 2.5 WebSocket / HTTP to companion (`lib/ws-client.ts`, `lib/companions.ts`)

- Endpoint `127.0.0.1` only — flag any `0.0.0.0` or LAN-IP.
- `JSON.parse(event.data)` — must be wrapped in try/catch (it is).
- Reconnect backoff — must be capped (it is, at 30s).
- `discoverCompanions` probes ports 7878–7898. Flag if the range grows or
  the timeout (`PROBE_TIMEOUT_MS`) is removed — closed ports must not
  hang the discovery.
- Per-probe `AbortController` — must be used so a slow port doesn't
  block the whole scan.
- No auth on companion calls — acceptable for localhost-only, but flag
  if the extension ever fetches non-localhost URLs.

### 2.6 IndexedDB / localStorage (`lib/local-store.ts`, `lib/theme.svelte.ts`)

- Only write to IDB / localStorage; never `eval` data read out.
- Quota errors must be handled (try/catch around `transaction`/`put`).
- Theme is non-sensitive; sessions in IDB include outerHTML + screenshots.
  Confirm there is **no** sync to remote storage.

### 2.7 Svelte template injection

- `{@html …}` callsites — every one must be bound to a constant, not to
  user input. The `TOOLS` SVG strings are fine (constants); flag any
  others.
- Reactive `bind:value` on inputs whose value flows into a `<pre>` or
  `<code>` — Svelte escapes by default, but if the value is later passed
  to `innerHTML` or `dangerouslySetInnerHTML` equivalents, that's bad.

### 2.8 Third-party resources (HTML entries)

- Each `<link href="https://fonts.googleapis.com/...">` is an external
  resource fetched at runtime under the extension's origin. Flag if any
  endpoint isn't fonts.googleapis.com / fonts.gstatic.com.
- `integrity="sha384-..."` — recommend on long-lived external CSS/JS.

### 2.9 Data exfiltration paths

- Build a mental model: an annotated session contains
  - selector (low risk)
  - `outerHTML` truncated to 2KB (medium risk — may include tokens in
    attrs/inline scripts)
  - `nearbyText` (medium risk — may include PII)
  - composited screenshot (medium risk — visible page state)
  - the user's free-form comment (low risk).

  Confirm there is no path that ships these to any non-localhost
  endpoint.

## 3. Performance review checklist

For each, write a finding (`P<n>`) with severity **high / medium / low**.

### 3.1 Service-worker memory

- Long-page screenshot stitch (`stitch()`): bitmaps are held in an array
  until composite finishes. Flag if there's any way to release earlier
  (process+release per slice, then concat blobs).
- The 30s service-worker idle-kill in MV3 — long stitches can race it.
  Capture timing should be < 25s for a "tall" page.

### 3.2 Companion discovery

- 21 ports × `PROBE_TIMEOUT_MS` (250ms) = up to 5.25s wall-clock if every
  port hangs at the limit. Closed ports respond instantly; open
  non-Pinta services don't. The current parallel scan is correct — flag
  if it goes serial.
- `app.rescan()` runs on every tab activation + URL change. Flag if it
  re-discovers when the active companion's URL still matches.

### 3.3 Reactivity / Svelte 5

- `$derived` chains that recompute on every keystroke (`canSubmit`,
  `hasDrawingAnnotation`, `matchesSelected`) should depend on the
  smallest possible inputs.
- `$effect` callbacks should return cleanup functions where they
  subscribe to anything.
- `bind:value` on a `<textarea>` inside an `{#each}` block over many
  annotations — every keystroke triggers re-derivation; for V1 it's fine
  but flag at 100+ annotations.

### 3.4 Network / payload size

- `composite.ts` outputs PNG via `canvas.toDataURL("image/png")`. PNGs
  for full-page screenshots can be 1–5 MB. JPEG q=85 is usually
  acceptable and ~10× smaller. Flag the choice.
- Annotations with `images: AnnotationImage[]` ship base64 to the
  companion over WS. Confirm there's a per-image size cap.

### 3.5 Bundle size

- Run the build and inspect `extension/dist/assets/*.js`:

  ```bash
  npm run build --workspace @pinta/extension 2>&1 | tail -30
  ```

  Flag any chunk > 50 KB (gzip) for the popup or sidepanel; > 20 KB for
  the content script. The sidepanel is allowed to be heavier than the
  content script.
- If `fflate` (zip lib) is bundled into the content script chunk, it
  should be lazy-imported only inside the bundle export path.

### 3.6 Main-thread blocking

- `composite.ts loadImage()` decodes via `HTMLImageElement` on the side
  panel main thread. Acceptable for a single-shot composite; flag if
  multiple are queued without yielding.
- Per-pixel reads of large bitmaps → must use OffscreenCanvas worker.

## 4. Output format

Produce one `## Findings` section, then a per-finding block. Example:

```
### S2. medium — outerHTML may carry secrets in attributes
**Where**: extension/src/content/capture.ts:35
**What**: `el.outerHTML` is captured up to 2 KB and shipped with the
session. Pages with bearer tokens or auth URLs in inline `<script>` or
`<meta>` attrs near the selected element will leak them to the agent.
**Why**: the agent is the user's own tool, but logs / history files
broaden the blast radius. Out-of-scope for normal use, in-scope for
sensitive enterprise dashboards.
**Fix**: Strip attributes from a denylist (`integrity`, `csp-nonce`,
inline `on*=` handlers, anything matching `/token|auth|secret|key/i`)
before serialization, OR add a per-project setting to disable outerHTML
capture.
```

End with a one-line **summary**: top 3 must-fix items. Skip filler.

## 5. Optional: turn the findings into PR(s)

If the user wants the fixes applied, group findings into atomic PRs by
file group (manifest, screenshots, message passing, etc.) and ship one
PR per group with the fix + a regression note.
