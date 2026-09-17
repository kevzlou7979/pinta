<script lang="ts">
  // Full-tab Devices canvas (Phase 24) — Mobile-View-style simulator:
  // a toolbar plus a dotted canvas of live device frames. Purely
  // client-side; no companion, no agent.
  import { onMount } from "svelte";
  import { devices, MAX_FRAMES } from "./devices-state.svelte.js";
  import DeviceFrameCard from "./DeviceFrame.svelte";
  import {
    CANVAS_GAP,
    DEVICE_CLASSES,
    DEVICE_GROUPS,
    frameOuterSize,
    modelsForGroup,
    type DeviceGroup,
  } from "../lib/devices.js";
  import { isDirectSubframeSender, parseAnnotateAck } from "../lib/devices-frame.js";

  let addModelId = $state("iphone-16-pro");
  let customW = $state(480);
  let customH = $state(800);
  let urlDraft = $state("");
  let hydrated = $state(false);

  let urlInputEl = $state<HTMLInputElement | null>(null);

  onMount(() => {
    void devices.hydrate().then(() => {
      urlDraft = devices.state.url;
      hydrated = true;
    });
    // Which tab this canvas is. Every message in and out is tagged with
    // it, so it has to be resolved before the runtime listener registers
    // (a miss there returns without calling sendResponse, which the panel
    // sees as a rejection) and before any frame message is forwarded (a
    // null tabId makes the panel drop it).
    let myTabId: number | null = null;
    // Never rejects: a rejection here would leave the runtime listener
    // unregistered forever and silently drop every frame message.
    const tabIdReady = chrome.tabs
      .getCurrent()
      .then((t) => {
        myTabId = t?.id ?? null;
      })
      .catch(() => {
        myTabId = null;
      });
    // Window messages from frames are nav reports only. Nothing the side
    // panel needs is relayed through this page: frames talk to the panel
    // over chrome.runtime and the panel answers with a frame-targeted
    // chrome.tabs.sendMessage (see lib/devices-frame.ts).
    const onMsg = (e: MessageEvent): void => {
      devices.handleNavMessage(e);
    };
    window.addEventListener("message", onMsg);
    const onRuntime = (
      msg: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (r: unknown) => void,
    ): boolean | undefined => {
      if (sender.id !== chrome.runtime.id) return;
      // A device frame's overlay confirming activation — accepted only
      // straight from a content script in a sub-frame of THIS tab.
      const ack = parseAnnotateAck(msg);
      if (ack) {
        if (isDirectSubframeSender(sender, chrome.runtime.id, myTabId)) {
          devices.handleAnnotateAck(ack.token, ack.on);
        }
        return;
      }
      const m = msg as { type?: string; tabId?: number; payload?: unknown } | null;
      if (m?.tabId !== myTabId) return;
      if (m.type === "devices.annotate-frame-rect") {
        void devices.annotateFrameRect().then((rect) => sendResponse({ rect }));
        return true;
      }
      if (m.type === "devices.reping-annotate") {
        // The panel didn't hear from a frame — re-activate the current
        // target so its overlay announces itself again.
        sendResponse({ annotating: devices.repingAnnotate() });
        return;
      }
      return;
    };
    let listening = false;
    let disposed = false;
    void tabIdReady.then(() => {
      if (disposed) return;
      chrome.runtime.onMessage.addListener(onRuntime);
      listening = true;
    });
    return () => {
      disposed = true;
      window.removeEventListener("message", onMsg);
      if (listening) chrome.runtime.onMessage.removeListener(onRuntime);
    };
  });

  // Keep the URL bar following sync navigations — but never while the
  // user is typing in it.
  $effect(() => {
    const url = devices.state.url;
    if (document.activeElement !== urlInputEl) urlDraft = url;
  });

  const grouped = $derived(
    DEVICE_CLASSES.map((cls) => ({
      cls,
      models: devices.catalog.filter((m) => m.class === cls),
    })).filter((g) => g.models.length > 0),
  );

  // Bulk-add entries: "All Mobile (5)" etc., only for non-empty groups.
  const groupOptions = $derived(
    DEVICE_GROUPS.map((g) => ({
      group: g,
      count: modelsForGroup(devices.catalog, g).length,
    })).filter((g) => g.count > 0),
  );

  function addSelected(): void {
    if (addModelId === "custom") {
      devices.addCustomFrame(Number(customW), Number(customH));
    } else if (addModelId.startsWith("group:")) {
      devices.addGroup(addModelId.slice("group:".length) as DeviceGroup);
    } else {
      devices.addFrame(addModelId);
    }
  }

  // Canvas extent — big enough for every placed frame plus a margin, so
  // the page scrolls (pans) to reach frames dragged beyond the viewport.
  const canvasSize = $derived.by(() => {
    let w = 0;
    let h = 0;
    for (const f of devices.state.frames) {
      const o = frameOuterSize(f, devices.state.globalZoom);
      w = Math.max(w, (f.x ?? 0) + o.w);
      h = Math.max(h, (f.y ?? 0) + o.h);
    }
    return { w: w + CANVAS_GAP, h: h + CANVAS_GAP };
  });

  function submitUrl(): void {
    devices.setUrl(urlDraft);
    urlDraft = devices.state.url;
  }

  function pickTab(url: string): void {
    if (!url) return;
    urlDraft = url;
    devices.setUrl(url);
    urlDraft = devices.state.url;
  }

  function clearAll(): void {
    const n = devices.state.frames.length;
    if (n === 0) return;
    if (window.confirm(`Remove all ${n} device frames from the canvas?`)) {
      devices.clearFrames();
    }
  }
