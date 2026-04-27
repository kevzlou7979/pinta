<script lang="ts">
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
  <div class="flex items-center gap-2">
    <img src="/icons/icon-32.png" alt="" width="20" height="20" />
    <h1 class="font-semibold text-sm">Pinta</h1>
  </div>

  <p class="text-xs text-ink-600">
    Open the side panel to start annotating the current page.
  </p>

  <button
    type="button"
    class="w-full rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta disabled:opacity-50"
    disabled={opening}
    onclick={openSidePanel}
  >
    {opening ? "Opening…" : "Open side panel"}
  </button>

  {#if error}
    <p class="text-xs text-brand-pink">{error}</p>
  {/if}
</div>
