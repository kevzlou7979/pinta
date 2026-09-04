<script lang="ts">
  // Phase 24 — Devices module launcher. The real surface is the full-tab
  // canvas (src/devices/) — the side panel just opens it with the
  // current app URL. No companion, no agent, no async state.
  import { app } from "../lib/state.svelte.js";

  let error = $state<string | null>(null);

  function openCanvas(): void {
    const target = app.lastKnownUrl ?? "";
    const url = chrome.runtime.getURL(
      `src/devices/index.html?url=${encodeURIComponent(target)}`,
    );
    void chrome.tabs.create({ url }).catch(() => {
      error = "Couldn't open the device canvas tab.";
    });
  }
</script>

<section class="space-y-3">
  <div>
    <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">
      Devices
    </h2>
    <p class="text-[10.5px] text-ink-500 dark:text-night-mute leading-snug">
      See your app on many devices at once
    </p>
  </div>

  {#if error}
    <div
      class="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[11.5px] text-red-700 dark:text-red-300 leading-snug"
      role="alert"
    >
      <p class="flex-1 min-w-0 break-words">{error}</p>
      <button
        type="button"
        class="shrink-0 text-red-500 hover:text-red-700 dark:hover:text-red-200 leading-none px-1"
        onclick={() => (error = null)}
        aria-label="Dismiss"
        title="Dismiss"
      >✕</button>
    </div>
  {/if}

  <div class="rounded-lg border border-ink-200 dark:border-night-line bg-white dark:bg-night-card p-3 space-y-2.5">
    <p class="text-[11.5px] text-ink-600 dark:text-night-dim leading-snug">
      The device canvas opens as its own browser tab: live, interactive
      frames of your running app — iPhone, Pixel, iPad, laptop, and
      desktop sizes side by side, each with its own zoom, rotate, and
      reload. Media queries respond to every frame's real width.
    </p>
    <button
      type="button"
      class="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[12.5px] font-semibold text-white bg-brand-pink hover:bg-brand-pink/90"
      onclick={openCanvas}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="13" height="10" rx="2"/><rect x="16" y="8" width="6" height="12" rx="2"/><line x1="5" y1="17" x2="11" y2="17"/></svg>
      Open device canvas
    </button>
  </div>

  <p class="text-[10.5px] text-ink-400 dark:text-night-mute leading-snug">
    Custom device sizes: Settings → Devices. Apps that send
    X-Frame-Options / CSP frame-ancestors won't render inside frames.
  </p>
</section>
