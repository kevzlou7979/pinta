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
    <div class="w-2.5 h-2.5 rounded-full bg-emerald-500"></div>
    <h1 class="font-semibold text-sm">Pinta</h1>
  </div>

  <p class="text-xs text-ink-600">
    Open the side panel to start annotating the current page.
  </p>

  <button
    type="button"
    class="w-full rounded-md bg-ink-900 text-white text-sm font-medium py-2 hover:bg-ink-800 disabled:opacity-50"
    disabled={opening}
    onclick={openSidePanel}
  >
    {opening ? "Opening…" : "Open side panel"}
  </button>

  {#if error}
    <p class="text-xs text-red-600">{error}</p>
  {/if}
</div>
