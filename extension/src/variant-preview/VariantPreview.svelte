<script lang="ts">
  // Full-screen Design Variants preview. Reads the variant ONCE from
  // chrome.storage.session (key named by the one-time nonce in ?k=),
  // deletes it, and renders the sanitized document in an iframe with the
  // EMPTY sandbox — agent HTML never becomes an extension-origin document.
  import { onMount } from "svelte";
  import {
    buildSrcdoc,
    parseVariantPreviewPayload,
    variantPreviewKey,
  } from "../lib/design-variants.js";

  let label = $state("");
  let srcdoc = $state<string | null>(null);
  let error = $state<string | null>(null);

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    const key = variantPreviewKey(new URLSearchParams(location.search).get("k"));
    if (!key) {
      error = "This preview link is invalid. Open it again from the Pinta side panel.";
      return;
    }
    try {
      const got = await chrome.storage.session.get(key);
      await chrome.storage.session.remove(key);
      const payload = parseVariantPreviewPayload(got[key], Date.now());
      if (!payload) {
        error = "This preview has expired or was already opened. Open it again from the Pinta side panel.";
        return;
      }
      label = payload.label;
      document.title = `${payload.label} · Pinta variant`;
      srcdoc = buildSrcdoc(payload, { scroll: true });
    } catch {
      error = "Couldn't load the preview. Open it again from the Pinta side panel.";
    }
  }
</script>

<div class="h-screen flex flex-col bg-ink-50 dark:bg-night-bg text-ink-900 dark:text-night-text">
  <header class="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-ink-200 dark:border-night-line text-[12px]">
    <span class="font-semibold text-brand-pink">Pinta</span>
    <span class="min-w-0 truncate font-medium" title={label}>{label || "Variant preview"}</span>
    <span class="ml-auto shrink-0 text-[11px] text-ink-500 dark:text-night-mute">
      Sandboxed preview · scripts and network blocked
    </span>
  </header>

  {#if error}
    <div
      role="alert"
      class="m-3 flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-[12px] text-red-700 dark:text-red-300"
    >
      <p class="flex-1 min-w-0 break-words">{error}</p>
      <button
        type="button"
        class="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-900/40"
        aria-label="Dismiss"
        title="Dismiss"
        onclick={() => (error = null)}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  {/if}

  {#if srcdoc !== null}
    <iframe
      class="flex-1 w-full border-0 bg-white"
      title={`${label} preview`}
      sandbox=""
      referrerpolicy="no-referrer"
      {srcdoc}
    ></iframe>
  {/if}
</div>
