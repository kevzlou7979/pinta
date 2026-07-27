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
  let y = $state(120);
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
    return Math.max(0, Math.min(v, window.innerWidth - 60));
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
  class:dragging
  style="left:{x}px; top:{y}px;"
  role="toolbar"
  aria-label="Pinta tools"
>
  <button
    type="button"
    class="grip"
    onpointerdown={onGripDown}
    ondblclick={() => (collapsed = !collapsed)}
    title="Drag to move · double-click to collapse"
    aria-label="Drag toolbar"
  >
    <span></span><span></span><span></span>
  </button>
  {#if !collapsed}
    <div class="grid">
      {#each TOOLS as t (t.id)}
        <button
          type="button"
          class="tool"
          class:active={isActive(t.id, t.draw)}
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
          <span class="tip">{t.label} <kbd>{t.key}</kbd></span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .pinta-fab {
    position: fixed;
    z-index: 2147483646;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 5px;
    border-radius: 12px;
    background: #17171c;
    border: 1px solid #2c2c36;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
    user-select: none;
    font-family:
      ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .pinta-fab.dragging {
    cursor: grabbing;
  }
  .grip {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    height: 14px;
    border: 0;
    background: transparent;
    cursor: grab;
    padding: 0;
  }
  .grip span {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #565663;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 4px;
  }
  .tool {
    position: relative;
    width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    border: 1px solid transparent;
    background: #232330;
    color: #c9c9d4;
    cursor: pointer;
    transition:
      background 0.12s,
      color 0.12s,
      border-color 0.12s;
  }
  .tool:hover {
    background: #2e2e3d;
    color: #fff;
  }
  .tool.active {
    background: #ff3d6e;
    border-color: #ff3d6e;
    color: #fff;
  }
  .tool .tip {
    position: absolute;
    right: calc(100% + 8px);
    top: 50%;
    transform: translateY(-50%);
    white-space: nowrap;
    background: #0b0b0f;
    color: #fff;
    font-size: 11px;
    line-height: 1;
    padding: 5px 7px;
    border-radius: 6px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.1s;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  }
  .tool .tip kbd {
    margin-left: 4px;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    background: #2c2c36;
    border-radius: 3px;
    padding: 1px 4px;
  }
  .tool:hover .tip {
    opacity: 1;
  }
</style>
