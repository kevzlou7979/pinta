<script lang="ts">
  // The real Design Variants tab inside the side-panel shell. There is no
  // companion here: variants-count.cjs plays it, capturing what the tab
  // sends and answering as the agent would.
  import DesignVariantsTab from "../src/sidepanel/DesignVariantsTab.svelte";
  import ConfirmModal from "../src/sidepanel/ConfirmModal.svelte";
  import { app } from "../src/lib/state.svelte.js";

  app.setModuleEnabled("design-variants", true);
  (window as unknown as { __app: typeof app }).__app = app;
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
      <DesignVariantsTab />
    </main>
  </div>
</div>

<!-- App.svelte mounts this once; "Reset Design variants?" needs it. -->
<ConfirmModal />
