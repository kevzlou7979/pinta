<script lang="ts">
  import { onMount } from "svelte";
  import { drawAnnotation, badgeAnchor, drawNumberBadge } from "./tools/draw.js";
  import { content } from "./state.svelte.js";

  const COMMITTED_ALPHA = 0.55;
  const IN_PROGRESS_ALPHA = 1.0;
  const LINE_WIDTH = 3;

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let dpr = $state(window.devicePixelRatio || 1);
  let viewport = $state({ w: window.innerWidth, h: window.innerHeight });
  let scrollY = $state(window.scrollY);
  let scrollX = $state(window.scrollX);
  let drawing = $state(false);

  onMount(() => {
    ctx = canvas.getContext("2d");
    resize();

    const onResize = () => {
      dpr = window.devicePixelRatio || 1;
      viewport = { w: window.innerWidth, h: window.innerHeight };
      resize();
    };
    const onScroll = () => {
      scrollY = window.scrollY;
      scrollX = window.scrollX;
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  });

  function resize() {
    if (!canvas || !ctx) return;
    canvas.width = viewport.w * dpr;
    canvas.height = viewport.h * dpr;
    canvas.style.width = `${viewport.w}px`;
    canvas.style.height = `${viewport.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Re-render whenever committed/in-progress strokes or scroll/viewport change.
  $effect(() => {
    if (!ctx) return;
    void content.committed;
    void content.inProgress;
    void scrollX;
    void scrollY;
    void viewport;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.w, viewport.h);

    const translate = { x: scrollX, y: scrollY };

    // Selects render their own DOM-attached numbered badges via
    // Overlay.svelte (since they're anchored to live elements that
    // move/scroll). Everything else — arrow, rect, circle, freehand,
    // pin — gets a canvas-rendered badge here. Numbers come from
    // `globalSeq()` so the count is unified with selects and matches
    // the side panel + the composited screenshot.
    for (const a of content.committed) {
      if (a.kind === "select") continue;
      drawAnnotation(ctx, a.kind, a.strokes, {
        color: a.color,
        opacity: COMMITTED_ALPHA,
        lineWidth: LINE_WIDTH,
        translate,
      });
      const anchor = badgeAnchor(a.kind, a.strokes);
      const seq = content.globalSeq(a.id);
      if (anchor && seq > 0) {
        drawNumberBadge(
          ctx,
          anchor.x - translate.x,
          anchor.y - translate.y,
          seq,
          a.color,
        );
      }
    }

    if (content.inProgress) {
      drawAnnotation(
        ctx,
        content.inProgress.kind,
        content.inProgress.strokes,
        {
          color: content.inProgress.color,
          opacity: IN_PROGRESS_ALPHA,
          lineWidth: LINE_WIDTH,
          translate,
        },
      );
    }
  });

  function pageCoords(e: MouseEvent) {
    return { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
  }

  function onMouseDown(e: MouseEvent) {
    if (content.mode !== "draw") return;
    if (content.pending) return; // wait until current pending is resolved
    e.preventDefault();
    e.stopPropagation();
    drawing = true;
    content.beginStroke(pageCoords(e), "#FF3D6E");
  }
  function onMouseMove(e: MouseEvent) {
    if (!drawing) return;
    e.preventDefault();
    content.extendStroke(pageCoords(e));
  }
  function onMouseUp(e: MouseEvent) {
    if (!drawing) return;
    e.preventDefault();
    e.stopPropagation();
    drawing = false;
    content.endStroke();
  }

  let pointerEvents = $derived(
    content.mode === "draw" && !content.pending ? "auto" : "none",
  );
</script>

<canvas
  bind:this={canvas}
  class="canvas"
  style:pointer-events={pointerEvents}
  onmousedown={onMouseDown}
  onmousemove={onMouseMove}
  onmouseup={onMouseUp}
  onmouseleave={onMouseUp}
></canvas>
