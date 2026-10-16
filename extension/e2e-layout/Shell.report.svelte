<script lang="ts">
  // The real side panel (App.svelte), whole, with the Report module on.
  // Whole rather than ReportTab alone because report-owner.cjs also
  // guards the tab-bar gate and the session.synced routing that lives in
  // state.svelte.ts. There is no companion here: the script plays it,
  // capturing what the panel sends (`__app.client.send`) and answering
  // as the agent would (`__app.onMessage`).
  import App from "../src/sidepanel/App.svelte";
  import { app } from "../src/lib/state.svelte.js";

  app.setModuleEnabled("report", true);
  (window as unknown as { __app: typeof app }).__app = app;
</script>

<App />
