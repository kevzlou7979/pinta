<script lang="ts">
  // The real Test Pilot tab inside the side-panel shell, standalone (no
  // companion): the state a tester is in when they import a sheet. Used by
  // docx-import.cjs.
  import TestPilotTab from "../src/sidepanel/TestPilotTab.svelte";
  import ConfirmModal from "../src/sidepanel/ConfirmModal.svelte";
  import { app } from "../src/lib/state.svelte.js";

  app.setModuleEnabled("test-pilot", true);
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
      <TestPilotTab />
    </main>
  </div>
</div>

<!-- App.svelte mounts this once; "Replace test catalog?" needs it. -->
<ConfirmModal />
