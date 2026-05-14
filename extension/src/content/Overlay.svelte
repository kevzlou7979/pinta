<script lang="ts">
  import { onMount } from "svelte";
  import type { Annotation } from "@pinta/shared";
  import { captureTarget } from "./capture.js";
  import { content, type Mode, type Draft } from "./state.svelte.js";
  import { targetAnchor, type DrawTool } from "./tools/draw.js";
  import Canvas from "./Canvas.svelte";
  import CommentInput from "./CommentInput.svelte";
  import ElementEditor from "./ElementEditor.svelte";

  let hovered: Element | null = $state(null);
  let selected: Element | null = $state(null);
  // Ctrl/Cmd+click on additional elements queues them as extra targets
  // for the same comment. Live preview / inline edits still apply to the
  // primary `selected` only — extras are carriers for the agent.
  let extras: Element[] = $state([]);
  let comment = $state("");
  let tick = $state(0);
  // Reactive mirror of `location.href`. Updated whenever the content
  // script detects a client-side route change (hashchange / popstate /
  // pushState) so the badge template can filter to annotations made on
  // the current page only — without this, the rect cache would let
  // badges from one SPA route bleed onto every other route.
  let currentUrl = $state<string>(
    typeof location !== "undefined" ? location.href : "",
  );
  // Pulsating edge-glow shown while the agent is picking up and
  // applying the session. Toggled by `processing.start` / `processing.end`
  // messages the side panel sends when `sessionPending` flips. Off by
  // default — user enables in Settings → Visual feedback and picks a
  // color (blue / pink / green / purple / orange). Pure visual
  // feedback; pointer-events: none so the user can still interact with
  // their app while it's processing.
  let isProcessing = $state(false);
  let processingColor = $state<string>("#3B82F6");

  function hexToRgbTriple(hex: string): string {
    const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
    if (!m) return "59, 130, 246"; // fallback: blue
    return `${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}`;
  }

  /**
   * Read-only overlay for an imported `.pinta` session being viewed in
   * the side panel. When set, the page shows a metadata pill in the
   * top-right and numbered halos/badges for each annotation that can
   * be located on the current page (via target.selector). Cleared by
   * the side panel when the viewer closes.
   */
  type ImportedOverlay = {
    title: string;
    author: string;
    accentColor: string;
    annotations: Annotation[];
  };
  let imported: ImportedOverlay | null = $state(null);

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
    extras = [];
    comment = "";
    selectCustomCss = "";
    selectCssChanges = {};
    selectContentAfter = "";
    selectImages = [];
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
        dataUrl?: string;
        mediaType?: string;
        name?: string;
        imported?: ImportedOverlay;
        annotation?: Annotation;
      };
      if (m?.type === "mode.set" && m.mode) setMode(m.mode, m.tool);
      else if (m?.type === "processing.start") {
        if (typeof (msg as { color?: string }).color === "string") {
          processingColor = (msg as { color: string }).color;
        }
        isProcessing = true;
      }
      else if (m?.type === "processing.end") isProcessing = false;
      else if (m?.type === "annotated.replay" && m.annotation) {
        // Side panel is rehydrating us after navigation. Re-resolve the
        // selector and stamp a pin badge on the matching element. We
        // capture the element's *current* style/innerHTML as the
        // rollback snapshot — the element wasn't mutated by us this
        // time, so a future remove should leave it unchanged.
        replayAnnotation(m.annotation);
      }
      else if (m?.type === "image.place" && m.dataUrl) {
        // Side panel handed us a freshly-picked file. Decode natural
        // dimensions before pushing into state so the overlay can size
        // the placement rect proportionally to the image (instead of
        // using a hardcoded default that would distort the aspect).
        const probe = new Image();
        probe.onload = () => {
          content.setPendingImage({
            mediaType: m.mediaType ?? "image/png",
            dataUrl: m.dataUrl!,
            name: m.name,
            naturalWidth: probe.naturalWidth || 400,
            naturalHeight: probe.naturalHeight || 300,
          });
          // Snap any leftover select / draw state out of the way so
          // the image overlay isn't fighting another mode for input.
          clearSelectState();
          content.cancelPending();
          content.cancelInProgress();
        };
        probe.onerror = () => {
          // Bad bitmap — drop silently. The side panel will surface a
          // generic "couldn't load image" if it cared to track this.
        };
        probe.src = m.dataUrl;
      }
      else if (m?.type === "annotated.remove" && m.annotationId) {
        // The side panel doesn't know whether an annotation came from
        // select-mode (DOM element + pin badge) or draw-mode (canvas
        // stroke). Try both collections — exactly one will match.
        const { entry } = content.removeAnnotatedById(m.annotationId);
        if (entry) restoreFromSnapshot(entry);
        content.removeCommittedById(m.annotationId);
        // Drop the matching rect cache so a future replay doesn't pick
        // up the removed entry's last-known position.
        lastRectByEntry.delete(m.annotationId);
        // Also drop the in-flight pending draft if its id was just removed
        // — guards the corner case where the user removes from the side
        // panel while still typing the comment.
        if (content.pending?.id === m.annotationId) content.cancelPending();
      } else if (m?.type === "annotated.clear") {
        for (const entry of content.takeAllAnnotated()) {
          restoreFromSnapshot(entry);
        }
        content.clearCommitted();
        if (content.pending) content.cancelPending();
        if (content.inProgress) content.cancelInProgress();
        // Drop the rect cache too — otherwise stale page-coord rects
        // would resurrect ghost badges if the side panel later replays
        // a different annotation that happens to reuse the same id.
        lastRectByEntry.clear();
      } else if (m?.type === "imported.show" && m.imported) {
        // Clear any in-progress UI so the read-only overlay renders cleanly.
        clearSelectState();
        content.cancelPending();
        content.cancelInProgress();
        imported = m.imported;
      } else if (m?.type === "imported.hide") {
        imported = null;
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    // Tell the side panel we're alive so it can replay any annotations
    // from the current draft that were created on this URL — pins get
    // re-painted on reload / SPA nav. Best-effort: if no side panel is
    // open the message just dispatches into the void.
    const pingUrl = () => {
      try {
        void chrome.runtime
          .sendMessage({ type: "overlay.ready", url: location.href })
          ?.catch(() => {});
      } catch {
        // No extension context available — ignore.
      }
    };
    pingUrl();
    // SPA route change: the content script stays alive, but the DOM
    // typically re-renders so previously-painted pin badges point at
    // detached elements. We DON'T clear annotated here — the MutationObserver
    // below re-resolves selectors when the SPA finishes rendering, so
    // badges follow the element through subsequent re-renders. The ping
    // is just to update the side panel's view of the current URL.
    const onRouteChange = () => {
      currentUrl = location.href;
      queueMicrotask(pingUrl);
    };
    // Watch DOM mutations and re-resolve detached annotated elements
    // by their stored selectors. SPAs often render multiple times
    // during navigation (loading skeleton → loaded data); without this,
    // the first replay finds an element that gets detached on a later
    // render and the badge silently disappears.
    let mutationTimer: ReturnType<typeof setTimeout> | null = null;
    const mo = new MutationObserver(() => {
      if (mutationTimer) return;
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        if (content.annotated.length === 0) return;
        content.reresolveDetached();
        // Force a layout-tick bump so rectOf re-runs for entries whose
        // element references didn't change but whose page position did
        // (e.g. SPA moved the element within the same DOM subtree).
        tick += 1;
      }, 100);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    // chrome.tabs.onUpdated doesn't fire info.url for hash-only changes
    // and history.pushState is invisible to it too. The content script
    // sees these via native events, so re-ping on any client-side route
    // change. Without this, the side panel's pageUrl stays stale and
    // newly-created annotations land under the wrong page in the chip.
    addEventListener("hashchange", onRouteChange);
    addEventListener("popstate", onRouteChange);
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    history.pushState = function (...args) {
      const ret = origPushState.apply(this, args as Parameters<typeof origPushState>);
      onRouteChange();
      return ret;
    };
    history.replaceState = function (...args) {
      const ret = origReplaceState.apply(this, args as Parameters<typeof origReplaceState>);
      onRouteChange();
      return ret;
    };
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
      removeEventListener("hashchange", onRouteChange);
      removeEventListener("popstate", onRouteChange);
      history.pushState = origPushState;
      history.replaceState = origReplaceState;
      mo.disconnect();
      if (mutationTimer) clearTimeout(mutationTimer);
    };
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

    // Re-enable pointer events on disabled form controls while in select
    // mode. Many CSS frameworks (Tailwind's `disabled:pointer-events-none`,
    // MUI `.Mui-disabled`, etc.) hide disabled elements from the cursor
    // entirely — without this override, mouse events would pass straight
    // through and the user couldn't even highlight them.
    const styleEl = document.createElement("style");
    styleEl.dataset.pintaSelectModeOverride = "1";
    styleEl.textContent = `
      button[disabled], input[disabled], select[disabled], textarea[disabled],
      fieldset[disabled], fieldset[disabled] *,
      [aria-disabled="true"], [aria-disabled="true"] * {
        pointer-events: auto !important;
        cursor: crosshair !important;
      }
    `;
    document.head.appendChild(styleEl);

    function isDisabledFormControl(el: Element): boolean {
      // Native `disabled` on form elements suppresses `click` per HTML
      // spec — that's the case we route through `mousedown` below.
      // `aria-disabled="true"` does NOT suppress click in browsers, but
      // some component libs (Radix, Headless UI) intercept and swallow
      // it; cheaper to treat it the same.
      if ("disabled" in el && (el as HTMLButtonElement).disabled) return true;
      if (el.getAttribute("aria-disabled") === "true") return true;
      return el.closest("fieldset[disabled]") !== null;
    }

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
    function onMouseDown(e: MouseEvent) {
      // `click` doesn't fire on natively-disabled form controls, so route
      // their `mousedown` through the same selection path. Plain (non-
      // disabled) elements continue to use the `click` handler — switching
      // everything to mousedown would change select-on-press semantics
      // and risk firing on accidental drag-starts.
      if (e.button !== 0) return;
      const el = e.target as Element | null;
      if (!el || isOurNode(el)) return;
      if (!isDisabledFormControl(el)) return;
      onClick(e);
    }
    function onClick(e: MouseEvent) {
      const el = e.target as Element | null;
      if (!el || isOurNode(el)) return;
      e.preventDefault();
      e.stopPropagation();

      // Ctrl/Cmd+click → multi-select. Toggles the element in/out of
      // `extras` without disturbing the primary selection or its live
      // preview. The primary is unchanged so the inline editor stays
      // anchored to the same popover; extras are pure agent-targets.
      const isModifier = e.ctrlKey || e.metaKey;
      if (isModifier && selected) {
        if (el === selected) return; // clicking primary itself does nothing
        const i = extras.indexOf(el);
        if (i >= 0) {
          // Toggle off — remove from extras.
          extras = extras.filter((_, idx) => idx !== i);
        } else {
          extras = [...extras, el];
        }
        hovered = null;
        return;
      }

      // Plain click — replaces both primary and extras. Switching the
      // primary while edits were typed against the previous one means
      // we restore the old element AND wipe editor state so the new
      // pick starts clean. Otherwise the live-preview effect would
      // re-apply the leftover changes to the new target.
      if (selected && selected !== el) {
        restoreOriginal();
        selectComment = "";
        selectCustomCss = "";
        selectCssChanges = {};
        selectContentAfter = "";
        selectImages = [];
        textWasMutated = false;
      }
      selected = el;
      extras = [];
      hovered = null;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (selected) clearSelectState();
      else setMode("idle");
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      styleEl.remove();
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

  // Image-mode escape: cancel the pending placement entirely. Unlike
  // draw mode there's no "in-progress" vs "pending" distinction —
  // either you have a placed image or you don't.
  $effect(() => {
    if (content.mode !== "image") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") content.cancelPendingImage();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  // Comment for the in-flight image placement. Cleared on submit/cancel.
  let imageComment = $state("");

  // Drag / resize bookkeeping. We keep deltas in a closure-local var
  // (not $state) because pointer events fire faster than Svelte can
  // schedule reactivity passes — direct mutation of state on each move
  // is fine since we DO want re-renders, but the *original* placement
  // we're computing offsets from must not change mid-gesture.
  function onImageDragStart(e: PointerEvent) {
    if (!content.pendingImage || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { ...content.pendingImage };
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startClientX;
      const dy = ev.clientY - startClientY;
      content.updatePendingImage({ x: start.x + dx, y: start.y + dy });
    }
    function onUp(ev: PointerEvent) {
      try { target.releasePointerCapture(ev.pointerId); } catch { /* released by browser */ }
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  type Corner = "nw" | "ne" | "sw" | "se";

  function onImageResizeStart(e: PointerEvent, corner: Corner) {
    if (!content.pendingImage || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { ...content.pendingImage };
    const ratio = start.width / start.height;
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startClientX;
      const dy = ev.clientY - startClientY;
      // Aspect-locked resize — drives off the *primary* axis (x) and
      // computes y from the original ratio. Predictable behavior, no
      // drift from rounding errors that would otherwise compound across
      // repeated resizes.
      let nextW = start.width;
      let nextH = start.height;
      let nextX = start.x;
      let nextY = start.y;
      const signX = corner === "nw" || corner === "sw" ? -1 : 1;
      const signY = corner === "nw" || corner === "ne" ? -1 : 1;
      // Use whichever axis the user moved more of, but lock to ratio.
      const projected = signX * dx > signY * dy ? signX * dx : signY * dy;
      nextW = Math.max(40, start.width + projected);
      nextH = nextW / ratio;
      if (signX < 0) nextX = start.x + (start.width - nextW);
      if (signY < 0) nextY = start.y + (start.height - nextH);
      content.updatePendingImage({ x: nextX, y: nextY, width: nextW, height: nextH });
    }
    function onUp(ev: PointerEvent) {
      try { handle.releasePointerCapture(ev.pointerId); } catch { /* released by browser */ }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  // Live viewport rect of the pending image (page coords → viewport
  // coords, includes scroll). Recomputed reactively on tick (scroll/
  // resize) so the overlay stays anchored to the page if the user
  // scrolls while positioning.
  let pendingImageRect = $derived.by(() => {
    void tick;
    const p = content.pendingImage;
    if (!p) return null;
    return {
      top: p.y - window.scrollY,
      left: p.x - window.scrollX,
      width: p.width,
      height: p.height,
    };
  });

  function submitImage() {
    const p = content.pendingImage;
    if (!p) return;
    const trimmed = imageComment.trim();
    if (!trimmed) return;
    const annId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? `ann-${crypto.randomUUID()}`
        : `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const placement = { x: p.x, y: p.y, width: p.width, height: p.height };
    // Resolve the DOM element under the image's center — same trick as
    // resolveDrawingTarget. Gives the agent a selector + outerHTML to
    // anchor the change against, even though the user "drew" with an
    // image instead of a stroke. Fall through silently if the center
    // is offscreen / over our own host.
    const cx = p.x + p.width / 2 - window.scrollX;
    const cy = p.y + p.height / 2 - window.scrollY;
    let target: import("@pinta/shared").AnnotationTarget | undefined;
    if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
      const el = document.elementFromPoint(cx, cy);
      if (el && el.tagName !== "PINTA-OVERLAY-HOST") {
        target = captureTarget(el);
      }
    }
    const annotation: import("@pinta/shared").Annotation = {
      id: annId,
      createdAt: Date.now(),
      kind: "image",
      strokes: [],
      color: "#FF3D6E",
      comment: trimmed,
      images: [
        {
          id: "image1",
          mediaType: p.mediaType,
          dataUrl: p.dataUrl,
          name: p.name,
          placement,
        },
      ],
      target,
      targets: target ? [target] : undefined,
      viewport: snapshotViewport(),
      url: location.href,
    };
    chrome.runtime.sendMessage({ type: "annotation.draw-committed", annotation });
    content.recordCommitted(annotation);
    content.cancelPendingImage();
    imageComment = "";
  }

  function cancelImage() {
    content.cancelPendingImage();
    imageComment = "";
  }

  // Submit a select annotation.
  let selectComment = $state("");
  let selectCustomCss = $state("");
  let selectCssChanges = $state<Record<string, string>>({});
  let selectContentAfter = $state("");
  let selectImages = $state<import("@pinta/shared").AnnotationImage[]>([]);

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

  /**
   * Re-attach a pin badge for a previously-recorded select-mode
   * annotation after the content script was re-injected (page reload /
   * navigation). Only kind="select" is replayed in v1 — drawing strokes
   * are skipped because their canvas would need scroll-anchored
   * page-coords that don't transplant cleanly across page geometry
   * changes.
   *
   * Selector resolution is best-effort: if the page's DOM diverged from
   * when the annotation was captured, querySelector returns null and we
   * silently skip the halo. The side-panel card still appears for the
   * user to edit/remove.
   */
  function replayAnnotation(ann: Annotation, attempt = 0): void {
    if (ann.kind !== "select") return;
    const targets = ann.targets ?? (ann.target ? [ann.target] : []);
    const primary = targets[0];
    if (!primary) return;
    // Skip if already painted (defensive — re-mounts from frame nav can
    // double-fire the overlay.ready handshake). Checked first so retries
    // that race with another replay path bail cleanly.
    if (content.annotated.some((a) => a.id === ann.id)) return;
    // 3-tier resolve: selector → outerHTML → nearbyText. Same logic the
    // MutationObserver uses for re-resolve, so initial paint and
    // subsequent re-renders behave consistently.
    const el = content.findElementForEntry({
      selector: primary.selector,
      outerHTML: primary.outerHTML,
      nearbyText: primary.nearbyText,
    });
    if (!el) {
      // SPA might not have rendered the new view yet. Retry with backoff
      // (50ms, 200ms, 500ms, 1000ms) before giving up — covers most
      // framework render delays without burning time on dead selectors.
      const delays = [50, 200, 500, 1000];
      if (attempt < delays.length) {
        setTimeout(() => replayAnnotation(ann, attempt + 1), delays[attempt]);
      }
      return;
    }
    // Snapshot the element's current state so a future Remove leaves it
    // unchanged (we didn't mutate anything during replay).
    const html = el as HTMLElement;
    content.recordAnnotated(
      ann.id,
      el,
      html.style?.cssText ?? "",
      html.innerHTML,
      primary.selector,
      primary.outerHTML,
      primary.nearbyText,
      ann.url ?? location.href,
    );
  }

  function submitSelect() {
    if (!selected) return;
    const hasComment = selectComment.trim().length > 0;
    const hasCss = selectCustomCss.trim().length > 0;
    const hasChanges = Object.keys(selectCssChanges).length > 0;
    const hasImages = selectImages.length > 0;
    const contentDirty = selectContentAfter.trim() !== liveText.trim();
    if (!hasComment && !hasCss && !hasChanges && !contentDirty && !hasImages) return;
    // Capture every target BEFORE restoring the DOM — so target.outerHTML
    // + computedStyles reflect the user's intended state, not the
    // original. Primary first, then each ctrl-clicked extra (in click
    // order) so the agent can reason about them in the same order the
    // user picked them.
    const targets = [captureTarget(selected), ...extras.map(captureTarget)];
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
    // Only the primary gets a snapshot — extras are not mutated by the
    // editor, so they don't need rollback bookkeeping.
    if (originalCssText !== null && originalInnerHtml !== null) {
      content.recordAnnotated(
        annId,
        selected,
        originalCssText,
        originalInnerHtml,
        targets[0]?.selector,
        targets[0]?.outerHTML,
        targets[0]?.nearbyText,
        location.href,
      );
    }
    chrome.runtime.sendMessage({
      type: "annotation.target-selected",
      annotationId: annId,
      targets,
      groupingMode: targets.length > 1 ? "single-edit" : undefined,
      comment: selectComment.trim(),
      customCss: hasCss ? selectCustomCss.trim() : undefined,
      cssChanges: hasChanges ? selectCssChanges : undefined,
      contentChange: contentDirty
        ? { textBefore: beforeText, textAfter: selectContentAfter.trim() }
        : undefined,
      images: hasImages ? selectImages : undefined,
      viewport: snapshotViewport(),
      url: location.href,
    });
    // Keep the inline preview applied — the user wants a cumulative
    // visual of all queued edits. The annotation's snapshot is in
    // `content.annotated`, so on Remove or Cancel-session we can roll
    // back this specific element. Just clear our editing handles.
    selected = null;
    extras = [];
    selectComment = "";
    selectCustomCss = "";
    selectCssChanges = {};
    selectContentAfter = "";
    selectImages = [];
    textWasMutated = false;
    setMode("idle");
  }
  function clearSelectAndCss() {
    restoreOriginal();
    clearSelectState();
    selectCustomCss = "";
    selectCssChanges = {};
    selectContentAfter = "";
    selectImages = [];
  }

  // Submit a draft drawing as an annotation.
  let draftComment = $state("");
  let draftImages = $state<import("@pinta/shared").AnnotationImage[]>([]);
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
      // Resolve the element under the drawing's "target anchor" (arrow
      // head end, centroid for shapes, point for pin) so the annotation
      // carries a selector + outerHTML even when the consumer can't see
      // the screenshot — e.g. an agent reading just the .md file.
      target: resolveDrawingTarget(draft) ?? undefined,
      images: draftImages.length ? draftImages : undefined,
      url: location.href,
    };
    chrome.runtime.sendMessage({
      type: "annotation.draw-committed",
      annotation,
    });
    content.recordCommitted(annotation);
    content.cancelPending();
    draftComment = "";
    draftImages = [];
  }

  function resolveDrawingTarget(draft: Draft) {
    const anchor = targetAnchor(draft.kind, draft.strokes);
    if (!anchor) return null;
    // page coords → viewport coords for elementFromPoint
    const vx = anchor.x - window.scrollX;
    const vy = anchor.y - window.scrollY;
    if (vx < 0 || vy < 0 || vx > window.innerWidth || vy > window.innerHeight) {
      // anchor scrolled off-screen — skip rather than guess
      return null;
    }
    // Our shadow host is pointer-events:none, so elementFromPoint pierces
    // through the overlay and returns the underlying page element.
    const el = document.elementFromPoint(vx, vy);
    if (!el) return null;
    // Ignore the overlay host itself if browser ever returns it.
    if (el.tagName === "PINTA-OVERLAY-HOST") return null;
    return captureTarget(el);
  }

  function snapshotViewport() {
    return {
      scrollY: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  // Per-annotation rect cache. Updated whenever rectOf sees the element
  // connected, used as fallback when the element is detached during SPA
  // re-renders. Cached values are stored in page coords (viewport rect +
  // scrollY/X at capture time) so we can re-derive the viewport rect
  // even if the user scrolled while the element was missing — keeps the
  // badge pinned to where the content WAS rather than vanishing.
  const lastRectByEntry = new Map<
    string,
    {
      top: number;
      left: number;
      width: number;
      height: number;
      scrollX: number;
      scrollY: number;
    }
  >();

  function rectOf(
    el: Element | null,
    id?: string,
  ): {
    top: number;
    left: number;
    width: number;
    height: number;
  } | null {
    void tick;
    if (el && el.isConnected) {
      const r = el.getBoundingClientRect();
      const rect = {
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
      };
      if (id) {
        lastRectByEntry.set(id, {
          ...rect,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        });
      }
      return rect;
    }
    // Element missing or detached. Try the cached page-coord rect from
    // the last time we saw it connected, adjusted for any scroll that
    // happened since. Badge stays put visually so the user keeps their
    // bearings until the MutationObserver re-resolves the element.
    if (id) {
      const cached = lastRectByEntry.get(id);
      if (cached) {
        const dx = window.scrollX - cached.scrollX;
        const dy = window.scrollY - cached.scrollY;
        return {
          top: cached.top - dy,
          left: cached.left - dx,
          width: cached.width,
          height: cached.height,
        };
      }
    }
    return null;
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
  // Live rects for each ctrl-clicked extra. Recomputed on scroll/resize
  // (tick) via rectOf, same as primary. Filter out anything that's been
  // detached from the DOM since the click — better silently drop than
  // render a halo at a stale position.
  let extraRects = $derived(
    extras
      .map((el, i) => ({ el, rect: rectOf(el), n: i + 2 }))
      .filter((x): x is { el: Element; rect: NonNullable<ReturnType<typeof rectOf>>; n: number } => x.rect !== null && (x.el as HTMLElement).isConnected),
  );
  // Numbering: when only the primary is selected, no badges (status
  // strip alone is enough). When there are extras, primary becomes "1"
  // and each extra is "2", "3", "N+1" — matches the order the user
  // ctrl-clicked them in.
  let primaryBadgeNumber = $derived(extras.length > 0 ? 1 : 0);

  /**
   * Resolve each imported annotation to a viewport rect when possible.
   * - `target.selector` lookup is the source of truth — anchors halos
   *   and badges to whatever the imported session pointed at.
   * - Falls back to the first stroke's coords for pin / drawing kinds.
   * Re-evaluated whenever `imported` changes or `tick` bumps (scroll /
   * resize), so badges follow the layout in real time.
   */
  type ImportedRect = {
    id: string;
    n: number;
    rect: { top: number; left: number; width: number; height: number } | null;
    badge: { top: number; left: number };
    matched: boolean; // true = located via selector; false = stroke fallback
  };
  let importedRects: ImportedRect[] = $derived.by(() => {
    void tick;
    if (!imported) return [];
    const out: ImportedRect[] = [];
    for (let i = 0; i < imported.annotations.length; i++) {
      const a = imported.annotations[i]!;
      const n = i + 1;
      const sel =
        a.targets?.[0]?.selector ?? a.target?.selector ?? null;
      let rect: ImportedRect["rect"] = null;
      let matched = false;
      if (sel) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const r = el.getBoundingClientRect();
            rect = {
              top: r.top,
              left: r.left,
              width: r.width,
              height: r.height,
            };
            matched = true;
          }
        } catch {
          // bad selector — skip silently, badge falls back to strokes
        }
      }
      if (!rect) {
        const p = a.strokes?.[0];
        if (!p) continue; // no anchor at all — skip this annotation
        // Strokes are page-space; convert to viewport for the badge.
        rect = {
          top: p.y - window.scrollY,
          left: p.x - window.scrollX,
          width: 0,
          height: 0,
        };
      }
      out.push({
        id: a.id,
        n,
        rect: matched ? rect : null,
        badge: {
          top: Math.max(0, rect.top - 8),
          left: Math.max(0, rect.left + rect.width - 16),
        },
        matched,
      });
    }
    return out;
  });

  // Report how many imported selectors actually resolved on this page —
  // the side panel renders "N of M located" so the user knows whether
  // they're on the matching deployment / route. Deduped by counts so
  // scroll / resize ticks (which re-derive importedRects) don't flood
  // the message channel.
  let importedLocatedKey = $state<string>("");
  $effect(() => {
    if (!imported) {
      importedLocatedKey = "";
      return;
    }
    const total = imported.annotations.length;
    const matched = importedRects.filter((r) => r.matched).length;
    const key = `${matched}:${total}`;
    if (key === importedLocatedKey) return;
    importedLocatedKey = key;
    try {
      void chrome.runtime
        .sendMessage({ type: "imported.located", matched, total })
        ?.catch(() => {});
    } catch {
      // Extension context gone — ignore.
    }
  });
</script>

<!-- The user's own draft annotations (Canvas strokes + element pin badges)
  hide while viewing someone else's imported session, so the page shows
  exactly one overlay at a time and the imported context is unambiguous.
  Data is untouched — closing the viewer brings the draft visuals back. -->
{#if !imported}
  <Canvas />
{/if}

<!-- Imported-session read-only overlay: metadata pill + per-annotation halos & badges -->
{#if imported}
  <div
    class="imported-pill"
    style:--pinta-accent={imported.accentColor}
    role="status"
    aria-label="Viewing imported Pinta session"
  >
    <span class="imported-pill__dot"></span>
    <div class="imported-pill__text">
      <span class="imported-pill__title" title={imported.title}>{imported.title}</span>
      <span class="imported-pill__author">by {imported.author}</span>
    </div>
  </div>
  {#each importedRects as ir (ir.id)}
    {#if ir.matched && ir.rect}
      <div
        class="imported-hl"
        style:--pinta-accent={imported.accentColor}
        style:top="{ir.rect.top}px"
        style:left="{ir.rect.left}px"
        style:width="{ir.rect.width}px"
        style:height="{ir.rect.height}px"
      ></div>
    {/if}
    <div
      class="imported-badge"
      style:--pinta-accent={imported.accentColor}
      style:top="{ir.badge.top}px"
      style:left="{ir.badge.left}px"
      title="Imported annotation #{ir.n}{ir.matched ? '' : ' — anchor not found, badge at original coords'}"
      aria-label="Imported annotation {ir.n}"
    >{ir.n}</div>
  {/each}
{/if}

<!-- Processing pulse — pink pulsating glow around the viewport edges
  while the agent is picking up / applying the session. Sits below the
  pin badges in z-order but above the page content. Driven by
  `processing.start` / `processing.end` messages from the side panel. -->
{#if isProcessing}
  <div
    class="pinta-processing-pulse"
    style:--pinta-pulse-rgb={hexToRgbTriple(processingColor)}
    aria-hidden="true"
  ></div>
{/if}

<!-- Persistent pin badges for elements already annotated this session.
  Hidden while an imported session is being viewed — see the Canvas
  guard above for the rationale. -->
{#each !imported ? content.annotated : [] as a (a.id)}
  {@const r = rectOf(a.element, a.id)}
  {@const n = content.globalSeq(a.id)}
  {#if r && (!a.url || a.url === currentUrl)}
    <div
      class="pin"
      style:top="{Math.max(0, r.top - 8)}px"
      style:left="{Math.max(0, r.left + r.width - 16)}px"
      title="Annotation #{n}"
      aria-label="Annotation {n}"
    >{n}</div>
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
    {#if primaryBadgeNumber > 0}
      <div
        class="pin pin--multi"
        style:top="{Math.max(0, selectedRect.top - 8)}px"
        style:left="{Math.max(0, selectedRect.left + selectedRect.width - 16)}px"
        title="Primary pick (live preview anchored here)"
        aria-label="Primary pick"
      >{primaryBadgeNumber}</div>
    {/if}
    {#each extraRects as ex (ex.el)}
      <div
        class="hl hl--selected hl--extra"
        style:top="{ex.rect.top}px"
        style:left="{ex.rect.left}px"
        style:width="{ex.rect.width}px"
        style:height="{ex.rect.height}px"
      ></div>
      <div
        class="pin pin--multi"
        style:top="{Math.max(0, ex.rect.top - 8)}px"
        style:left="{Math.max(0, ex.rect.left + ex.rect.width - 16)}px"
        title="Extra pick #{ex.n} — Ctrl/Cmd+click again to remove"
        aria-label="Extra pick {ex.n}"
      >{ex.n}</div>
    {/each}
    <ElementEditor
      anchor={selectedRect}
      title={describe(selected)}
      extraCount={extras.length}
      {liveText}
      {liveStyles}
      bind:comment={selectComment}
      bind:customCss={selectCustomCss}
      bind:cssChanges={selectCssChanges}
      bind:contentAfter={selectContentAfter}
      bind:images={selectImages}
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
    bind:images={draftImages}
    onsubmit={submitDraft}
    oncancel={() => {
      content.cancelPending();
      draftComment = "";
      draftImages = [];
    }}
  />
{/if}

{#if content.pendingImage && pendingImageRect}
  {@const r = pendingImageRect}
  <div
    class="img-place"
    style:top="{r.top}px"
    style:left="{r.left}px"
    style:width="{r.width}px"
    style:height="{r.height}px"
    onpointerdown={onImageDragStart}
    role="button"
    tabindex="0"
    aria-label="Drag to reposition the placed image"
  >
    <img src={content.pendingImage.dataUrl} alt="" draggable="false" />
    <div class="img-place__handle img-place__handle--nw" onpointerdown={(e) => onImageResizeStart(e, "nw")} aria-label="Resize from top-left" role="button" tabindex="0"></div>
    <div class="img-place__handle img-place__handle--ne" onpointerdown={(e) => onImageResizeStart(e, "ne")} aria-label="Resize from top-right" role="button" tabindex="0"></div>
    <div class="img-place__handle img-place__handle--sw" onpointerdown={(e) => onImageResizeStart(e, "sw")} aria-label="Resize from bottom-left" role="button" tabindex="0"></div>
    <div class="img-place__handle img-place__handle--se" onpointerdown={(e) => onImageResizeStart(e, "se")} aria-label="Resize from bottom-right" role="button" tabindex="0"></div>
  </div>
  <CommentInput
    anchor={r}
    title={content.pendingImage.name ?? "image"}
    bind:value={imageComment}
    onsubmit={submitImage}
    oncancel={cancelImage}
  />
{/if}

{#if content.mode !== "idle"}
  <div class="status">
    {#if content.mode === "select"}
      Select mode · click to pick{selected ? " · Ctrl/Cmd+click to add more" : ""} · Alt+S or Esc to exit
    {:else if content.mode === "draw"}
      Draw · {content.tool} · drag on page · Alt+P or Esc to exit
    {:else if content.mode === "image"}
      Image · drag to position · resize from corners · type comment + Save · Esc to cancel
    {/if}
  </div>
{/if}

<!-- Styles are injected into the shadow root by overlay.ts via styles.css -->
