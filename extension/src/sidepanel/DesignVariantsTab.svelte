<script lang="ts">
  // Phase 22 — Design Variants module. Pick an element (or whole page),
  // the agent returns 3 on-system design variants rendered as sandboxed
  // iframe cards (switchable across device widths), each live-previewable
  // on the page (element scope), and applied to source with one click.
  // The Pages gallery iframes the LIVE dev-server routes side by side at
  // the selected device width — a mockup sheet backed by the real app.

  import { app } from "../lib/state.svelte.js";
  import { confirmDialog } from "../lib/confirm.svelte.js";
  import { originOf } from "../lib/local-store.js";
  import ChatSheet from "./ChatSheet.svelte";
  import {
    buildSrcdoc,
    frameScale,
    MAX_DIRECTION_CHARS,
    parseDevicePresets,
    VARIANT_COUNT_CHOICES,
    type DesignVariant,
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
  // originOf is the codebase's canonical URL→origin helper.
  const galleryOrigin = $derived(
    originOf(run?.url || app.lastKnownUrl || "") ?? "",
  );

  // Card layout: variant cards render the iframe at the device's real
  // width and scale it to the card's MEASURED width (the side panel can
  // be anywhere from ~360px to full-window wide — a fixed budget either
  // clips the render or leaves dead white space). The gallery keeps a
  // fixed narrow frame so 1.5 cards peek to invite horizontal scrolling.
  const GALLERY_W = 260;
  const GALLERY_H = 300;

  /** Live width of the variant-card column (bind:clientWidth). 0 until
   *  first measure — fall back to a sane panel width. */
  let cardsW = $state(0);
  const cardInnerW = $derived(cardsW > 0 ? cardsW - 2 : 340); // 1px borders

  let addPagePath = $state("");

  // Curated direction suggestions — tap to fill the input, tap again to clear.
  const DIRECTION_CHIPS = [
    "glassy",
    "more compact",
    "bolder brand color",
    "softer shadows",
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
  // device-chip click.
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
  const srcdocs = $derived(
    new Map((run?.variants ?? []).map((v) => [v.id, buildSrcdoc(v)])),
  );

  function canPreviewOnPage(v: DesignVariant): boolean {
    return (
      run?.scope.kind === "element" &&
      !!v.swap &&
      (!!v.swap.cssChanges || !!v.swap.html)
    );
  }

  function togglePagePreview(v: DesignVariant): void {
    if (app.variants.previewingVariantId === v.id) {
      app.restoreVariantPreview();
    } else {
      void app.previewVariantOnPage(v.id);
    }
  }

  /** Open the sanitized variant document in its own browser tab at real
   *  size — the "try it" surface that works for BOTH scopes (page-scope
   *  variants have no in-page swap by design). The document is the same
   *  sanitized srcdoc the card renders: no scripts, no external URLs. */
  function openFullScreen(v: DesignVariant): void {
    const doc = srcdocs.get(v.id);
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
    void chrome.tabs.create({ url }).catch(() => {
      app.variants.error = "Couldn't open the full-screen preview tab.";
    });
    // Give the new tab time to load before revoking the blob.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function useVariant(v: DesignVariant): Promise<void> {
    const ok = await confirmDialog({
      title: "Apply this variant?",
      message: `The agent will edit your source files to apply "${v.label}". Your dev server hot-reloads the change.`,
      confirmLabel: "Apply to source",
    });
    if (ok) void app.applyVariant(v.id);
  }

  function newRun(): void {
    app.clearVariantsRun();
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
      return `Generating ${app.variants.count} design variants…`;
    if (pending.op === "variants-apply")
      return "Applying the variant to your source…";
    return "Discovering your app's pages…";
  });
</script>

<section class="space-y-3">
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">
        Design variants
      </h2>
      <p class="text-[10.5px] text-ink-500 dark:text-night-mute leading-snug">
        Generate on-brand alternatives for any element
      </p>
    </div>
    <!-- Device picker — icons, shared by variant cards AND the Pages gallery. -->
    <div class="shrink-0 inline-flex items-center gap-0.5 rounded-lg border border-ink-200 dark:border-night-line p-0.5">
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

  <!-- Step 1 — Scope -->
  <div class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-3 space-y-2.5">
    <div class="flex items-center gap-2">
      <span class="w-5 h-5 shrink-0 inline-flex items-center justify-center rounded-full bg-ink-100 dark:bg-night-alt text-[10.5px] font-semibold text-ink-600 dark:text-night-dim">1</span>
      <span class="text-[12px] font-semibold text-ink-900 dark:text-night-text">Scope</span>
    </div>
    <div class="flex rounded-full bg-ink-100 dark:bg-night-alt p-0.5">
      <button
        type="button"
        class="flex-1 py-1 rounded-full text-[11.5px] font-medium transition-colors"
        class:bg-white={app.variants.scopeKind === "element"}
        class:dark:bg-night-card={app.variants.scopeKind === "element"}
        class:text-brand-pink={app.variants.scopeKind === "element"}
        class:dark:text-brand-pink-light={app.variants.scopeKind === "element"}
        class:shadow-sm={app.variants.scopeKind === "element"}
        class:ring-1={app.variants.scopeKind === "element"}
        class:ring-brand-pink={app.variants.scopeKind === "element"}
        class:text-ink-500={app.variants.scopeKind !== "element"}
        class:dark:text-night-mute={app.variants.scopeKind !== "element"}
        onclick={() => app.setVariantScopeKind("element")}
      >
        Element
      </button>
      <button
        type="button"
        class="flex-1 py-1 rounded-full text-[11.5px] font-medium transition-colors"
        class:bg-white={app.variants.scopeKind === "page"}
        class:dark:bg-night-card={app.variants.scopeKind === "page"}
        class:text-brand-pink={app.variants.scopeKind === "page"}
        class:dark:text-brand-pink-light={app.variants.scopeKind === "page"}
        class:shadow-sm={app.variants.scopeKind === "page"}
        class:ring-1={app.variants.scopeKind === "page"}
        class:ring-brand-pink={app.variants.scopeKind === "page"}
        class:text-ink-500={app.variants.scopeKind !== "page"}
        class:dark:text-night-mute={app.variants.scopeKind !== "page"}
        onclick={() => app.setVariantScopeKind("page")}
      >
        Whole page
      </button>
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
        <div class="flex items-center gap-1.5 rounded-lg border border-dashed border-brand-pink/50 bg-brand-pink/5 dark:bg-brand-pink/10 px-2 py-1.5 min-w-0">
          <svg class="shrink-0 text-brand-pink" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><line x1="12" y1="1" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="1" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="23" y2="12"/></svg>
          <span
            class="flex-1 min-w-0 font-mono text-[10.5px] text-brand-pink truncate"
            title={app.variants.pickedTarget.sourceFile
              ? `${app.variants.pickedTarget.selector}\n${app.variants.pickedTarget.sourceFile}`
              : app.variants.pickedTarget.selector}
          >
            {app.variants.pickedTarget.selector}
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
            onclick={() => app.clearPickedTarget()}
            aria-label="Clear picked element"
            title="Clear"
          >✕</button>
        </div>
      {:else}
        <button
          type="button"
          class="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-brand-pink/50 bg-brand-pink/5 dark:bg-brand-pink/10 px-2 py-1.5 text-[11.5px] font-medium text-brand-pink hover:bg-brand-pink/10 disabled:opacity-50"
          disabled={!!pending}
          onclick={() => void app.startVariantPick()}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><line x1="12" y1="1" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="1" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="23" y2="12"/></svg>
          Pick an element on the page
        </button>
      {/if}
    {/if}
  </div>

  <!-- Step 2 — Count -->
  <div class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-3">
    <div class="flex items-center gap-2">
      <span class="w-5 h-5 shrink-0 inline-flex items-center justify-center rounded-full bg-ink-100 dark:bg-night-alt text-[10.5px] font-semibold text-ink-600 dark:text-night-dim">2</span>
      <span class="text-[12px] font-semibold text-ink-900 dark:text-night-text">How many variants</span>
      <div class="ml-auto flex items-center gap-1">
        {#each VARIANT_COUNT_CHOICES as n (n)}
          <button
            type="button"
            class="w-6 h-6 inline-flex items-center justify-center rounded-full text-[11px] font-semibold transition-colors"
            class:bg-brand-pink={app.variants.count === n}
            class:text-white={app.variants.count === n}
            class:border={app.variants.count !== n}
            class:border-ink-200={app.variants.count !== n}
            class:text-ink-500={app.variants.count !== n}
            class:dark:border-night-line={app.variants.count !== n}
            class:dark:text-night-mute={app.variants.count !== n}
            title={`Generate ${n} variants${n > 3 ? " (more tokens per run)" : ""}`}
            onclick={() => app.setVariantsCount(n)}
          >
            {n}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <!-- Step 3 — Direction -->
  <div class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-3 space-y-2">
    <div class="flex items-center gap-2">
      <span class="w-5 h-5 shrink-0 inline-flex items-center justify-center rounded-full bg-ink-100 dark:bg-night-alt text-[10.5px] font-semibold text-ink-600 dark:text-night-dim">3</span>
      <span class="text-[12px] font-semibold text-ink-900 dark:text-night-text">Direction</span>
      <span class="text-[11px] text-ink-400 dark:text-night-mute">· optional</span>
    </div>
    <input
      type="text"
      class="w-full px-2.5 py-1.5 rounded-lg text-[12px] border border-ink-200 dark:border-night-line bg-white dark:bg-night-alt text-ink-800 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute focus:outline-none focus:border-brand-pink"
      placeholder="Describe a look — glassy, more compact, bolder…"
      maxlength={MAX_DIRECTION_CHARS}
      value={app.variants.direction}
      oninput={(e) => app.setVariantsDirection(e.currentTarget.value)}
      disabled={!!pending}
    />
    <div class="flex items-center gap-1.5 flex-wrap">
      {#each DIRECTION_CHIPS as chip (chip)}
        <button
          type="button"
          class={`px-2 py-0.5 rounded-full text-[10.5px] font-medium transition-colors ${
            app.variants.direction === chip
              ? "bg-brand-pink text-white"
              : "bg-brand-pink/10 text-brand-pink dark:text-brand-pink-light hover:bg-brand-pink/15"
          }`}
          disabled={!!pending}
          onclick={() => toggleDirectionChip(chip)}
        >
          {chip}
        </button>
      {/each}
    </div>
  </div>

  <div class="space-y-1">
    <button
      type="button"
      class="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-[12.5px] font-semibold text-white bg-gradient-to-r from-brand-pink to-brand-magenta hover:opacity-95 disabled:opacity-50 shadow-sm transition-opacity"
      disabled={!connected ||
        !!pending ||
        (app.variants.scopeKind === "element" && !app.variants.pickedTarget)}
      onclick={() => void app.runVariantsGenerate()}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.2 6.6a1.5 1.5 0 0 0 .95.95L21.75 12l-6.6 2.2a1.5 1.5 0 0 0-.95.95L12 21.75l-2.2-6.6a1.5 1.5 0 0 0-.95-.95L2.25 12l6.6-2.2a1.5 1.5 0 0 0 .95-.95L12 2.25z"/></svg>
      Generate {app.variants.count} variants
    </button>
    <p class="text-center text-[10.5px] text-ink-400 dark:text-night-mute">
      Variants stay inside your design system tokens
    </p>
  </div>

  {#if pending}
    <div class="rounded-md border border-ink-200 dark:border-night-line p-4 text-center space-y-2">
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

  <!-- Variant cards -->
  {#if run && run.variants.length > 0}
    <div class="flex items-center justify-between gap-2">
      <p class="text-[11px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
        {run.scope.kind === "element" ? "Element variants" : "Page variants"}
        · {device.label}
      </p>
      <div class="flex items-center gap-2">
        <!-- Zoom controls — shared by all cards. 100% = actual device
             pixels; "Fit" snaps back to fit-the-card-width. -->
        <div class="flex items-center gap-0.5">
          <button
            type="button"
            class="w-5 h-5 inline-flex items-center justify-center rounded border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:text-brand-pink text-[12px] leading-none"
            onclick={() => zoomBy(-0.25)}
            aria-label="Zoom out"
            title="Zoom out"
          >−</button>
          <span class="min-w-[38px] text-center text-[10.5px] tabular-nums text-ink-500 dark:text-night-mute" title="Preview zoom (100% = actual device pixels)">
            {Math.round(variantScale * 100)}%
          </span>
          <button
            type="button"
            class="w-5 h-5 inline-flex items-center justify-center rounded border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:text-brand-pink text-[12px] leading-none"
            onclick={() => zoomBy(0.25)}
            aria-label="Zoom in"
            title="Zoom in"
          >+</button>
          <button
            type="button"
            class="ml-1 px-1.5 h-5 inline-flex items-center rounded border border-ink-200 dark:border-night-line text-[10.5px] text-ink-600 dark:text-night-dim hover:text-brand-pink"
            onclick={() => (zoom = 1)}
            title="Fit the card width"
          >Fit</button>
        </div>
        <button
          type="button"
          class="text-[11px] underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
          onclick={newRun}
        >
          New run
        </button>
      </div>
    </div>
    {#each run.variants as v (v.id)}
      {@const applied = run.appliedVariantId === v.id}
      {@const previewing = app.variants.previewingVariantId === v.id}
      <div
        class="rounded-md border overflow-hidden"
        class:border-brand-pink={applied || previewing}
        class:border-ink-200={!applied && !previewing}
        class:dark:border-night-line={!applied && !previewing}
      >
        <div class="flex items-center justify-between gap-2 px-3 py-2 bg-ink-50 dark:bg-night-alt/50 border-b border-ink-200 dark:border-night-line">
          <div class="min-w-0">
            <h3 class="text-[12.5px] font-semibold text-ink-900 dark:text-night-text truncate">
              {v.label}
            </h3>
            {#if v.rationale}
              <p class="text-[10.5px] text-ink-500 dark:text-night-mute leading-snug">
                {v.rationale}
              </p>
            {/if}
          </div>
          {#if applied}
            <span class="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-brand-pink text-white text-[10px] font-semibold">
              Applied
            </span>
          {/if}
        </div>
        <!-- Sandboxed preview: EMPTY sandbox attr = no scripts, no
             same-origin, nothing. srcdoc is additionally sanitized.
             The frame renders at the device's real width, scaled to the
             card's measured width and centered — never clipped, never a
             narrow strip in a wide card. -->
        <div
          class="overflow-auto bg-white"
          style="height: {cardH}px;"
          bind:clientWidth={cardsW}
        >
          <!-- mx-auto centers when the scaled frame fits; when zoomed
               wider/taller than the window, the container scrolls (pan). -->
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
        {#if v.summary}
          <details class="px-3 py-1.5 border-t border-ink-200 dark:border-night-line">
            <summary class="text-[11px] text-ink-500 dark:text-night-mute cursor-pointer select-none">
              What would change
            </summary>
            <p class="mt-1 text-[11px] text-ink-700 dark:text-night-dim whitespace-pre-wrap leading-snug">
              {v.summary}
            </p>
          </details>
        {/if}
        <div class="flex items-center gap-2 px-3 py-2 border-t border-ink-200 dark:border-night-line">
          {#if run.scope.kind === "element"}
            <!-- Always rendered for element scope: a missing swap payload
                 disables it with a why, instead of vanishing silently. -->
            <button
              type="button"
              class="px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              class:border-brand-pink={previewing}
              class:text-brand-pink={previewing}
              class:dark:text-brand-pink-light={previewing}
              class:border-ink-200={!previewing}
              class:text-ink-600={!previewing}
              class:dark:border-night-line={!previewing}
              class:dark:text-night-dim={!previewing}
              disabled={!!pending || !canPreviewOnPage(v)}
              title={canPreviewOnPage(v)
                ? "Temporarily swap this design onto the live page — Restore puts it back"
                : "This variant has no in-page preview payload — restart /pinta (to load the updated skill §7.16) and regenerate"}
              onclick={() => togglePagePreview(v)}
            >
              {previewing ? "Restore page" : "Preview on page"}
            </button>
          {/if}
          <button
            type="button"
            class="px-2.5 py-1 inline-flex items-center gap-1 rounded-md text-[11px] font-medium border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:text-brand-pink transition-colors"
            title="Open this variant full screen in a new tab (real size)"
            onclick={() => openFullScreen(v)}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="15 3 21 3 21 9"/>
              <polyline points="9 21 3 21 3 15"/>
              <line x1="21" y1="3" x2="14" y2="10"/>
              <line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
            Full screen
          </button>
          <button
            type="button"
            class="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-50"
            disabled={!connected || !!pending || applied}
            onclick={() => void useVariant(v)}
          >
            {applied ? "Applied" : "Use this variant"}
          </button>
          <button
            type="button"
            class="px-2.5 py-1 rounded-md text-[11px] font-medium border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:text-brand-pink transition-colors inline-flex items-center gap-1.5"
            title="Refine this variant in chat — e.g. 'add a background color to the heading'"
            onclick={() => app.openVariantDiscuss(v.id)}
          >
            {#if app.variants.pendingDiscuss[v.id]}
              <svg class="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            {/if}
            Discuss
          </button>
        </div>
      </div>
    {/each}
    {#if run.appliedVariantId && run.applySummary}
      <div class="rounded-md border border-emerald-300 bg-emerald-50 dark:border-emerald-800/50 dark:bg-emerald-950/30 p-2.5 space-y-1">
        <p class="text-[11.5px] text-emerald-800 dark:text-emerald-300 leading-snug whitespace-pre-wrap">
          {run.applySummary}
        </p>
        {#if run.appliedFiles && run.appliedFiles.length > 0}
          <ul class="space-y-0.5">
            {#each run.appliedFiles as f (f.path)}
              <li class="text-[10.5px] font-mono text-emerald-700 dark:text-emerald-400 truncate" title={f.path}>
                {f.path}{f.note ? ` — ${f.note}` : ""}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {:else if !pending}
    <div class="rounded-md border border-dashed border-ink-300 dark:border-night-line p-4 text-center">
      <p class="text-[11.5px] text-ink-500 dark:text-night-mute leading-snug">
        Pick an element on your page (or switch to Whole page) and generate
        3 design variants that stay inside your design system.
      </p>
    </div>
  {/if}

  <!-- Pages gallery — live dev-server routes at the selected device width. -->
  <div class="space-y-2 pt-1">
    <div class="flex items-center justify-between gap-2">
      <p class="text-[11px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
        Pages · {device.label}
      </p>
      <div class="flex items-center gap-2.5">
        {#if app.variants.pages.length > 0}
          <button
            type="button"
            class="text-[11px] underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
            onclick={() => app.refreshGallery()}
          >
            Refresh all
          </button>
        {/if}
        <button
          type="button"
          class="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-pink hover:text-brand-magenta disabled:opacity-50"
          disabled={!connected || !!pending}
          onclick={() => void app.discoverPages()}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Discover pages
        </button>
      </div>
    </div>
    {#if app.variants.pages.length > 0}
      <div class="space-y-1.5">
        {#each app.variants.pages as p (p.path)}
          {@const hidden = hiddenPages.has(p.path)}
          <div class="flex items-center gap-1.5 rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-2.5 py-1.5 min-w-0">
            <span class="flex-1 min-w-0 font-mono text-[11px] text-brand-pink dark:text-brand-pink-light truncate" title={p.path}>
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
    <div class="flex items-center gap-1.5">
      <input
        type="text"
        class="flex-1 min-w-0 rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-2.5 py-1.5 text-[11.5px] font-mono text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute focus:outline-none focus:border-brand-pink"
        placeholder="/route"
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
    {#if app.variants.pages.length === 0}
      <p class="text-[10.5px] text-ink-400 dark:text-night-mute leading-snug">
        Add your app's key routes (or let the agent discover them) to see
        them side by side at any device width — like a mockup sheet, but
        it's your real running app.
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
        Frames show your live app — after applying a variant, Refresh all to
        see the new look everywhere. Apps that send X-Frame-Options / CSP
        frame-ancestors may refuse to render here.
      </p>
    {/if}
  </div>
</section>

{#if app.variants.discussVariantId}
  {@const dv = run?.variants.find((x) => x.id === app.variants.discussVariantId)}
  {#if dv}
    <ChatSheet
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
  {/if}
{/if}
