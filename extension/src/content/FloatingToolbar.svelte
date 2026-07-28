<script lang="ts">
  import { onMount } from "svelte";
  import {
    TOOL_SLOTS,
    DRAW_SHAPES,
    slotStartsNewGroup,
    type Tool,
    type ToolDef,
  } from "../lib/tools.js";
  import {
    DRAW_COLORS,
    DRAW_WIDTHS,
    DRAW_RADII,
  } from "../lib/draw-style.js";
  import { content } from "./state.svelte.js";
  import { PINTA_LOGO } from "./pinta-logo.js";

  type Props = {
    /** Current overlay mode (content.mode) + active draw tool, for
     *  highlighting the pressed button. */
    mode: string;
    tool: string;
    /** Fired when a tool button is clicked. Overlay maps it to setMode /
     *  the image picker. */
    onpick: (tool: Tool) => void;
    /** Fired for the non-tool actions group (Add task / By CSS selector). */
    onaction: (id: "add-task" | "add-selector") => void;
    /** Free Transform toggle state (drives the transform button's highlight —
     *  it's a toggle, not a mode). */
    transformOn: boolean;
  };
  let { mode, tool, onpick, onaction, transformOn }: Props = $props();

  const POS_KEY = "pinta-toolbar-pos";

  // Draggable position (viewport coords). Default + resize anchor is the
  // RIGHT edge, vertically centered.
  let x = $state(16);
  let y = $state(96);
  let dragging = $state(false);
  let collapsed = $state(false);
  let fabEl: HTMLDivElement | undefined = $state();

  /** Dock to the right edge, vertically centered — the always-visible home. */
  function anchorRightCenter(): void {
    const w = fabEl?.offsetWidth ?? 52;
    const h = fabEl?.offsetHeight ?? 320;
    x = Math.max(8, window.innerWidth - w - 12);
    y = Math.max(8, Math.round((window.innerHeight - h) / 2));
  }

  onMount(() => {
    // Always start docked right-center. We deliberately do NOT restore a
    // saved position — a stale off-screen value was leaving the palette
    // "nowhere to find". Dragging still works within the session; resize
    // (and reload) re-anchor to the guaranteed-visible home.
    anchorRightCenter();
    // Measure once more after layout settles, so a tall palette centers with
    // its real height (offsetHeight is 0 before first paint in some cases).
    requestAnimationFrame(anchorRightCenter);
    const onResize = () => anchorRightCenter();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  function clampX(v: number): number {
    return Math.max(0, Math.min(v, window.innerWidth - 52));
  }
  function clampY(v: number): number {
    return Math.max(0, Math.min(v, window.innerHeight - 60));
  }

  let dragOffX = 0;
  let dragOffY = 0;
  // Use pointer capture on the grip itself — NOT window listeners. The
  // overlay host traps pointerup in the bubble phase before it reaches
  // window, so a window pointerup never fires when the release lands over
  // our shadow DOM (you drag but can't drop). With capture, move/up retarget
  // to the grip element and fire AT_TARGET, ahead of the host's trap.
  function onGripDown(e: PointerEvent): void {
    dragging = true;
    dragOffX = e.clientX - x;
    dragOffY = e.clientY - y;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — move/up still fire while over the grip */
    }
    e.preventDefault();
  }
  function onGripMove(e: PointerEvent): void {
    if (!dragging) return;
    x = clampX(e.clientX - dragOffX);
    y = clampY(e.clientY - dragOffY);
  }
  function onGripUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    try {
      void chrome.storage?.local?.set({ [POS_KEY]: { x, y } });
    } catch {
      /* ignore */
    }
  }

  function isActive(id: Tool, draw?: boolean): boolean {
    if (id === "transform") return transformOn;
    return draw ? mode === "draw" && tool === id : mode === id;
  }

  // ── Draw flyout ──────────────────────────────────────────────────────
  // The shape tools live behind ONE slot: its face is the last-used shape,
  // the caret opens a flyout with all shapes + the stroke style options.
  let lastShape = $state<ToolDef>(DRAW_SHAPES[0]!);
  let flyoutOpen = $state(false);
  let drawSlotEl = $state<HTMLDivElement>();
  const drawActive = $derived(mode === "draw");

  // Keep the slot face in sync when the shape is picked elsewhere (side
  // panel row, single-key shortcut).
  $effect(() => {
    if (mode !== "draw") return;
    const def = DRAW_SHAPES.find((s) => s.id === tool);
    if (def) lastShape = def;
  });

  // Close the flyout on any pointerdown outside the slot (composedPath so
  // it works from inside the shadow root).
  $effect(() => {
    if (!flyoutOpen) return;
    function onDown(e: PointerEvent): void {
      if (drawSlotEl && e.composedPath().includes(drawSlotEl)) return;
      flyoutOpen = false;
    }
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  });

  function pickShape(s: ToolDef): void {
    lastShape = s;
    onpick(s.id);
  }
</script>

