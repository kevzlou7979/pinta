<script lang="ts">
  // The real side panel (App.svelte), whole. There is no companion here:
  // resubmit-skipped.cjs plays it, seeding the Submitted tray and echoing
  // draft changes back as the companion would.
  import App from "../src/sidepanel/App.svelte";
  import { app } from "../src/lib/state.svelte.js";

  (window as unknown as { __app: typeof app }).__app = app;
</script>

<App />
