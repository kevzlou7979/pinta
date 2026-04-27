<script lang="ts">
  import type { WsClientStatus } from "../lib/ws-client.js";

  let { status }: { status: WsClientStatus } = $props();

  const labels: Record<WsClientStatus, string> = {
    connected: "Connected",
    connecting: "Connecting…",
    disconnected: "Offline",
  };

  const dotClasses: Record<WsClientStatus, string> = {
    connected: "bg-emerald-500",
    connecting: "bg-amber-400 animate-pulse",
    disconnected: "bg-red-500",
  };
</script>

<span
  class="inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] text-ink-700"
>
  <span class="w-2 h-2 rounded-full {dotClasses[status]}"></span>
  {labels[status]}
</span>
