<script lang="ts">
  // Phase 22 — Design Variants module. Pick an element (or whole page),
  // the agent returns 1–5 on-system variants. Element cards render the
  // variant markup through the SAME shadow-root context as "Preview on
  // page" (mountShadowCard), so card and page agree; page-scope cards use
  // a sandboxed srcdoc iframe at device width. The chosen variant applies
  // to source, then a computed-style match check compares page and card.
  // The Pages gallery (collapsed) iframes the live dev-server routes.
  //
  // Layout: compose card (scope → direction → count) + Generate; once
  // results exist it collapses to a one-line brief with Edit / Regenerate.
  // The device picker appears only where it resizes something.

  import { app } from "../lib/state.svelte.js";
  import { confirmDialog } from "../lib/confirm.svelte.js";
  import { urlOrigin } from "../lib/devices.js";
  import { downscaleImage } from "../lib/downscale-image.js";
  import { loadChatSheet } from "../lib/lazy-ui.js";
  import {
    buildSrcdoc,
    elementRenderWidth,
    frameScale,
    MAX_DIRECTION_CHARS,
    mountShadowCard,
    parseDevicePresets,
    safeCssColor,
    splitPreviewBackdrop,
    VARIANT_COUNT_CHOICES,
    VARIANT_PREVIEW_PAGE,
    variantPreviewKey,
    variantCountLabel,
    type DesignVariant,
    type ShadowCardParams,
  } from "../lib/design-variants.js";

  const connected = $derived(app.connectionStatus === "connected");
  const run = $derived(app.variants.currentRun);
  const pending = $derived(app.variants.pending);

  // Device presets from the module setting (defaults when blank/bad).
  const presets = $derived(
    parseDevicePresets(app.modules["design-variants"]?.settings?.devicePresets),
  );
  const device = $derived(
    presets.find((p) => p.label === app.variants.device) ?? presets[0]!,
  );

  // Origin for the Pages gallery frames — the app the user is annotating.
  // Derived from the run's URL when present, else the panel's page URL.
  // http(s) only — a chrome-extension:// (or other) origin would frame an
  // extension page with allow-scripts + allow-same-origin. Anything else
  // falls through to the "Open your app's tab" hint.
  const galleryOrigin = $derived(
    urlOrigin(run?.url || app.lastKnownUrl || "") ?? "",
  );

  // Card layout: variant cards render the iframe at the device's real
  // width and scale it to the card's MEASURED width. The gallery keeps a
  // fixed narrow frame so 1.5 cards peek to invite horizontal scrolling.
  const GALLERY_W = 260;
  const GALLERY_H = 300;

  /** Live width of the variant-card column (bind:clientWidth). 0 until
   *  first measure — fall back to a sane panel width. */
  let cardsW = $state(0);
  const cardInnerW = $derived(cardsW > 0 ? cardsW - 2 : 340); // 1px borders

  let addPagePath = $state("");
  /** Pages gallery disclosure — collapsed by default so the generate
   *  flow reads on its own. Session-local. */
  let galleryOpen = $state(false);

  // Curated direction suggestions — tap to fill the input, tap again to clear.
  // Product-level intents, not visual effects — effects ("glassy",
  // "glow") pull the agent toward generic AI styling.
  const DIRECTION_CHIPS = [
    "clearer hierarchy",
    "more compact",
    "stronger call to action",
    "calmer, less color",
  ];
  function toggleDirectionChip(chip: string): void {
    app.setVariantsDirection(app.variants.direction === chip ? "" : chip);
  }

  /** Icon for a device preset; null falls back to the text label so
   *  custom presets from Settings still render. */
  function deviceIcon(
    label: string,
  ): "phone" | "tablet" | "laptop" | "desktop" | null {
    if (/mobile|phone/i.test(label)) return "phone";
    if (/tablet|pad/i.test(label)) return "tablet";
    if (/laptop|notebook/i.test(label)) return "laptop";
    if (/desktop|monitor|screen|wide/i.test(label)) return "desktop";
    return null;
  }

  // Session-local gallery visibility — the eye toggle on each route row.
  let hiddenPages = $state<ReadonlySet<string>>(new Set());
  function togglePageHidden(path: string): void {
    const next = new Set(hiddenPages);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    hiddenPages = next;
  }
  const visiblePages = $derived(
    app.variants.pages.filter((p) => !hiddenPages.has(p.path)),
  );

  // Memoized derivations: scales recompute only when the device or the
  // measured card width changes; srcdocs (a DOMParser sanitize walk over
  // up to 20KB each) rebuild only when the run changes — never on a
  // device click.
  const fitScale = $derived(frameScale(device.width, cardInnerW));
  // Zoom multiplies the fit scale (1 = fit the card width). Zoomed-in
  // previews pan via the container's scrollbars. Session-local.
  let zoom = $state(1);
  const variantScale = $derived(Math.min(3, fitScale * zoom));
  function zoomBy(delta: number): void {
    zoom = Math.min(4, Math.max(0.5, Math.round((zoom + delta) * 4) / 4));
  }
  // Show the device's aspect up to a cap so tall pages don't dominate
  // the column; element-scope variants are single components, so a
  // shorter window suffices.
  const cardH = $derived(
    Math.min(
      run?.scope.kind === "page" ? 380 : 260,
      Math.max(160, Math.round(device.height * fitScale)),
    ),
  );
  // Iframe interior height: page scope shows the full device viewport
  // (scroll the container to pan); element scope shows a cardH window.
  const frameInnerH = $derived(
    run?.scope.kind === "page"
      ? device.height
      : Math.ceil(cardH / variantScale),
  );
  const galleryScale = $derived(frameScale(device.width, GALLERY_W));
  // Page-scope cards (and full screen) use the sandboxed srcdoc document.
  const srcdocs = $derived(
    new Map((run?.variants ?? []).map((v) => [v.id, buildSrcdoc(v)])),
  );
  // Element-scope cards render through the same shadow context as the
  // on-page preview: element markup (backdrop unwrapped) on its ground,
  // laid out at the element's real width for the selected device.
  const elementCards = $derived(
    new Map(
      (run?.variants ?? []).map((v) => {
        const { elementHtml, background } = splitPreviewBackdrop(v.previewHtml);
        return [
          v.id,
          {
            html: elementHtml,
            ground: safeCssColor(v.previewBackground) ?? background ?? "#ffffff",
          },
        ];
      }),
    ),
  );
  const elementWidth = $derived(
    elementRenderWidth(
      device.width,
      run?.scope.kind === "element" ? run.scope.target?.boundingRect?.width : undefined,
    ),
  );

  /** Element card shown at 100% (click the preview to toggle). One at a
   *  time; session-local. */
  let actualSizeId = $state<string | null>(null);

  /** Svelte action wrapper — the renderer lives in design-variants.ts. */
  function shadowCard(node: HTMLElement, params: ShadowCardParams) {
    return mountShadowCard(node, params);
  }

  const hasResults = $derived(!!run && run.variants.length > 0);
  /** Once results exist the compose form collapses to a summary row;
   *  "Edit" reopens it for THIS run only (a new run collapses again). */
  let composeOpenForRun = $state<string | null>(null);
  const showCompose = $derived(!hasResults || composeOpenForRun === run?.runId);
  const scopeSummary = $derived.by(() => {
    if (app.variants.scopeKind === "page") return "Whole page";
    const runSel = run?.scope.kind === "element" ? run.scope.target.selector : "";
    const sel = app.variants.pickedTarget?.selector ?? runSel;
    const tail = sel.split(" > ").pop() ?? "";
    return tail ? `Element · ${tail}` : "Element";
  });

  function canPreviewOnPage(v: DesignVariant): boolean {
    // The on-page preview renders the card markup itself, so any variant
    // with something to render can preview — element scope swaps the
    // picked element, page scope takes over the body.
    return !!run && v.previewHtml.trim() !== "";
  }

  function togglePagePreview(v: DesignVariant): void {
    if (app.variants.previewingVariantId === v.id) {
      app.restoreVariantPreview();
    } else {
      void app.previewVariantOnPage(v.id);
    }
  }

  /** Open the variant at real size in the packaged preview page — the
   *  "try it" surface for BOTH scopes (page-scope variants have no in-page
   *  swap by design). The variant rides in chrome.storage.session under a
   *  one-time key (only the nonce is in the URL); the page renders it in
   *  an empty-sandbox srcdoc iframe. Never a blob: tab of agent HTML. */
  async function openFullScreen(v: DesignVariant): Promise<void> {
    const nonce = crypto.randomUUID();
    const key = variantPreviewKey(nonce);
    if (!key) return;
    try {
      await chrome.storage.session.set({
        [key]: {
          label: v.label,
          previewHtml: v.previewHtml,
          previewBackground: v.previewBackground,
          createdAt: Date.now(),
        },
      });
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`${VARIANT_PREVIEW_PAGE}?k=${nonce}`),
      });
    } catch {
      void chrome.storage.session.remove(key).catch(() => {});
      app.variants.error = "Couldn't open the full-screen preview tab.";
    }
  }

  async function useVariant(v: DesignVariant): Promise<void> {
    const ok = await confirmDialog({
      title: "Apply this variant?",
      message: `The agent will edit your source files to apply "${v.label}". Your dev server hot-reloads the change.`,
      confirmLabel: "Apply to source",
    });
    if (ok) void app.applyVariant(v.id);
  }

  /** Anything for Reset to clear? Preferences (count, device, pages)
   *  don't count — Reset keeps them. */
  const canReset = $derived(
    !pending &&
      (!!run ||
        !!app.variants.pickedTarget ||
        app.variants.picking ||
        app.variants.direction.trim() !== "" ||
        !!app.variants.refImage ||
        !!app.variants.error ||
        app.variants.scopeKind !== "element"),
  );

  async function reset(): Promise<void> {
    // Unapplied variants cost agent tokens to regenerate — confirm first.
    if (run && run.variants.length > 0 && !run.appliedVariantId) {
      const ok = await confirmDialog({
        title: "Reset Design variants?",
        message: `This clears the ${variantCountLabel(run.variants.length)}, the picked element and your direction. Generating again uses agent tokens.`,
        confirmLabel: "Reset",
        danger: true,
      });
      if (!ok) return;
    }
    zoom = 1;
    app.resetVariants();
  }

  function submitAddPage(): void {
    const p = addPagePath.trim();
    if (!p) return;
    app.addPage(p.startsWith("/") ? p : `/${p}`);
    addPagePath = "";
  }

  const pendingLabel = $derived.by(() => {
    if (!pending) return "";
    if (pending.op === "variants-generate")
      return `Generating ${variantCountLabel(app.variants.count)}…`;
    if (pending.op === "variants-apply")
      return "Applying the variant to your source…";
    return "Discovering your app's pages…";
  });

  /** Why Generate is disabled right now — shown under the button so the
   *  user never has to guess. Null = ready. */
  const generateBlockedReason = $derived(
    !connected
      ? "Connect the companion first (run pinta-companion in your project)"
      : app.variants.scopeKind === "element" && !app.variants.pickedTarget
        ? "Pick an element on the page first — or switch to Whole page"
        : null,
  );

  /** Downscale a pasted reference image to a ≤900px long edge via the
   *  shared helper (JPEG, kept only when smaller) so the payload stays
   *  lean. The wire only carries PNG/JPEG data URLs, so a GIF/WebP is
   *  re-encoded (the helper throws if it can't). */
  async function downscaleRefImage(file: Blob): Promise<string> {
    const { dataUrl } = await downscaleImage(file, { maxEdge: 900, pngOrJpeg: true });
    return dataUrl;
  }

  function onDirectionPaste(e: ClipboardEvent): void {
    const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
      i.type.startsWith("image/"),
    );
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    void downscaleRefImage(file)
      .then((dataUrl) => app.setVariantRefImage(dataUrl))
      .catch(() => {
        app.variants.error = "Couldn't read the pasted image.";
      });
  }

