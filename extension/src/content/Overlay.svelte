<script lang="ts">
  import { onMount } from "svelte";
  import type { Annotation } from "@pinta/shared";
  import { captureTarget } from "./capture.js";
  import { content, type Mode, type Draft } from "./state.svelte.js";
  import type { DrawTool } from "./tools/draw.js";
  import Canvas from "./Canvas.svelte";
  import CommentInput from "./CommentInput.svelte";

  let hovered: Element | null = $state(null);
  let selected: Element | null = $state(null);
  let comment = $state("");
  let tick = $state(0);

  const HOST_TAG = "pinta-overlay-host";

  function isOurNode(el: Element | null): boolean {
    return !!el?.closest?.(HOST_TAG);
  }

  function clearSelectState() {
    hovered = null;
    selected = null;
    comment = "";
  }

  function setMode(next: Mode, tool?: DrawTool) {
    content.setMode(next);
    if (next === "draw" && tool) content.setTool(tool);
    if (next !== "select") clearSelectState();
  }

  // Listen for mode toggles from the side panel.
  onMount(() => {
    const handler = (msg: unknown) => {
      const m = msg as { type?: string; mode?: Mode; tool?: DrawTool };
      if (m?.type === "mode.set" && m.mode) setMode(m.mode, m.tool);
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  });

  // Hotkeys (chord-based to avoid clobbering normal page typing):
  //   Ctrl+Shift+S → toggle Select
  //   Ctrl+Shift+D → toggle Draw
  //   Ctrl+Shift+E → exit (back to Idle)
  //   Esc          → cancel in-progress / pending / mode (handled per-mode)
  // Ctrl+Shift+R is intentionally NOT used (browser hard-reload).
  onMount(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey) return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        setMode(content.mode === "select" ? "idle" : "select");
      } else if (key === "d") {
        e.preventDefault();
        setMode(content.mode === "draw" ? "idle" : "draw", content.tool);
      } else if (key === "e") {
        e.preventDefault();
        setMode("idle");
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Scroll/resize → repaint highlight rects.
  onMount(() => {
    const bump = () => (tick += 1);
    window.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    return () => {
      window.removeEventListener("scroll", bump, true);
      window.removeEventListener("resize", bump);
    };
  });

  // Select-mode pointer handlers.
  $effect(() => {
    if (content.mode !== "select") return;

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
      if (selected) clearSelectState();
      else setMode("idle");
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

  // Draw-mode escape handling (Canvas owns mouse).
  $effect(() => {
    if (content.mode !== "draw") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (content.pending) content.cancelPending();
      else if (content.inProgress) content.cancelInProgress();
      else setMode("idle");
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  // Submit a select annotation.
  let selectComment = $state("");
  function submitSelect() {
    if (!selected || !selectComment.trim()) return;
    const target = captureTarget(selected);
    chrome.runtime.sendMessage({
      type: "annotation.target-selected",
      target,
      comment: selectComment.trim(),
      viewport: snapshotViewport(),
    });
    selected = null;
    selectComment = "";
    setMode("idle");
  }

  // Submit a draft drawing as an annotation.
  let draftComment = $state("");
  function submitDraft() {
    if (!content.pending || !draftComment.trim()) return;
    const draft = content.pending;
    const annotation: Annotation = {
      id: draft.id,
      createdAt: draft.createdAt,
      kind: draft.kind,
      strokes: draft.strokes,
      color: draft.color,
      comment: draftComment.trim(),
      viewport: snapshotViewport(),
    };
    chrome.runtime.sendMessage({
      type: "annotation.draw-committed",
      annotation,
    });
    content.recordCommitted(annotation);
    content.cancelPending();
    draftComment = "";
  }

  function snapshotViewport() {
    return {
      scrollY: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  function rectOf(el: Element | null): {
    top: number;
    left: number;
    width: number;
    height: number;
  } | null {
    if (!el) return null;
    void tick;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  function rectOfDraft(d: Draft | null): {
    top: number;
    left: number;
    width: number;
    height: number;
  } | null {
    if (!d || d.strokes.length === 0) return null;
    void tick;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of d.strokes) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return {
      top: minY - window.scrollY,
      left: minX - window.scrollX,
      width: Math.max(8, maxX - minX),
      height: Math.max(8, maxY - minY),
    };
  }

  function describe(el: Element | null): string {
    if (!el) return "";
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = [...el.classList][0];
    return cls ? `${tag}.${cls}` : tag;
  }

  let hoverRect = $derived(rectOf(hovered));
  let selectedRect = $derived(rectOf(selected));
  let pendingRect = $derived(rectOfDraft(content.pending));
</script>

<Canvas />

{#if content.mode === "select"}
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
    <CommentInput
      anchor={selectedRect}
      title={describe(selected)}
      bind:value={selectComment}
      onsubmit={submitSelect}
      oncancel={clearSelectState}
    />
  {/if}
{/if}

{#if content.pending && pendingRect}
  <CommentInput
    anchor={pendingRect}
    title="{content.pending.kind}"
    bind:value={draftComment}
    onsubmit={submitDraft}
    oncancel={() => {
      content.cancelPending();
      draftComment = "";
    }}
  />
{/if}

{#if content.mode !== "idle"}
  <div class="status">
    {#if content.mode === "select"}
      Select mode · click to pick · Ctrl+Shift+S or Esc to exit
    {:else if content.mode === "draw"}
      Draw · {content.tool} · drag on page · Ctrl+Shift+D or Esc to exit
    {/if}
  </div>
{/if}

<!-- Styles are injected into the shadow root by overlay.ts via styles.css -->
