<script lang="ts">
  import { onMount } from "svelte";
  import { captureTarget } from "./capture.js";

  let active = $state(false);
  let hovered: Element | null = $state(null);
  let selected: Element | null = $state(null);
  let comment = $state("");
  let tick = $state(0); // bump to force rect recomputation on scroll/resize

  const HOST_TAG = "pinta-overlay-host";

  function setActive(next: boolean) {
    active = next;
    if (!next) {
      hovered = null;
      selected = null;
      comment = "";
    }
  }

  function isOurNode(el: Element | null): boolean {
    return !!el?.closest?.(HOST_TAG);
  }

  // Listen for activation toggles from the side panel.
  onMount(() => {
    const handler = (msg: unknown) => {
      const m = msg as { type?: string; active?: boolean };
      if (m?.type === "select-mode.set") setActive(!!m.active);
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  });

  // 'S' hotkey to toggle from anywhere on page (skip text inputs).
  onMount(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "s" && e.key !== "S") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) return;
      setActive(!active);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Repaint highlight rects on scroll/resize.
  onMount(() => {
    const bump = () => (tick += 1);
    window.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    return () => {
      window.removeEventListener("scroll", bump, true);
      window.removeEventListener("resize", bump);
    };
  });

  // Hover/click capture while active.
  $effect(() => {
    if (!active) return;

    function onMove(e: MouseEvent) {
      if (selected) return;
      const el = e.target as Element | null;
      if (!el || el === document.documentElement || el === document.body) {
        hovered = null;
        return;
      }
      if (isOurNode(el)) return;
      hovered = el;
    }
    function onClick(e: MouseEvent) {
      const el = e.target as Element | null;
      if (!el || isOurNode(el)) return;
      e.preventDefault();
      e.stopPropagation();
      selected = el;
      hovered = null;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (selected) {
        selected = null;
        comment = "";
      } else {
        setActive(false);
      }
    }

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    };
  });

  function submit() {
    if (!selected || !comment.trim()) return;
    const target = captureTarget(selected);
    chrome.runtime.sendMessage({
      type: "annotation.target-selected",
      target,
      comment: comment.trim(),
      viewport: {
        scrollY: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
      },
    });
    setActive(false);
  }

  function cancelSelection() {
    selected = null;
    comment = "";
  }

  function rectOf(el: Element | null): {
    top: number;
    left: number;
    width: number;
    height: number;
  } | null {
    if (!el) return null;
    void tick; // re-run on scroll/resize
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  let hoverRect = $derived(rectOf(hovered));
  let selectedRect = $derived(rectOf(selected));

  const POPUP_W = 300;
  const POPUP_H = 140;

  function popupTop(r: { top: number; height: number }): number {
    if (r.top + r.height + 8 + POPUP_H < window.innerHeight) {
      return r.top + r.height + 8;
    }
    return Math.max(8, r.top - POPUP_H - 8);
  }
  function popupLeft(r: { left: number; width: number }): number {
    return Math.max(
      8,
      Math.min(window.innerWidth - POPUP_W - 8, r.left),
    );
  }

  function describe(el: Element | null): string {
    if (!el) return "";
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = [...el.classList][0];
    return cls ? `${tag}.${cls}` : tag;
  }
</script>

{#if active}
  {#if hoverRect && !selected}
    <div
      class="hl hl--hover"
      style:top="{hoverRect.top}px"
      style:left="{hoverRect.left}px"
      style:width="{hoverRect.width}px"
      style:height="{hoverRect.height}px"
    ></div>
    <div
      class="label"
      style:top="{Math.max(0, hoverRect.top - 22)}px"
      style:left="{hoverRect.left}px"
    >
      {describe(hovered)}
    </div>
  {/if}

  {#if selectedRect}
    <div
      class="hl hl--selected"
      style:top="{selectedRect.top}px"
      style:left="{selectedRect.left}px"
      style:width="{selectedRect.width}px"
      style:height="{selectedRect.height}px"
    ></div>
    <div
      class="popup"
      style:top="{popupTop(selectedRect)}px"
      style:left="{popupLeft(selectedRect)}px"
      style:width="{POPUP_W}px"
    >
      <div class="popup__head">{describe(selected)}</div>
      <textarea
        bind:value={comment}
        placeholder="What do you want changed?"
        rows="3"
      ></textarea>
      <div class="popup__actions">
        <button class="btn btn--ghost" onclick={cancelSelection}>Cancel</button>
        <button
          class="btn btn--primary"
          onclick={submit}
          disabled={!comment.trim()}
        >
          Add annotation
        </button>
      </div>
    </div>
  {/if}

  <div class="status">Select mode · click to pick · S or Esc to exit</div>
{/if}

<!-- Styles are injected into the shadow root by overlay.ts via styles.css -->

