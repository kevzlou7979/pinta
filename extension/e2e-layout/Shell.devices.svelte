<script lang="ts">
  // The real Devices canvas page. devices-pulse.cjs plays the side panel
  // and the service worker by delivering chrome.runtime messages.
  import DevicesApp from "../src/devices/DevicesApp.svelte";
  import { devices } from "../src/devices/devices-state.svelte.js";

  (window as unknown as { __devices: typeof devices }).__devices = devices;
</script>

<DevicesApp />
