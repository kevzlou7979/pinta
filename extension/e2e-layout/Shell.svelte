<script lang="ts">
  // Mirrors the side-panel shell in src/sidepanel/App.svelte (Settings view:
  // footer hidden). Keep these classes in sync with App.svelte — the harness
  // only proves something if the shell here matches the real one.
  import SettingsPanel from "../src/sidepanel/SettingsPanel.svelte";
</script>

<div id="shell-root" class="flex flex-col h-full overflow-clip">
  <header
    id="shell-header"
    class="shrink-0 px-4 py-3 border-b border-ink-200 bg-white dark:border-night-line dark:bg-night-card flex items-center justify-between"
  >
    <h1 class="font-semibold text-sm dark:text-night-text">Pinta</h1>
  </header>
  <div id="shell-body" class="flex-1 relative flex flex-col min-h-0">
    <main id="shell-main" class="flex-1 min-h-0 overflow-y-auto overflow-x-clip p-4 pb-20 space-y-4">
      <SettingsPanel />
    </main>
    <button
      type="button"
      id="shell-fab"
      class="absolute bottom-5 right-5 z-20 w-12 h-12 inline-flex items-center justify-center rounded-full bg-brand-pink text-white shadow-lg"
      aria-label="Ask Pinta"
    >?</button>
  </div>
</div>