<div
  bind:this={fabEl}
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
    onpointermove={onGripMove}
    onpointerup={onGripUp}
    ondblclick={() => (collapsed = !collapsed)}
    title="Pinta — drag to move · double-click to collapse"
    aria-label="Pinta toolbar — drag to move"
  >
    <img
      class="pfab-logo"
      src={PINTA_LOGO}
      alt="Pinta"
      width="22"
      height="22"
      draggable="false"
    />
  </button>
  {#if !collapsed}
    <div class="pfab-grid">
      {#each TOOL_SLOTS as slot, i (slot.kind === "tool" ? slot.def.id : "draw-group")}
        {#if slotStartsNewGroup(i)}
          <div class="pfab-sep"></div>
        {/if}
        {#if slot.kind === "draw-group"}
          <div class="pfab-slot" bind:this={drawSlotEl}>
            <button
              type="button"
              class="pfab-tool"
              class:pfab-tool--active={drawActive}
              onclick={() => onpick(lastShape.id)}
              aria-pressed={drawActive}
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
                aria-hidden="true">{@html lastShape.svg}</svg
              >
              <span class="pfab-tip">{lastShape.label} <kbd>Ctrl+Alt+{lastShape.key}</kbd></span>
            </button>
            <button
              type="button"
              class="pfab-caret"
              onclick={() => (flyoutOpen = !flyoutOpen)}
              aria-expanded={flyoutOpen}
              aria-haspopup="menu"
              aria-label="Shapes and stroke style"
              title="Shapes & style"
            >
              <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"><path d="M8 8H0L8 0z"/></svg>
            </button>
            {#if flyoutOpen}
              <div class="pfab-flyout" role="menu" aria-label="Draw shapes and style">
                <div class="pfab-fly-row">
                  {#each DRAW_SHAPES as s (s.id)}
                    <button
                      type="button"
                      class="pfab-tool pfab-tool--sm"
                      class:pfab-tool--active={drawActive && tool === s.id}
                      onclick={() => pickShape(s)}
                      aria-pressed={drawActive && tool === s.id}
                      title="{s.label} (Ctrl+Alt+{s.key})"
                      aria-label={s.label}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{@html s.svg}</svg>
                    </button>
                  {/each}
                </div>
                <div class="pfab-fly-sep"></div>
                <div class="pfab-fly-label">Stroke</div>
                <div class="pfab-fly-row">
                  {#each DRAW_COLORS as c (c.hex)}
                    <button
                      type="button"
                      class="pfab-swatch"
                      class:pfab-swatch--on={content.drawStyle.color === c.hex}
                      style="background:{c.hex}"
                      onclick={() => content.setDrawStyle({ color: c.hex })}
                      title={c.name}
                      aria-label="Stroke color {c.name}"
                      aria-pressed={content.drawStyle.color === c.hex}
                    ></button>
                  {/each}
                </div>
                <div class="pfab-fly-row">
                  {#each DRAW_WIDTHS as w (w.value)}
                    <button
                      type="button"
                      class="pfab-seg"
                      class:pfab-seg--on={content.drawStyle.width === w.value}
                      onclick={() => content.setDrawStyle({ width: w.value })}
                      title="Stroke width {w.value}px"
                      aria-pressed={content.drawStyle.width === w.value}
                    >{w.label}</button>
                  {/each}
                  <button
                    type="button"
                    class="pfab-seg"
                    class:pfab-seg--on={content.drawStyle.dashed}
                    onclick={() => content.setDrawStyle({ dashed: !content.drawStyle.dashed })}
                    title="Dashed outline"
                    aria-pressed={content.drawStyle.dashed}
                  >Dash</button>
                </div>
                <div class="pfab-fly-label">Fill</div>
                <div class="pfab-fly-row">
                  <button
                    type="button"
                    class="pfab-seg"
                    class:pfab-seg--on={content.drawStyle.fill === "none"}
                    onclick={() => content.setDrawStyle({ fill: "none" })}
                    aria-pressed={content.drawStyle.fill === "none"}
                  >None</button>
                  <button
                    type="button"
                    class="pfab-seg"
                    class:pfab-seg--on={content.drawStyle.fill === "translucent"}
                    onclick={() => content.setDrawStyle({ fill: "translucent" })}
                    title="Translucent fill — highlight an area without hiding it"
                    aria-pressed={content.drawStyle.fill === "translucent"}
                  >Tint</button>
                  <button
                    type="button"
                    class="pfab-seg"
                    class:pfab-seg--on={content.drawStyle.fill === "solid"}
                    onclick={() => content.setDrawStyle({ fill: "solid" })}
                    title="Solid fill — blocks out what's underneath"
                    aria-pressed={content.drawStyle.fill === "solid"}
                  >Solid</button>
                </div>
                <div class="pfab-fly-label">Corner radius · rect</div>
                <div class="pfab-fly-row">
                  {#each DRAW_RADII as r (r)}
                    <button
                      type="button"
                      class="pfab-seg"
                      class:pfab-seg--on={content.drawStyle.radius === r}
                      onclick={() => content.setDrawStyle({ radius: r })}
                      aria-pressed={content.drawStyle.radius === r}
                    >{r}</button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {:else}
          {@const t = slot.def}
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
            <span class="pfab-tip">{t.label} <kbd>Ctrl+Alt+{t.key}</kbd></span>
          </button>
        {/if}
      {/each}
    </div>
    <div class="pfab-sep"></div>
    <div class="pfab-grid">
      <button
        type="button"
        class="pfab-tool"
        onclick={() => onaction("add-task")}
        aria-label="Add a task"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        <span class="pfab-tip">Add a task</span>
      </button>
      <button
        type="button"
        class="pfab-tool"
        onclick={() => onaction("add-selector")}
        aria-label="Add by CSS selector"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="8 6 3 12 8 18" /><polyline points="16 6 21 12 16 18" /></svg>
        <span class="pfab-tip">Add by CSS selector</span>
      </button>
    </div>
  {/if}
</div>
