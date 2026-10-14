<script lang="ts">
  // The real side panel (App.svelte), whole, with the Motion module on.
  // Whole rather than MotionTab alone because motion.cjs also guards the
  // tab-bar gate, the leave-tab cleanup $effect and the motion.* runtime
  // handlers, which all live in App.svelte. There is no content script
  // here: motion.cjs plays the page, capturing what the panel sends to
  // the tab and answering as the overlay would.
  import App from "../src/sidepanel/App.svelte";
  import { app } from "../src/lib/state.svelte.js";

  app.setModuleEnabled("motion", true);
  (window as unknown as { __app: typeof app }).__app = app;
</script>

<App />
