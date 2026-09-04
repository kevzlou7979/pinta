<script lang="ts">
  // One device frame on the canvas: header bar (model picker + controls)
  // above a dark bezel wrapping the live, INTERACTIVE iframe. Unlike the
  // Variants gallery this frame takes pointer events — scrolling and
  // clicking happen natively inside the app.
  import { devices } from "./devices-state.svelte.js";
  import {
    DEVICE_CLASSES,
    dimsFor,
    effectiveScale,
    frameTitle,
    type DeviceFrame,
  } from "../lib/devices.js";

  const { frame, index }: { frame: DeviceFrame; index: number } = $props();

  const d = $derived(dimsFor(frame));
  const s = $derived(effectiveScale(frame, devices.state.globalZoom));
  const bezelW = $derived(Math.round(d.width * s) + 16);
  const grouped = $derived(
    DEVICE_CLASSES.map((cls) => ({
      cls,
      models: devices.catalog.filter((m) => m.class === cls),
    })).filter((g) => g.models.length > 0),
  );
  const knownModel = $derived(
    devices.catalog.some((m) => m.id === frame.modelId),
  );

  // Registered with the store so nav-sync postMessages can be identity-
  // matched back to this frame ({#key} recreates the element on refresh,
  // and bind:this re-fires with the new one).
  let iframeEl = $state<HTMLIFrameElement | null>(null);
  $effect(() => {
    devices.registerIframe(frame.id, iframeEl);
    return () => devices.registerIframe(frame.id, null);
  });

  // Free-drag: grab the header bar (not its controls) and move the
  // frame. Pointer capture keeps move events flowing to the header even
  // when the cursor crosses other frames' iframes mid-drag.
  let dragging = $state(false);
  function onHeaderPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, select, input")) return;
    e.preventDefault();
    devices.bringToFront(frame.id);
    dragging = true;
    const el = e.currentTarget as HTMLElement;
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev: PointerEvent): void => {
      devices.moveFrame(
        frame.id,
        (frame.x ?? 0) + ev.clientX - lastX,
        (frame.y ?? 0) + ev.clientY - lastY,
      );
      lastX = ev.clientX;
      lastY = ev.clientY;
    };
    const up = (ev: PointerEvent): void => {
      dragging = false;
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        // capture already gone — fine
      }
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.setPointerCapture(e.pointerId);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }
</script>

<div
  class="absolute flex flex-col gap-1.5"
  class:z-20={devices.frontId === frame.id}
  class:z-0={devices.frontId !== frame.id}
  style="left: {frame.x ?? 0}px; top: {frame.y ?? 0}px; width: max(300px, {bezelW}px);"
  role="group"
  aria-label={frameTitle(frame)}
  onpointerdowncapture={() => devices.bringToFront(frame.id)}
>
  <div
    class="flex items-center gap-1.5 rounded-lg bg-white dark:bg-night-card border border-ink-200 dark:border-night-line px-2 py-1.5 touch-none select-none"
    class:cursor-grab={!dragging}
    class:cursor-grabbing={dragging}
    title="Drag to move this frame"
    role="toolbar"
    aria-label="Frame controls — drag to move"
    tabindex={-1}
    onpointerdown={onHeaderPointerDown}
  >
    <span class="w-5 h-5 shrink-0 inline-flex items-center justify-center rounded-md bg-ink-100 dark:bg-night-alt text-[10.5px] font-semibold text-ink-600 dark:text-night-dim">
      {index + 1}
    </span>
    <select
      class="flex-1 min-w-0 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-alt px-1.5 py-1 text-[11.5px] font-medium text-ink-800 dark:text-night-text focus:outline-none focus:border-brand-pink"
      value={frame.modelId}
      title={frameTitle(frame)}
      aria-label="Device model"
      onchange={(e) => devices.setModel(frame.id, e.currentTarget.value)}
    >
      {#if !knownModel}
        <option value={frame.modelId} disabled>
          {frame.label} · {frame.width}×{frame.height} (removed)
        </option>
      {/if}
      {#each grouped as g (g.cls)}
        <optgroup label={g.cls}>
          {#each g.models as m (m.id)}
            <option value={m.id}>{m.label} · {m.width}×{m.height}</option>
          {/each}
        </optgroup>
      {/each}
    </select>
    <span class="shrink-0 text-[10px] tabular-nums text-ink-400 dark:text-night-mute" title="Rendered viewport">
      {d.width}×{d.height}
    </span>
    <button
      type="button"
      class="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-md text-ink-500 dark:text-night-dim hover:text-brand-pink"
      title="Rotate (portrait / landscape)"
      aria-label="Rotate device"
      onclick={() => devices.rotate(frame.id)}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
    </button>
    <div class="shrink-0 flex items-center gap-0.5">
      <button
        type="button"
        class="w-5 h-5 inline-flex items-center justify-center rounded border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:text-brand-pink text-[12px] leading-none"
        aria-label="Zoom out"
        title="Zoom this frame out"
        onclick={() => devices.frameZoom(frame.id, -1)}
      >−</button>
      <span class="min-w-[34px] text-center text-[10px] tabular-nums text-ink-500 dark:text-night-mute" title="Frame zoom">
        {frame.zoom}x
      </span>
      <button
        type="button"
        class="w-5 h-5 inline-flex items-center justify-center rounded border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:text-brand-pink text-[12px] leading-none"
        aria-label="Zoom in"
        title="Zoom this frame in"
        onclick={() => devices.frameZoom(frame.id, 1)}
      >+</button>
    </div>
    <button
      type="button"
      class="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-md text-ink-500 dark:text-night-dim hover:text-brand-pink"
      title="Reload this frame"
      aria-label="Reload frame"
      onclick={() => devices.refreshFrame(frame.id)}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
    </button>
    <button
      type="button"
      class="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-md text-ink-400 dark:text-night-mute hover:text-red-500 leading-none"
      title="Remove this frame"
      aria-label="Remove frame"
      onclick={() => devices.removeFrame(frame.id)}
    >✕</button>
  </div>

  <div class="rounded-[1.25rem] bg-night-alt p-2 shadow-lg self-start">
    <div
      class="overflow-hidden rounded-xl bg-white"
      style="width: {Math.round(d.width * s)}px; height: {Math.round(d.height * s)}px;"
    >
      {#if devices.srcFor(frame.id)}
        {#key frame.nonce}
          <iframe
            bind:this={iframeEl}
            src={devices.srcFor(frame.id)}
            title={frameTitle(frame)}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            referrerpolicy="no-referrer"
            loading="lazy"
            onload={() => devices.notifyFrameLoaded()}
            style="width: {d.width}px; height: {d.height}px; transform: scale({s}); transform-origin: top left; border: 0;"
          ></iframe>
        {/key}
      {/if}
    </div>
  </div>
</div>
