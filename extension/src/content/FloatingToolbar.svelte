<script lang="ts">
  import { onMount } from "svelte";
  import { TOOLS, type Tool } from "../lib/tools.js";

  type Props = {
    /** Current overlay mode (content.mode) + active draw tool, for
     *  highlighting the pressed button. */
    mode: string;
    tool: string;
    /** Fired when a tool button is clicked. Overlay maps it to setMode /
     *  the image picker. */
    onpick: (tool: Tool) => void;
  };
  let { mode, tool, onpick }: Props = $props();

  const POS_KEY = "pinta-toolbar-pos";

  // Draggable position (viewport coords). Restored from storage; defaults to
  // the upper-left so it doesn't collide with the side panel on the right.
  let x = $state(16);
  let y = $state(96);
  let dragging = $state(false);
  let collapsed = $state(false);

  onMount(() => {
    try {
      void chrome.storage?.local?.get(POS_KEY).then((s) => {
        const p = s?.[POS_KEY] as { x?: number; y?: number } | undefined;
        if (p && typeof p.x === "number" && typeof p.y === "number") {
          x = clampX(p.x);
          y = clampY(p.y);
        }
      });
    } catch {
      /* storage unavailable — keep defaults */
    }
  });

  function clampX(v: number): number {
    return Math.max(0, Math.min(v, window.innerWidth - 52));
  }
  function clampY(v: number): number {
    return Math.max(0, Math.min(v, window.innerHeight - 60));
  }

  let dragOffX = 0;
  let dragOffY = 0;
  function onGripDown(e: PointerEvent): void {
    dragging = true;
    dragOffX = e.clientX - x;
    dragOffY = e.clientY - y;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    e.preventDefault();
  }
  function onMove(e: PointerEvent): void {
    x = clampX(e.clientX - dragOffX);
    y = clampY(e.clientY - dragOffY);
  }
  function onUp(): void {
    dragging = false;
    window.removeEventListener("pointermove", onMove);
    try {
      void chrome.storage?.local?.set({ [POS_KEY]: { x, y } });
    } catch {
      /* ignore */
    }
  }

  function isActive(id: Tool, draw?: boolean): boolean {
    return draw ? mode === "draw" && tool === id : mode === id;
  }
</script>

<div
  class="pinta-fab"
  class:pinta-fab--dragging={dragging}
  style="left:{x}px; top:{y}px;"
  role="toolbar"
  aria-label="Pinta tools"
>
  <button
    type="button"
    class="pfab-grip"
    onpointerdown={onGripDown}
    ondblclick={() => (collapsed = !collapsed)}
    title="Drag to move · double-click to collapse"
    aria-label="Drag toolbar"
  >
    <span></span><span></span><span></span>
  </button>
  {#if !collapsed}
    <div class="pfab-grid">
      {#each TOOLS as t (t.id)}
        <button
          type="button"
          class="pfab-tool"
          class:pfab-tool--active={isActive(t.id, t.draw)}
          onclick={() => onpick(t.id)}
          aria-pressed={isActive(t.id, t.draw)}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true">{@html t.svg}</svg
          >
          <span class="pfab-tip">{t.label} <kbd>{t.key}</kbd></span>
        </button>
      {/each}
    </div>
  {/if}
</div>
