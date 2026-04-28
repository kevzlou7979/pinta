<script lang="ts">
  import { onMount } from "svelte";
  import type { Annotation } from "@pinta/shared";
  import { captureTarget } from "./capture.js";
  import { content, type Mode, type Draft } from "./state.svelte.js";
  import type { DrawTool } from "./tools/draw.js";
  import Canvas from "./Canvas.svelte";
  import CommentInput from "./CommentInput.svelte";
  import ElementEditor from "./ElementEditor.svelte";

  let hovered: Element | null = $state(null);
  let selected: Element | null = $state(null);
  let comment = $state("");
  let tick = $state(0);

  const HOST_TAG = "pinta-overlay-host";

  function isOurNode(el: Element | null): boolean {
    return !!el?.closest?.(HOST_TAG);
  }

  function clearSelectState() {
    // Restore live-preview mutations BEFORE we drop the reference,
    // otherwise the page is left in whatever in-progress state the user
    // had typed.
    restoreOriginal();
    hovered = null;
    selected = null;
    comment = "";
    selectCustomCss = "";
    selectCssChanges = {};
    selectContentAfter = "";
  }

  function setMode(next: Mode, tool?: DrawTool) {
    content.setMode(next);
    if (next === "draw" && tool) content.setTool(tool);
    if (next !== "select") clearSelectState();
  }

  // Listen for mode toggles + annotated-pin lifecycle from the side panel.
  onMount(() => {
    const handler = (msg: unknown) => {
      const m = msg as {
        type?: string;
        mode?: Mode;
        tool?: DrawTool;
        annotationId?: string;
      };
      if (m?.type === "mode.set" && m.mode) setMode(m.mode, m.tool);
      else if (m?.type === "annotated.remove" && m.annotationId) {
        const { entry } = content.removeAnnotatedById(m.annotationId);
        if (entry) restoreFromSnapshot(entry);
      } else if (m?.type === "annotated.clear") {
        for (const entry of content.takeAllAnnotated()) {
          restoreFromSnapshot(entry);
        }
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  });

  // Hotkeys — Alt+letter for clean access without finger-twisting chords.
  // Chosen to avoid Chrome's reserved Alt combos: Alt+D focuses the URL
  // bar, Alt+E opens the menu, Alt+F is File menu. So we use:
  //   Alt+S → toggle Select   (mostly free across browsers)
  //   Alt+P → toggle Draw     (P for Pen — Alt+D is taken by URL bar)
  //   Alt+X → exit (Idle)     (eXit; Alt+E is the Chrome menu)
  //   Esc   → cancel in-progress / pending / mode (handled per-mode)
  onMount(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        setMode(content.mode === "select" ? "idle" : "select");
      } else if (key === "p") {
        e.preventDefault();
        setMode(content.mode === "draw" ? "idle" : "draw", content.tool);
      } else if (key === "x") {
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
      // Switching to a different element while edits were typed against
      // the previous one — restore the old element AND wipe editor state
      // so the new pick starts clean. Otherwise the live-preview effect
      // would re-apply the leftover changes to the new target.
      if (selected && selected !== el) {
        restoreOriginal();
        selectComment = "";
        selectCustomCss = "";
        selectCssChanges = {};
        selectContentAfter = "";
        textWasMutated = false;
      }
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
  let selectCustomCss = $state("");
  let selectCssChanges = $state<Record<string, string>>({});
  let selectContentAfter = $state("");

  // Snapshot of the element's original inline styles + innerHTML BEFORE
  // we start mutating it for live preview. Restored on Cancel / Submit
  // so the page stays clean between annotations. innerHTML (not
  // innerText) preserves nested children — assigning innerText collapses
  // <span>s, <a>s, etc. into plain text and destroys structure.
  let originalCssText = $state<string | null>(null);
  let originalInnerHtml = $state<string | null>(null);
  let originalText = $state<string | null>(null);
  // Plain (non-reactive) flag tracking whether we mutated the text via
  // innerText. Used to know if a restore is needed when the user clears
  // their Content edit.
  let textWasMutated = false;

  // Live values fed into the editor — recomputed when the selection
  // changes. tick is bumped on scroll/resize so getComputedStyle stays
  // fresh for elements that move.
  let liveStyles = $derived(computeLiveStyles(selected));
  let liveText = $derived(textOf(selected));

  function computeLiveStyles(el: Element | null) {
    void tick;
    const empty = {
      fontFamily: "",
      fontSize: "",
      fontWeight: "",
      color: "",
      lineHeight: "",
      width: "",
      height: "",
      padding: "",
      margin: "",
      backgroundColor: "",
      borderRadius: "",
      boxShadow: "",
      display: "",
    };
    if (!el) return empty;
    const cs = window.getComputedStyle(el);
    return {
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      color: cs.color,
      lineHeight: cs.lineHeight,
      width: cs.width,
      height: cs.height,
      padding: cs.padding,
      margin: cs.margin,
      backgroundColor: cs.backgroundColor,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow,
      display: cs.display,
    };
  }

  function textOf(el: Element | null): string {
    if (!el) return "";
    return ((el as HTMLElement).innerText ?? el.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Snapshot the live element when it's first selected so we can restore
  // it later. If the element was already annotated this session, reuse
  // that snapshot so re-editing builds on top of the *true* original
  // (not the post-first-annotation state).
  $effect(() => {
    if (selected) {
      const existing = content.findAnnotatedByElement(selected);
      if (existing) {
        originalCssText = existing.originalCssText;
        originalInnerHtml = existing.originalInnerHtml;
      } else {
        originalCssText = (selected as HTMLElement).style.cssText;
        originalInnerHtml = (selected as HTMLElement).innerHTML;
      }
      originalText = textOf(selected);
    } else {
      originalCssText = null;
      originalInnerHtml = null;
      originalText = null;
    }
    textWasMutated = false;
  });

  // Live DOM preview: whenever the editor's css/content state changes,
  // re-apply on top of the original snapshot. Cheap full-restore-and-
  // -reapply for styles avoids needing to track per-property deltas.
  // Text only gets touched if the user explicitly typed something
  // different from the original — otherwise we leave the element's
  // children alone (innerText assignment would destroy nested markup).
  $effect(() => {
    if (!selected || !selected.isConnected || originalCssText === null) return;
    const el = selected as HTMLElement;
    el.style.cssText = originalCssText;
    for (const [prop, val] of Object.entries(selectCssChanges)) {
      try {
        el.style.setProperty(prop, val);
      } catch {
        // ignore invalid property/value
      }
    }
    if (selectCustomCss.trim()) {
      const sep = el.style.cssText && !el.style.cssText.endsWith(";") ? "; " : "";
      el.style.cssText = el.style.cssText + sep + selectCustomCss.trim();
    }
    if (selectContentAfter && selectContentAfter !== originalText) {
      el.innerText = selectContentAfter;
      textWasMutated = true;
    } else if (textWasMutated && originalInnerHtml !== null) {
      // User cleared their Content edit — restore the original markup
      // (NOT innerText, which would collapse children).
      el.innerHTML = originalInnerHtml;
      textWasMutated = false;
    }
  });

  function restoreOriginal() {
    if (!selected || originalCssText === null) return;
    const el = selected as HTMLElement;
    if (!el.isConnected) return;
    el.style.cssText = originalCssText;
    if (textWasMutated && originalInnerHtml !== null) {
      el.innerHTML = originalInnerHtml;
      textWasMutated = false;
    }
  }

  /** Restore a previously-annotated element from its stored snapshot. */
  function restoreFromSnapshot(entry: {
    element: Element;
    originalCssText: string;
    originalInnerHtml: string;
  }): void {
    const el = entry.element as HTMLElement;
    if (!el?.isConnected) return;
    el.style.cssText = entry.originalCssText;
    if (el.innerHTML !== entry.originalInnerHtml) {
      el.innerHTML = entry.originalInnerHtml;
    }
  }

  function submitSelect() {
    if (!selected) return;
    const hasComment = selectComment.trim().length > 0;
    const hasCss = selectCustomCss.trim().length > 0;
    const hasChanges = Object.keys(selectCssChanges).length > 0;
    const contentDirty = selectContentAfter.trim() !== liveText.trim();
    if (!hasComment && !hasCss && !hasChanges && !contentDirty) return;
    // Capture target BEFORE restoring the DOM — so target.outerHTML +
    // computedStyles reflect the user's intended state, not the original.
    const target = captureTarget(selected);
    const beforeText = originalText ?? liveText;
    // Pre-generate the annotation ID so the content script and side
    // panel agree on it (used to clean up the pin badge if the user
    // removes the annotation from the side panel later).
    const annId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? `ann-${crypto.randomUUID()}`
        : `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // Record the snapshot WITH the annotation. If the element was
    // already annotated (re-edit), recordAnnotated stores another entry
    // pointing at the same true-original snapshot — that's fine, the
    // first remove restores fully and subsequent removes are no-ops.
    if (originalCssText !== null && originalInnerHtml !== null) {
      content.recordAnnotated(annId, selected, originalCssText, originalInnerHtml);
    }
    chrome.runtime.sendMessage({
      type: "annotation.target-selected",
      annotationId: annId,
      target,
      comment: selectComment.trim(),
      customCss: hasCss ? selectCustomCss.trim() : undefined,
      cssChanges: hasChanges ? selectCssChanges : undefined,
      contentChange: contentDirty
        ? { textBefore: beforeText, textAfter: selectContentAfter.trim() }
        : undefined,
      viewport: snapshotViewport(),
    });
    // Keep the inline preview applied — the user wants a cumulative
    // visual of all queued edits. The annotation's snapshot is in
    // `content.annotated`, so on Remove or Cancel-session we can roll
    // back this specific element. Just clear our editing handles.
    selected = null;
    selectComment = "";
    selectCustomCss = "";
    selectCssChanges = {};
    selectContentAfter = "";
    textWasMutated = false;
    setMode("idle");
  }
  function clearSelectAndCss() {
    restoreOriginal();
    clearSelectState();
    selectCustomCss = "";
    selectCssChanges = {};
    selectContentAfter = "";
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

<!-- Persistent pin badges for elements already annotated this session -->
{#each content.annotated as a (a.id)}
  {@const r = rectOf(a.element)}
  {#if r}
    <div
      class="pin"
      style:top="{Math.max(0, r.top - 8)}px"
      style:left="{Math.max(0, r.left + r.width - 16)}px"
      title="Annotation #{a.index}"
      aria-label="Annotation {a.index}"
    >{a.index}</div>
  {/if}
{/each}

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
    <ElementEditor
      anchor={selectedRect}
      title={describe(selected)}
      {liveText}
      {liveStyles}
      bind:comment={selectComment}
      bind:customCss={selectCustomCss}
      bind:cssChanges={selectCssChanges}
      bind:contentAfter={selectContentAfter}
      onsubmit={submitSelect}
      oncancel={clearSelectAndCss}
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
      Select mode · click to pick · Alt+S or Esc to exit
    {:else if content.mode === "draw"}
      Draw · {content.tool} · drag on page · Alt+P or Esc to exit
    {/if}
  </div>
{/if}

<!-- Styles are injected into the shadow root by overlay.ts via styles.css -->