</script>

<div class="h-screen flex flex-col overflow-hidden bg-ink-50 dark:bg-night-bg text-ink-900 dark:text-night-text">
  <header class="shrink-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-200 dark:border-night-line bg-white/90 dark:bg-night-bg/90 backdrop-blur px-4 py-2">
    <div class="flex items-center gap-2 shrink-0">
      <span class="w-5 h-5 rounded-md bg-brand-pink"></span>
      <span class="text-sm font-semibold">Pinta · Devices</span>
    </div>

    <div class="flex items-center gap-1.5 min-w-0 flex-1 basis-64">
      <input
        type="text"
        class="flex-1 min-w-0 rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-2.5 py-1.5 text-[12px] font-mono text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute focus:outline-none focus:border-brand-pink"
        placeholder="http://localhost:5173 — your running app"
        bind:this={urlInputEl}
        bind:value={urlDraft}
        onkeydown={(e) => {
          if (e.key === "Enter") submitUrl();
        }}
        onblur={submitUrl}
        aria-label="Target URL"
      />
      <select
        class="shrink-0 max-w-[160px] rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-1.5 py-1.5 text-[11px] text-ink-600 dark:text-night-dim focus:outline-none focus:border-brand-pink"
        value=""
        title="Use the URL of an open tab"
        aria-label="Use an open tab"
        onfocus={() => void devices.loadOpenTabs()}
        onchange={(e) => {
          pickTab(e.currentTarget.value);
          e.currentTarget.value = "";
        }}
      >
        <option value="" disabled>Open tabs…</option>
        {#each devices.openTabs as t (t.url)}
          <option value={t.url}>{t.title.slice(0, 40)}</option>
        {/each}
      </select>
      <button
        type="button"
        class="shrink-0 inline-flex items-center gap-1 rounded-lg border border-ink-200 dark:border-night-line px-2.5 py-1.5 text-[11px] font-medium text-ink-600 dark:text-night-dim hover:text-brand-pink"
        title="Reload every frame"
        onclick={() => devices.refreshAll()}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        Refresh all
      </button>
    </div>

    <div class="flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-lg border border-ink-200 dark:border-night-line px-2.5 py-1.5 text-[11px] font-medium text-ink-600 dark:text-night-dim hover:text-brand-pink disabled:opacity-50"
        title="Auto-align every frame into a tidy masonry layout"
        disabled={devices.state.frames.length === 0}
        onclick={() => devices.rearrange()}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="12" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="19" width="7" height="2" rx="1"/></svg>
        Rearrange
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-lg border border-ink-200 dark:border-night-line px-2.5 py-1.5 text-[11px] font-medium text-ink-600 dark:text-night-dim hover:text-red-500 hover:border-red-300 disabled:opacity-50"
        title="Remove every device frame from the canvas"
        disabled={devices.state.frames.length === 0}
        onclick={clearAll}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        Clear all
      </button>
    </div>

    <!-- Nav sync: navigating inside one frame drives the others. -->
    <button
      type="button"
      class="shrink-0 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors"
      class:border-brand-pink={devices.state.sync}
      class:text-brand-pink={devices.state.sync}
      class:border-ink-200={!devices.state.sync}
      class:text-ink-500={!devices.state.sync}
      class:dark:border-night-line={!devices.state.sync}
      class:dark:text-night-mute={!devices.state.sync}
      aria-pressed={devices.state.sync}
      title="When on, navigating in one frame navigates all the others too"
      onclick={() => devices.toggleSync()}
    >
      <span
        class="relative inline-flex h-3 w-5 items-center rounded-full transition-colors"
        class:bg-brand-pink={devices.state.sync}
        class:bg-ink-300={!devices.state.sync}
      >
        <span
          class="inline-block h-2 w-2 rounded-full bg-white transition-transform"
          class:translate-x-2.5={devices.state.sync}
          class:translate-x-0.5={!devices.state.sync}
        ></span>
      </span>
      Sync
    </button>

    <div class="flex items-center gap-0.5 shrink-0">
      <button
        type="button"
        class="w-6 h-6 inline-flex items-center justify-center rounded border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:text-brand-pink text-[13px] leading-none"
        aria-label="Global zoom out"
        title="Zoom the whole canvas out"
        onclick={() => devices.globalZoom(-1)}
      >−</button>
      <span class="min-w-[44px] text-center text-[11px] tabular-nums text-ink-500 dark:text-night-mute" title="Global zoom — multiplies every frame's own zoom">
        {devices.state.globalZoom}%
      </span>
      <button
        type="button"
        class="w-6 h-6 inline-flex items-center justify-center rounded border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:text-brand-pink text-[13px] leading-none"
        aria-label="Global zoom in"
        title="Zoom the whole canvas in"
        onclick={() => devices.globalZoom(1)}
      >+</button>
    </div>

    <div class="flex items-center gap-1.5 shrink-0">
      <select
        class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-1.5 py-1.5 text-[11.5px] text-ink-800 dark:text-night-text focus:outline-none focus:border-brand-pink"
        bind:value={addModelId}
        aria-label="Device or group to add"
      >
        <optgroup label="Groups">
          {#each groupOptions as g (g.group)}
            <option value={`group:${g.group}`}>
              {g.group === "Mobile"
                ? "All Mobile"
                : g.group === "Tablet"
                  ? "All Tablets"
                  : g.group === "Laptop"
                    ? "All Laptops"
                    : "All Desktops"} ({g.count})
            </option>
          {/each}
        </optgroup>
        {#each grouped as g (g.cls)}
          <optgroup label={g.cls}>
            {#each g.models as m (m.id)}
              <option value={m.id}>{m.label} · {m.width}×{m.height}</option>
            {/each}
          </optgroup>
        {/each}
        <optgroup label="Responsive config">
          <option value="custom">Custom size…</option>
        </optgroup>
      </select>
      {#if addModelId === "custom"}
        <div class="flex items-center gap-1">
          <input
            type="number"
            class="w-[64px] rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-1.5 py-1.5 text-[11.5px] tabular-nums text-ink-900 dark:text-night-text focus:outline-none focus:border-brand-pink"
            min="200"
            max="4000"
            bind:value={customW}
            aria-label="Custom width (px)"
            title="Width (px)"
          />
          <span class="text-[11px] text-ink-400 dark:text-night-mute">×</span>
          <input
            type="number"
            class="w-[64px] rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-1.5 py-1.5 text-[11.5px] tabular-nums text-ink-900 dark:text-night-text focus:outline-none focus:border-brand-pink"
            min="200"
            max="4000"
            bind:value={customH}
            aria-label="Custom height (px)"
            title="Height (px)"
          />
        </div>
      {/if}
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-lg bg-brand-pink px-3 py-1.5 text-[11.5px] font-semibold text-white hover:bg-brand-pink/90 disabled:opacity-50"
        disabled={devices.state.frames.length >= MAX_FRAMES}
        onclick={addSelected}
      >
        + Device
      </button>
    </div>
  </header>

  {#if devices.error}
    <div
      class="mx-4 mt-3 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[11.5px] text-red-700 dark:text-red-300 leading-snug"
      role="alert"
    >
      <p class="flex-1 min-w-0 break-words">{devices.error}</p>
      <button
        type="button"
        class="shrink-0 text-red-500 hover:text-red-700 dark:hover:text-red-200 leading-none px-1"
        onclick={() => (devices.error = null)}
        aria-label="Dismiss"
        title="Dismiss"
      >✕</button>
    </div>
  {/if}

  <!-- The canvas is the scroll surface (both axes) — the toolbar stays put. -->
  <main class="dot-grid flex-1 overflow-auto p-6">
    {#if !devices.state.url && hydrated}
      <div class="mx-auto mt-24 max-w-md rounded-xl border border-dashed border-ink-300 dark:border-night-line bg-white/70 dark:bg-night-card/70 p-6 text-center space-y-2">
        <p class="text-sm font-semibold">Point the canvas at your app</p>
        <p class="text-[12px] text-ink-500 dark:text-night-mute leading-snug">
          Enter your dev server's URL above (or pick an open tab) and every
          device frame renders it live — scroll, click, and test in each one.
        </p>
      </div>
    {:else if devices.state.frames.length === 0 && hydrated}
      <div class="mx-auto mt-24 max-w-md rounded-xl border border-dashed border-ink-300 dark:border-night-line bg-white/70 dark:bg-night-card/70 p-6 text-center space-y-2">
        <p class="text-sm font-semibold">The canvas is empty</p>
        <p class="text-[12px] text-ink-500 dark:text-night-mute leading-snug">
          Pick a device (or a whole group) in the toolbar and hit + Device.
        </p>
      </div>
    {:else}
      <!-- Free-drag surface: frames position themselves absolutely;
           the container is sized to fit them all so the page scrolls. -->
      <div
        class="relative"
        style="min-width: {canvasSize.w}px; min-height: {canvasSize.h}px;"
      >
        {#each devices.state.frames as frame, i (frame.id)}
          <DeviceFrameCard {frame} index={i} />
        {/each}
      </div>
    {/if}
    <p class="mt-8 mx-auto max-w-2xl text-center text-[10.5px] text-ink-400 dark:text-night-mute leading-snug">
      Frames are live iframes of your app — media queries respond to each
      device's real width. Apps that send X-Frame-Options / CSP
      frame-ancestors will refuse to render here, and cookie-based logins
      may not persist inside frames (Chrome partitions third-party
      storage). Custom devices: Pinta side panel → Settings → Devices.
    </p>
  </main>
</div>

<style>
  .dot-grid {
    background-image: radial-gradient(
      circle,
      rgb(148 163 184 / 0.45) 1px,
      transparent 1px
    );
    background-size: 18px 18px;
  }
  :global(html.dark) .dot-grid {
    background-image: radial-gradient(
      circle,
      rgb(58 58 69 / 0.55) 1px,
      transparent 1px
    );
  }
</style>
