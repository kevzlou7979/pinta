<script lang="ts">
  import { theme, toggleTheme } from "../lib/theme.svelte.js";

  let opening = $state(false);
  let error = $state<string | null>(null);

  async function openSidePanel() {
    opening = true;
    error = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("no active tab");
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      opening = false;
    }
  }
</script>

<div class="p-4 space-y-3">
  <div class="flex items-center justify-between gap-2">
    <div class="flex items-center gap-2 min-w-0">
      <img src="/icons/icon-32.png" alt="" width="20" height="20" />
      <h1 class="font-semibold text-sm text-ink-900 dark:text-night-text">Pinta</h1>
    </div>
    <button
      type="button"
      class="w-7 h-7 inline-flex items-center justify-center rounded-full border border-ink-200 bg-white text-ink-600 hover:text-brand-pink hover:border-ink-400 dark:border-night-line dark:bg-night-card dark:text-night-dim dark:hover:text-brand-pink-light dark:hover:border-night-line2 transition-colors"
      onclick={toggleTheme}
      aria-label={theme.value === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme.value === "dark" ? "Light mode" : "Dark mode"}
    >
      {#if theme.value === "dark"}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
      {:else}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      {/if}
    </button>
  </div>

  <p class="text-xs text-ink-600 dark:text-night-dim">
    Open the side panel to start annotating the current page.
  </p>

  <button
    type="button"
    class="w-full rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50"
    disabled={opening}
    onclick={openSidePanel}
  >
    {opening ? "Opening…" : "Open side panel"}
  </button>

  {#if error}
    <p class="text-xs text-brand-pink">{error}</p>
  {/if}
</div>