</script>

<!-- Device picker — shared by the results toolbar and the open gallery.
     One state (app.variants.device), rendered wherever it resizes something. -->
{#snippet devicePicker()}
  <div class="shrink-0 inline-flex items-center gap-0.5 rounded-lg border border-ink-200 dark:border-night-line p-0.5" role="group" aria-label="Preview device width">
    {#each presets as p (p.label)}
      {@const icon = deviceIcon(p.label)}
      <button
        type="button"
        class="h-6 min-w-7 px-1 inline-flex items-center justify-center rounded-md transition-colors"
        class:bg-brand-pink={device.label === p.label}
        class:text-white={device.label === p.label}
        class:text-ink-400={device.label !== p.label}
        class:dark:text-night-mute={device.label !== p.label}
        title={`${p.label} · ${p.width} × ${p.height}`}
        aria-label={`${p.label} (${p.width} × ${p.height})`}
        aria-pressed={device.label === p.label}
        onclick={() => app.setVariantsDevice(p.label)}
      >
        {#if icon === "phone"}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
        {:else if icon === "tablet"}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
        {:else if icon === "laptop"}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/></svg>
        {:else if icon === "desktop"}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        {:else}
          <span class="text-[10.5px] font-medium px-0.5">{p.label}</span>
        {/if}
      </button>
    {/each}
  </div>
{/snippet}

<section class="space-y-3">
  <!-- Header — title + Reset -->
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">
        Design variants
      </h2>
      <p class="text-[10.5px] text-ink-500 dark:text-night-mute leading-snug">
        On-brand alternatives for an element or a whole page
      </p>
    </div>
    <button
      type="button"
      class="shrink-0 inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-ink-200 dark:border-night-line text-[11px] font-medium text-ink-600 dark:text-night-dim hover:text-brand-pink hover:border-brand-pink/50 disabled:opacity-40 disabled:hover:text-ink-600 disabled:hover:border-ink-200 disabled:cursor-not-allowed transition-colors"
      disabled={!canReset}
      title={pending
        ? "Wait for the current request (or Cancel it) before resetting"
        : "Clear the picked element, direction, reference image and results"}
      onclick={() => void reset()}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 3 3 9 9 9"/></svg>
      Reset
    </button>
  </div>

  {#if !connected}
    <p class="text-[11.5px] text-amber-700 dark:text-amber-400 leading-snug">
      Connect a companion (run <code>pinta-companion .</code> in your project)
      so the agent can generate variants.
    </p>
  {/if}

  {#if app.variants.error}
    <div
      class="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[11.5px] text-red-700 dark:text-red-300 leading-snug"
      role="alert"
    >
      <p class="flex-1 min-w-0 break-words">{app.variants.error}</p>
      <button
        type="button"
        class="shrink-0 text-red-500 hover:text-red-700 dark:hover:text-red-200 leading-none px-1"
        onclick={() => (app.variants.error = null)}
        aria-label="Dismiss"
        title="Dismiss"
      >✕</button>
    </div>
  {/if}

  {#if showCompose}
  <!-- Compose card — what to redesign, how it should look, how many. -->
  <div class="rounded-xl border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-3 space-y-3">
    <!-- Scope -->
    <div class="space-y-2">
      <div class="flex rounded-lg bg-ink-100 dark:bg-night-alt p-0.5" role="group" aria-label="What to redesign">
        {#each [{ kind: "element", label: "Element" }, { kind: "page", label: "Whole page" }] as opt (opt.kind)}
          {@const on = app.variants.scopeKind === opt.kind}
          <button
            type="button"
            class="flex-1 py-1 rounded-md text-[11.5px] font-medium transition-colors disabled:opacity-60"
            class:bg-white={on}
            class:dark:bg-night-card={on}
            class:text-brand-pink={on}
            class:dark:text-brand-pink-light={on}
            class:shadow-sm={on}
            class:text-ink-500={!on}
            class:dark:text-night-mute={!on}
            aria-pressed={on}
            disabled={!!pending}
            onclick={() => app.setVariantScopeKind(opt.kind as "element" | "page")}
          >
            {opt.label}
          </button>
        {/each}
      </div>

      {#if app.variants.scopeKind === "element"}
        {#if app.variants.picking}
          <div class="flex items-center gap-2 rounded-lg border border-dashed border-brand-pink/50 bg-brand-pink/5 dark:bg-brand-pink/10 px-2 py-1.5">
            <svg class="animate-spin shrink-0 text-brand-pink" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            <span class="flex-1 text-[11px] text-ink-500 dark:text-night-mute">
              Click an element on the page… (Esc cancels)
            </span>
            <button
              type="button"
              class="shrink-0 text-[11px] underline text-ink-500 dark:text-night-mute"
              onclick={() => void app.cancelVariantPick()}
            >Cancel</button>
          </div>
        {:else if app.variants.pickedTarget}
          <div class="flex items-center gap-1.5 rounded-lg border border-brand-pink/40 bg-brand-pink/5 dark:bg-brand-pink/10 px-2 py-1.5 min-w-0">
            <svg class="shrink-0 text-brand-pink" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><line x1="12" y1="1" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="1" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="23" y2="12"/></svg>
            <span
              class="flex-1 min-w-0 font-mono text-[10.5px] text-brand-pink truncate"
              dir="rtl"
              title={app.variants.pickedTarget.sourceFile
                ? `${app.variants.pickedTarget.selector}\n${app.variants.pickedTarget.sourceFile}`
                : app.variants.pickedTarget.selector}
            >
              <bdi>{app.variants.pickedTarget.selector}</bdi>
            </span>
            <button
              type="button"
              class="shrink-0 text-[11px] font-semibold text-brand-pink hover:text-brand-magenta disabled:opacity-50"
              disabled={!!pending}
              onclick={() => void app.startVariantPick()}
            >Repick</button>
            <button
              type="button"
              class="shrink-0 text-ink-400 hover:text-ink-700 dark:text-night-mute dark:hover:text-night-text leading-none px-0.5"
              disabled={!!pending}
              onclick={() => app.clearPickedTarget()}
              aria-label="Clear picked element"
              title="Clear"
            >✕</button>
          </div>
        {:else}
          <button
            type="button"
            class="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-brand-pink/50 bg-brand-pink/5 dark:bg-brand-pink/10 px-2 py-2 text-[11.5px] font-medium text-brand-pink hover:bg-brand-pink/10 disabled:opacity-50"
            disabled={!!pending}
            onclick={() => void app.startVariantPick()}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><line x1="12" y1="1" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="1" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="23" y2="12"/></svg>
            Pick an element on the page
          </button>
        {/if}
      {:else}
        <p class="text-[10.5px] text-ink-500 dark:text-night-mute leading-snug">
          The agent redesigns the page open in your current tab.
        </p>
      {/if}
    </div>

    <!-- Direction (optional) -->
    <div class="space-y-1.5">
      <textarea
        rows="2"
        class="w-full px-2.5 py-1.5 rounded-lg text-[12px] border border-ink-200 dark:border-night-line bg-white dark:bg-night-alt text-ink-800 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute focus:outline-none focus:border-brand-pink resize-y leading-snug"
        placeholder="Describe the look (optional) — or paste a screenshot"
        aria-label="Direction (optional)"
        maxlength={MAX_DIRECTION_CHARS}
        value={app.variants.direction}
        oninput={(e) => app.setVariantsDirection(e.currentTarget.value)}
        onpaste={onDirectionPaste}
        disabled={!!pending}
      ></textarea>
      {#if app.variants.refImage}
        <div class="flex items-center gap-2 rounded-lg border border-dashed border-brand-pink/50 bg-brand-pink/5 dark:bg-brand-pink/10 px-2 py-1.5">
          <img
            src={app.variants.refImage}
            alt="Pasted look reference"
            class="h-9 w-9 rounded object-cover shrink-0"
          />
          <span class="flex-1 text-[10.5px] text-ink-600 dark:text-night-dim leading-snug">
            Reference attached. Variants lean toward this look.
          </span>
          <button
            type="button"
            class="shrink-0 text-ink-400 hover:text-ink-700 dark:text-night-mute dark:hover:text-night-text leading-none px-1"
            onclick={() => app.clearVariantRefImage()}
            aria-label="Remove reference image"
            title="Remove"
          >✕</button>
        </div>
      {/if}
      <div class="flex items-center gap-1.5 flex-wrap">
        {#each DIRECTION_CHIPS as chip (chip)}
          <button
            type="button"
            class={`px-2 py-0.5 rounded-full text-[10.5px] font-medium transition-colors ${
              app.variants.direction === chip
                ? "bg-brand-pink text-white"
                : "bg-brand-pink/10 text-brand-pink dark:text-brand-pink-light hover:bg-brand-pink/15"
            }`}
            aria-pressed={app.variants.direction === chip}
            disabled={!!pending}
            onclick={() => toggleDirectionChip(chip)}
          >
            {chip}
          </button>
        {/each}
      </div>
    </div>

    <!-- Count -->
    <div class="flex items-center gap-2 pt-2.5 border-t border-ink-100 dark:border-night-line">
      <span class="text-[11.5px] font-medium text-ink-700 dark:text-night-dim">Variants</span>
      <div class="ml-auto flex items-center gap-1" role="group" aria-label="How many variants">
        {#each VARIANT_COUNT_CHOICES as n (n)}
          {@const on = app.variants.count === n}
          <button
            type="button"
            class="w-7 h-7 inline-flex items-center justify-center rounded-lg text-[11.5px] font-semibold transition-colors disabled:opacity-50"
            class:bg-brand-pink={on}
            class:text-white={on}
            class:border={!on}
            class:border-ink-200={!on}
            class:text-ink-600={!on}
            class:hover:border-brand-pink={!on}
            class:dark:border-night-line={!on}
            class:dark:text-night-dim={!on}
            aria-pressed={on}
            title={`Generate ${variantCountLabel(n)}${n > 3 ? " (more tokens per run)" : ""}`}
            disabled={!!pending}
            onclick={() => app.setVariantsCount(n)}
          >
            {n}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <!-- Generate -->
  <div class="space-y-1">
    <button
      type="button"
      class="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-[12.5px] font-semibold text-white bg-gradient-to-r from-brand-pink to-brand-magenta hover:opacity-95 disabled:opacity-50 shadow-sm transition-opacity"
      disabled={!!generateBlockedReason || !!pending}
      onclick={() => void app.runVariantsGenerate()}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.2 6.6a1.5 1.5 0 0 0 .95.95L21.75 12l-6.6 2.2a1.5 1.5 0 0 0-.95.95L12 21.75l-2.2-6.6a1.5 1.5 0 0 0-.95-.95L2.25 12l6.6-2.2a1.5 1.5 0 0 0 .95-.95L12 2.25z"/></svg>
      {run && run.variants.length > 0 ? "Regenerate" : "Generate"} {variantCountLabel(app.variants.count)}
    </button>
    {#if generateBlockedReason && !pending}
      <p class="text-center text-[10.5px] text-amber-700 dark:text-amber-400">
        {generateBlockedReason}
      </p>
    {/if}
  </div>
  {:else}
    <!-- Collapsed brief — results take the space; Edit reopens the form. -->
    <div class="flex items-center gap-2 rounded-xl border border-ink-200 dark:border-night-line bg-white dark:bg-night-card pl-3 pr-2 py-2">
      <div class="flex-1 min-w-0">
        <p class="text-[11.5px] font-medium text-ink-800 dark:text-night-text truncate" title={scopeSummary}>{scopeSummary}</p>
        <p class="text-[10.5px] text-ink-500 dark:text-night-mute truncate">
          {app.variants.direction.trim() ? `“${app.variants.direction.trim()}”` : "No direction"}{app.variants.refImage ? " · reference image" : ""}
        </p>
      </div>
      <button
        type="button"
        class="shrink-0 h-7 px-2.5 rounded-lg text-[11px] font-medium text-ink-600 dark:text-night-dim hover:text-brand-pink hover:bg-brand-pink/5 disabled:opacity-50"
        disabled={!!pending}
        onclick={() => (composeOpenForRun = run?.runId ?? null)}
      >Edit</button>
      <button
        type="button"
        class="shrink-0 h-7 px-2.5 inline-flex items-center gap-1 rounded-lg text-[11px] font-semibold text-brand-pink border border-brand-pink/40 hover:bg-brand-pink/5 disabled:opacity-50"
        disabled={!!generateBlockedReason || !!pending}
        title={generateBlockedReason ?? `Generate ${variantCountLabel(app.variants.count)} again with the same brief`}
        onclick={() => void app.runVariantsGenerate()}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.2 6.6a1.5 1.5 0 0 0 .95.95L21.75 12l-6.6 2.2a1.5 1.5 0 0 0-.95.95L12 21.75l-2.2-6.6a1.5 1.5 0 0 0-.95-.95L2.25 12l6.6-2.2a1.5 1.5 0 0 0 .95-.95L12 2.25z"/></svg>
        Regenerate
      </button>
    </div>
  {/if}

  {#if pending}
    <div class="rounded-xl border border-ink-200 dark:border-night-line p-4 text-center space-y-2">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="animate-spin text-brand-pink dark:text-brand-pink-light mx-auto">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <p class="text-xs text-ink-600 dark:text-night-dim">{pendingLabel}</p>
      <button
        type="button"
        class="text-[11px] text-ink-500 dark:text-night-mute underline hover:text-ink-800 dark:hover:text-night-text"
        onclick={() => app.cancelVariants()}
      >
        Cancel
      </button>
    </div>
  {/if}

  <!-- Results -->
  {#if run && run.variants.length > 0}
    <div class="pt-1 space-y-2">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <p class="text-[11px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
          {variantCountLabel(run.variants.length)} · {run.scope.kind === "element" ? "element" : "page"}
        </p>
        <div class="flex items-center gap-1.5">
          {#if run.scope.kind === "page"}
          <!-- Zoom — page scope only (element cards fit their element).
               Clicking the % snaps back to fit. -->
          <div class="flex items-center rounded-lg border border-ink-200 dark:border-night-line h-7">
            <button
              type="button"
              class="w-6 h-full inline-flex items-center justify-center text-ink-500 dark:text-night-mute hover:text-brand-pink text-[13px] leading-none"
              onclick={() => zoomBy(-0.25)}
              aria-label="Zoom out"
              title="Zoom out"
            >−</button>
            <button
              type="button"
              class="min-w-[40px] h-full text-center text-[10.5px] tabular-nums text-ink-600 dark:text-night-dim hover:text-brand-pink"
              onclick={() => (zoom = 1)}
              title="Preview zoom (100% = actual device pixels) — click to fit the card"
            >{Math.round(variantScale * 100)}%</button>
            <button
              type="button"
              class="w-6 h-full inline-flex items-center justify-center text-ink-500 dark:text-night-mute hover:text-brand-pink text-[13px] leading-none"
              onclick={() => zoomBy(0.25)}
              aria-label="Zoom in"
              title="Zoom in"
            >+</button>
          </div>
          {/if}
          {@render devicePicker()}
        </div>
      </div>

      {#each run.variants as v, vi (v.id)}
        {@const applied = run.appliedVariantId === v.id}
        {@const previewing = app.variants.previewingVariantId === v.id}
        <div
          id={`variant-card-${v.id}`}
          class="rounded-xl border overflow-hidden bg-white dark:bg-night-card"
          class:border-brand-pink={applied || previewing}
          class:border-ink-200={!applied && !previewing}
          class:dark:border-night-line={!applied && !previewing}
        >
          <div class="flex items-start gap-2 px-3 py-2">
            {#if run.variants.length > 1}
              <span class="mt-0.5 w-5 h-5 shrink-0 inline-flex items-center justify-center rounded-full bg-brand-pink/10 text-[10.5px] font-semibold text-brand-pink dark:text-brand-pink-light">
                {vi + 1}
              </span>
            {/if}
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5 min-w-0">
                <h3 class="text-[12.5px] font-semibold text-ink-900 dark:text-night-text truncate">
                  {v.label}
                </h3>
                {#if applied}
                  <span class="shrink-0 px-1.5 py-0.5 rounded-full bg-brand-pink text-white text-[10px] font-semibold">Applied</span>
                {:else if previewing}
                  <span class="shrink-0 px-1.5 py-0.5 rounded-full border border-brand-pink text-brand-pink dark:text-brand-pink-light text-[10px] font-semibold">On page</span>
                {/if}
              </div>
              {#if v.rationale}
                <p class="text-[10.5px] text-ink-500 dark:text-night-mute leading-snug line-clamp-2" title={v.rationale}>
                  {v.rationale}
                </p>
              {/if}
            </div>
            <button
              type="button"
              class="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-lg text-ink-400 dark:text-night-mute hover:text-brand-pink hover:bg-brand-pink/5"
              title="Open full screen in a new tab (real size)"
              aria-label={`Open ${v.label} full screen`}
              onclick={() => void openFullScreen(v)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            </button>
          </div>
          {#if run.scope.kind === "element"}
            {@const card = elementCards.get(v.id)}
            <!-- Same shadow context as "Preview on page": what you see here
                 is what the page shows. Inert — a picture, not a surface. -->
            {@const actual = actualSizeId === v.id}
            <!-- overflow-clip + containment: even a fixed-position node in the
                 agent markup stays inside this card (no panel overlay). -->
            <div class="relative overflow-clip border-y border-ink-100 dark:border-night-line" style="background: {card?.ground ?? '#ffffff'};">
              <button
                type="button"
                class="block w-full overflow-x-auto overflow-y-hidden text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-pink"
                class:cursor-zoom-in={!actual}
                class:cursor-zoom-out={actual}
                aria-pressed={actual}
                aria-label={actual ? `Fit ${v.label} to the card` : `Show ${v.label} at actual size`}
                title={actual ? "Click to fit the card" : "Click to see actual size"}
                onclick={() => (actualSizeId = actual ? null : v.id)}
              >
                <div
                  class="block"
                  style="contain: layout paint;"
                  inert
                  use:shadowCard={{ html: card?.html ?? "", width: elementWidth, ground: card?.ground ?? "#ffffff", actual }}
                ></div>
              </button>
              {#if actual}
                <span class="pointer-events-none absolute right-2 top-2 px-1.5 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-semibold tabular-nums">100%</span>
              {/if}
            </div>
          {:else}
          <!-- Sandboxed preview: EMPTY sandbox attr = no scripts, no
               same-origin, nothing. srcdoc is additionally sanitized.
               Rendered at the device's real width, scaled to the card. -->
          <div
            class="overflow-auto bg-white border-y border-ink-100 dark:border-night-line"
            style="height: {cardH}px;"
            bind:clientWidth={cardsW}
          >
            <div
              class="mx-auto overflow-hidden"
              style="width: {Math.round(device.width * variantScale)}px; height: {Math.round(frameInnerH * variantScale)}px;"
            >
              <iframe
                sandbox=""
                srcdoc={srcdocs.get(v.id) ?? ""}
                referrerpolicy="no-referrer"
                loading="lazy"
                scrolling="no"
                title={`Preview: ${v.label}`}
                class="border-0 pointer-events-none"
                style="width: {device.width}px; height: {frameInnerH}px; transform: scale({variantScale}); transform-origin: top left;"
              ></iframe>
            </div>
          </div>
          {/if}
          {#if v.summary}
            <details class="px-3 py-1.5 border-b border-ink-100 dark:border-night-line">
              <summary class="text-[11px] text-ink-500 dark:text-night-mute cursor-pointer select-none">
                What would change
              </summary>
              <p class="mt-1 text-[11px] text-ink-700 dark:text-night-dim whitespace-pre-wrap leading-snug">
                {v.summary}
              </p>
            </details>
          {/if}
          <div class="flex items-center gap-1.5 px-3 py-2 flex-wrap">
            {#if !applied}
              <button
                type="button"
                class="px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                class:border-brand-pink={previewing}
                class:text-brand-pink={previewing}
                class:dark:text-brand-pink-light={previewing}
                class:border-ink-200={!previewing}
                class:text-ink-600={!previewing}
                class:dark:border-night-line={!previewing}
                class:dark:text-night-dim={!previewing}
                disabled={!!pending || !canPreviewOnPage(v)}
                title={canPreviewOnPage(v)
                  ? run.scope.kind === "element"
                    ? "Show exactly this card on the live page — click again to restore"
                    : "Take over the live page with this variant — click again to restore"
                  : "This variant has nothing to render on the page"}
                onclick={() => togglePagePreview(v)}
              >
                {previewing ? "Restore page" : "Preview on page"}
              </button>
            {/if}
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg text-[11px] font-medium border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:text-brand-pink transition-colors inline-flex items-center gap-1.5"
              title="Refine this variant in chat — e.g. 'add a background color to the heading'"
              onclick={() => app.openVariantDiscuss(v.id)}
            >
              {#if app.variants.pendingDiscuss[v.id]}
                <svg class="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
              {/if}
              Refine
            </button>
            {#if !applied}
              <button
                type="button"
                class="ml-auto px-3 py-1 rounded-lg text-[11px] font-semibold bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-50"
                disabled={!connected || !!pending}
                onclick={() => void useVariant(v)}
              >Use this</button>
            {/if}
          </div>
          {#if applied}
            {@const match = run.match}
            {@const fixing = pending?.op === "variants-apply" && pending.variantId === v.id}
            {@const diffCount = (match?.diffs?.length ?? 0) + (match?.missing?.length ?? 0)}
            <div class="px-3 py-2.5 border-t border-ink-100 dark:border-night-line bg-ink-50/70 dark:bg-night-alt/30 space-y-2">
              {#if run.applySummary}
                <p class="text-[11px] text-ink-700 dark:text-night-dim leading-snug">{run.applySummary}</p>
              {/if}
              {#if run.appliedFiles && run.appliedFiles.length > 0}
                <ul class="space-y-0.5">
                  {#each run.appliedFiles as f (f.path)}
                    <li class="font-mono text-[10px] text-ink-500 dark:text-night-mute truncate" title={f.note ? `${f.path} — ${f.note}` : f.path}>
                      {f.path.split("/").slice(-3).join("/")}
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if run.scope.kind === "element"}
                <div class="flex items-center gap-2 min-w-0 min-h-7">
                  {#if fixing}
                    <svg class="animate-spin shrink-0 text-brand-pink" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                    <p class="flex-1 text-[11px] text-ink-600 dark:text-night-dim">Fixing the differences…</p>
                  {:else if match?.status === "checking"}
                    <svg class="animate-spin shrink-0 text-ink-400" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                    <p class="flex-1 text-[11px] text-ink-600 dark:text-night-dim">Checking the page against this card…</p>
                  {:else if match?.status === "done" && diffCount === 0}
                    <span class="shrink-0 w-4 h-4 inline-flex items-center justify-center rounded-full bg-emerald-600 text-white" aria-hidden="true">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </span>
                    <p class="flex-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">Page matches this card</p>
                  {:else if match?.status === "done"}
                    <span class="shrink-0 px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-950/40 text-[10.5px] font-semibold tabular-nums text-amber-800 dark:text-amber-300">{match.score}%</span>
                    <p class="flex-1 min-w-0 text-[11px] text-ink-700 dark:text-night-dim">
                      {diffCount} difference{diffCount === 1 ? "" : "s"}
                    </p>
                  {:else if match?.status === "not-found"}
                    <p class="flex-1 text-[11px] text-amber-700 dark:text-amber-400 leading-snug">Couldn't find the updated element on this page.</p>
                  {:else if match?.status === "error"}
                    <p class="flex-1 text-[11px] text-amber-700 dark:text-amber-400 leading-snug">{match.message}</p>
                  {:else}
                    <p class="flex-1 text-[11px] text-ink-500 dark:text-night-mute">Not checked against the page yet.</p>
                  {/if}
                  {#if !fixing && match?.status !== "checking"}
                    {#if match?.status === "done" && diffCount > 0}
                      <button
                        type="button"
                        class="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-50"
                        disabled={!connected || !!pending}
                        title="The agent corrects only these properties so the page matches the card"
                        onclick={() => app.fixVariantDifferences()}
                      >Fix differences</button>
                    {/if}
                    <button
                      type="button"
                      class="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-lg border border-ink-200 dark:border-night-line text-ink-500 dark:text-night-mute hover:text-brand-pink hover:border-brand-pink/50 disabled:opacity-50"
                      disabled={!!pending}
                      aria-label={match ? "Check the page again" : "Check the page against this card"}
                      title={match ? "Check again" : "Check match"}
                      onclick={() => void app.verifyAppliedVariant()}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>
                    </button>
                  {/if}
                </div>
                {#if match?.status === "done" && !fixing && diffCount > 0}
                  <details>
                    <summary class="text-[10.5px] text-ink-500 dark:text-night-mute cursor-pointer select-none">Show differences</summary>
                    <ul class="mt-1.5 rounded-lg border border-ink-100 dark:border-night-line bg-white dark:bg-night-card divide-y divide-ink-100 dark:divide-night-line">
                      {#each match.diffs ?? [] as d, di (di)}
                        <li class="px-2 py-1.5 space-y-1">
                          <div class="flex items-baseline gap-1.5 min-w-0">
                            <span class="shrink-0 font-mono text-[10.5px] text-ink-800 dark:text-night-text">{d.prop}</span>
                            <span class="min-w-0 truncate text-[10px] text-ink-400 dark:text-night-mute" title={d.path}>{d.path.split(" › ").pop()}</span>
                          </div>
                          <div class="flex flex-wrap gap-1 font-mono text-[10px] leading-snug">
                            <span class="max-w-full break-words px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300"><span class="font-sans font-medium text-emerald-600 dark:text-emerald-400">Card</span> {d.expected}</span>
                            <span class="max-w-full break-words px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300"><span class="font-sans font-medium text-amber-600 dark:text-amber-400">Page</span> {d.actual}</span>
                          </div>
                        </li>
                      {/each}
                      {#each match.missing ?? [] as miss, mi (mi)}
                        <li class="px-2 py-1.5 text-[10.5px] text-ink-700 dark:text-night-dim">
                          Missing on the page: <span class="text-ink-500 dark:text-night-mute">{miss.split(" › ").pop()}</span>
                        </li>
                      {/each}
                    </ul>
                  </details>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Pages gallery — optional, collapsed. Live dev-server routes at the
       selected device width; no agent involved to render. -->
  <details
    class="group rounded-xl border border-ink-200 dark:border-night-line bg-white dark:bg-night-card"
    bind:open={galleryOpen}
  >
    <summary class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
      <svg class="shrink-0 text-ink-400 dark:text-night-mute transition-transform group-open:rotate-90" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
      <span class="text-[11.5px] font-medium text-ink-700 dark:text-night-dim">Pages gallery</span>
      {#if app.variants.pages.length > 0}
        <span class="px-1.5 rounded-full bg-ink-100 dark:bg-night-alt text-[10px] font-semibold tabular-nums text-ink-600 dark:text-night-dim">{app.variants.pages.length}</span>
      {/if}
      <span class="ml-auto text-[10.5px] text-ink-400 dark:text-night-mute truncate">Your routes side by side</span>
    </summary>

    {#if galleryOpen}
      <div class="px-3 pb-3 space-y-2">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div class="flex items-center gap-2.5">
            <button
              type="button"
              class="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-pink hover:text-brand-magenta disabled:opacity-50"
              disabled={!connected || !!pending}
              onclick={() => void app.discoverPages()}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              Discover pages
            </button>
            {#if app.variants.pages.length > 0}
              <button
                type="button"
                class="text-[11px] underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
                onclick={() => app.refreshGallery()}
              >
                Refresh all
              </button>
            {/if}
          </div>
          {@render devicePicker()}
        </div>

        <div class="flex items-center gap-1.5">
          <input
            type="text"
            class="flex-1 min-w-0 rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-alt px-2.5 py-1.5 text-[11.5px] font-mono text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute focus:outline-none focus:border-brand-pink"
            placeholder="/route"
            aria-label="Add a route"
            bind:value={addPagePath}
            onkeydown={(e) => {
              if (e.key === "Enter") submitAddPage();
            }}
          />
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg text-[11px] font-semibold border border-brand-pink text-brand-pink hover:bg-brand-pink/5"
            onclick={submitAddPage}
          >
            Add
          </button>
        </div>

        {#if app.variants.pages.length > 0}
          <div class="space-y-1">
            {#each app.variants.pages as p (p.path)}
              {@const hidden = hiddenPages.has(p.path)}
              <div class="flex items-center gap-1.5 rounded-lg border border-ink-200 dark:border-night-line px-2.5 py-1 min-w-0">
                <span class="flex-1 min-w-0 font-mono text-[11px] truncate" class:text-brand-pink={!hidden} class:text-ink-400={hidden} title={p.path}>
                  {p.path}
                </span>
                <button
                  type="button"
                  class="shrink-0 text-ink-400 hover:text-brand-pink dark:text-night-mute dark:hover:text-brand-pink-light"
                  aria-pressed={!hidden}
                  aria-label={hidden ? `Show ${p.label} in the gallery` : `Hide ${p.label} from the gallery`}
                  title={hidden ? "Show in the gallery" : "Hide from the gallery"}
                  onclick={() => togglePageHidden(p.path)}
                >
                  {#if hidden}
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21" y2="21"/></svg>
                  {:else}
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                  {/if}
                </button>
                <button
                  type="button"
                  class="shrink-0 text-ink-400 hover:text-ink-700 dark:text-night-mute dark:hover:text-night-text leading-none px-0.5 text-[11px]"
                  onclick={() => app.removePage(p.path)}
                  aria-label={`Remove ${p.label}`}
                  title="Remove"
                >✕</button>
              </div>
            {/each}
          </div>
        {/if}

        {#if app.variants.pages.length === 0}
          <p class="text-[10.5px] text-ink-400 dark:text-night-mute leading-snug">
            Add routes (or let the agent discover them) to see your real
            running app side by side at any device width.
          </p>
        {:else if !galleryOrigin}
          <p class="text-[10.5px] text-amber-700 dark:text-amber-400 leading-snug">
            Open your app's tab so the gallery knows which origin to frame.
          </p>
        {:else if visiblePages.length > 0}
          <div class="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
            {#each visiblePages as p, i (p.path)}
              <div class="shrink-0 space-y-1" style="width: {GALLERY_W}px;">
                <p class="text-[10px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium truncate" title={p.path}>
                  {i + 1} · {p.label}
                </p>
                <div
                  class="relative overflow-hidden rounded-md border border-ink-200 dark:border-night-line bg-white"
                  style="height: {GALLERY_H}px;"
                >
                  <!-- Keyed on the nonce ONLY: a device switch just resizes
                       the frame (CSS reflow, media queries re-evaluate) — no
                       reload. Refresh-all bumps the nonce to force reloads. -->
                  {#key app.variants.galleryNonce}
                    <iframe
                      src={`${galleryOrigin}${p.path}`}
                      sandbox="allow-same-origin allow-scripts allow-forms"
                      referrerpolicy="no-referrer"
                      loading="lazy"
                      title={`${p.label} at ${device.label} width`}
                      class="absolute top-0 left-0 border-0 pointer-events-none"
                      style="width: {device.width}px; height: {GALLERY_H / galleryScale}px; transform: scale({galleryScale}); transform-origin: top left;"
                    ></iframe>
                  {/key}
                </div>
              </div>
            {/each}
          </div>
          <p class="text-[10px] text-ink-400 dark:text-night-mute leading-snug">
            After applying a variant, Refresh all to see the new look.
            Apps that block framing (X-Frame-Options / frame-ancestors)
            won't render here.
          </p>
        {/if}
      </div>
    {/if}
  </details>
</section>

{#if app.variants.discussVariantId}
  {@const dv = run?.variants.find((x) => x.id === app.variants.discussVariantId)}
  {#if dv}
    {#await loadChatSheet() then ChatSheetMod}
    <ChatSheetMod.default
      open={!!app.variants.discussVariantId}
      contextHeader="Refining variant"
      contextLabel={dv.label}
      contextSubLabel={run?.scope.kind === "element" ? "element variant" : "page variant"}
      messages={app.variants.variantChats[dv.id] ?? []}
      pending={!!app.variants.pendingDiscuss[dv.id]}
      error={null}
      placeholder="Refine it — e.g. add a background color to the heading…"
      greeting="Tell me how to tweak this variant — colors, spacing, wording, layout — and I'll update the preview card in place."
      quickPrompts={[
        { label: "Heading background", prompt: "Add a subtle brand background color to the heading." },
        { label: "More contrast", prompt: "Increase the contrast between the heading and the body." },
        { label: "Tighter spacing", prompt: "Make the spacing more compact." },
      ]}
      onSend={(text) => void app.sendVariantDiscuss(dv.id, text)}
      onClose={() => app.openVariantDiscuss(null)}
    />
    {:catch}
      <div role="alert" class="absolute inset-x-3 bottom-3 z-30 flex items-start gap-2 text-xs text-red-600 border border-red-200 bg-red-50 dark:text-red-300 dark:border-red-900/40 dark:bg-red-950/90 rounded-md p-2">
        <p class="flex-1">Couldn't load the chat. Try again.</p>
        <button type="button" class="shrink-0 leading-none px-1" aria-label="Dismiss" title="Dismiss" onclick={() => app.openVariantDiscuss(null)}>✕</button>
      </div>
    {/await}
  {/if}
{/if}
