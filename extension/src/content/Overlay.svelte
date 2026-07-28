<script lang="ts">
  import { onMount } from "svelte";
  import type { Annotation, AnnotationImage, AnnotationTarget } from "@pinta/shared";
  import { captureTarget } from "./capture.js";
  import { content, type Mode, type Draft } from "./state.svelte.js";
  import { targetAnchor, type DrawTool } from "./tools/draw.js";
  import {
    detectDropKind,
    resolveInsertionPoint,
    type ResolvedDrop,
  } from "./tools/place.js";
  import {
    harvestPageColors,
    normalizeColor,
    sampleElementColor,
    type Swatch,
  } from "./tools/palette.js";
  import {
    applyPreview,
    rebuildInline,
    diffAppliedProps,
  } from "./tools/inline-style.js";
  import Canvas from "./Canvas.svelte";
  import CommentInput from "./CommentInput.svelte";
  import ElementEditor from "./ElementEditor.svelte";
  import TextFormatToolbar from "./TextFormatToolbar.svelte";
  import PaintPicker from "./PaintPicker.svelte";
  import ScalePicker from "./ScalePicker.svelte";
  import { voice } from "../lib/voice/controller.js";
  import FloatingToolbar from "./FloatingToolbar.svelte";
  import { toolMode, toolForKey, type Tool } from "../lib/tools.js";

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

  // Floating toolbar / shortcut → activate a tool. Mirrors the side panel's
  // setActive: Image kicks off the panel's file-picker flow; every other tool
  // toggles its mode (re-picking the active one exits to idle).
  function pickTool(t: Tool) {
    if (t === "image") {
      chrome.runtime
        .sendMessage({ type: "toolbar.pick-image" })
        .catch(() => {});
      return;
    }
    if (t === "transform") {
      // Free Transform is a TOGGLE, not a mode — the user keeps their current
      // tool active while it's on. Flip it + tell the side panel to open/close
      // its batching session.
      content.freeTransform = !content.freeTransform;
      chrome.runtime
        .sendMessage({ type: "transform.state", on: content.freeTransform })
        .catch(() => {});
      return;
    }
    const { mode, tool } = toolMode(t);
    const active = tool
      ? content.mode === "draw" && content.tool === tool
      : content.mode === mode;
    if (active) setMode("idle");
    else setMode(mode as Mode, tool as DrawTool | undefined);
  }

  // Mirror the content script's active mode back to the side panel so
  // its toolbar pressed-state stays in sync with what's actually
  // happening on the page. Without this, hotkey-driven changes
  // (Alt+S / Alt+P / Alt+X) AND Esc-driven exits silently desynced
  // the side panel: the toolbar Select button stayed lit after Esc
  // cleared select mode on the page. chrome.runtime.sendMessage
  // delivers to every extension page; the side panel filters by
  // sender.tab.id so a content script on tab A doesn't update the
  // toolbar for a side panel currently viewing tab B.
  $effect(() => {
    const mode = content.mode;
    const tool = mode === "draw" ? content.tool : undefined;
    try {
      chrome.runtime.sendMessage({ type: "mode.changed", mode, tool });
    } catch {
      // Extension reloaded / context invalidated — nothing to do here;
      // the page will re-mount its overlay on the next reload.
    }
  });

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
        on?: boolean;
      };
      if (m?.type === "transform.set") {
        // Side panel flipped Free Transform (its Done/Cancel or its tool
        // button). Mirror + echo the state so both surfaces stay in sync.
        content.freeTransform = !!m.on;
        chrome.runtime
          .sendMessage({ type: "transform.state", on: content.freeTransform })
          .catch(() => {});
        return;
      }
      if (m?.type === "mode.set" && m.mode) setMode(m.mode, m.tool);
      else if (m?.type === "processing.start") {
        if (typeof (msg as { color?: string }).color === "string") {
          processingColor = (msg as { color: string }).color;
        }
        isProcessing = true;
      }
      else if (m?.type === "processing.end") isProcessing = false;
      else if (m?.type === "annotated.reapply" && m.annotation) {
        // Redo / undo-of-remove — re-apply the annotation's preview.
        reapplyAnnotation(m.annotation);
      }
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
        if (entry) {
          // A node Pinta CREATED (text-insert preview) rolls back by
          // removal; a mutated existing element restores its snapshot.
          if (entry.inserted) entry.element.remove();
          else restoreFromEntry(entry);
          // Multi-target annotations (move / delete with Ctrl-clicked
          // siblings) also preview the extras — restore them too.
          for (const ex of entry.extraPreviews ?? []) restoreFromSnapshot(ex);
        }
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
          if (entry.inserted) entry.element.remove();
          else restoreFromSnapshot(entry);
          for (const ex of entry.extraPreviews ?? []) restoreFromSnapshot(ex);
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
      const key = e.key.toLowerCase();
      // Alt+V — dictate into the focused field (Voice Command). Handled
      // BEFORE the input/textarea guard below, since unlike the mode
      // hotkeys it's meant to fire while a text field is focused.
      if (key === "v" && content.voiceEnabled) {
        if (voice.toggleForFocused(content.voiceLang)) e.preventDefault();
        return;
      }
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) return;
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

  // Tool shortcuts — Ctrl+Alt+<key> (e.g. Ctrl+Alt+R = Rect) while the
  // floating toolbar is enabled. The Ctrl+Alt combo keeps the page's own
  // single-key handlers free and won't fire mid-typing. Uses e.code so it's
  // keyboard-layout independent (Ctrl+Alt can remap letters on some layouts).
  onMount(() => {
    function onKey(e: KeyboardEvent) {
      if (!content.floatingToolbarEnabled) return;
      if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) return;
      const letter =
        e.code && e.code.startsWith("Key") ? e.code.slice(3) : e.key;
      const def = toolForKey(letter);
      if (!def) return;
      e.preventDefault();
      pickTool(def.id);
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
    // MUI `.Mui-disabled`, Radix's `[data-disabled]`, etc.) hide disabled
    // elements from the cursor entirely — without this override, mouse
    // events would pass straight through and the user couldn't even
    // highlight them.
    const styleEl = document.createElement("style");
    styleEl.dataset.pintaSelectModeOverride = "1";
    styleEl.textContent = `
      button[disabled], input[disabled], select[disabled], textarea[disabled],
      fieldset[disabled], fieldset[disabled] *,
      [aria-disabled="true"], [aria-disabled="true"] *,
      [data-disabled], [data-disabled] * {
        pointer-events: auto !important;
        cursor: crosshair !important;
      }
    `;
    document.head.appendChild(styleEl);

    // Wrappers with `pointer-events: none` (tooltip hosts, decorative
    // overlays) silently block events from reaching disabled descendants
    // — CSS on the descendant alone can't fix this because the parent
    // never propagates the event. Walk up from each disabled element on
    // select-mode entry, force ancestors with computed `pointer-events:
    // none` to `auto`, and stash originals so cleanup restores the page.
    const DISABLED_SELECTOR =
      'button[disabled], input[disabled], select[disabled], textarea[disabled], ' +
      'fieldset[disabled], [aria-disabled="true"], [data-disabled]';
    const restoredPointerEvents: Array<{
      el: HTMLElement;
      original: string;
    }> = [];
    function unblockAncestorsOf(el: Element): void {
      let cur: HTMLElement | null = el as HTMLElement;
      while (
        cur &&
        cur !== document.body &&
        cur !== document.documentElement
      ) {
        // Re-enter guard: skip ancestors we've already touched.
        if (cur.dataset.pintaPeRestored) {
          cur = cur.parentElement;
          continue;
        }
        if (getComputedStyle(cur).pointerEvents === "none") {
          restoredPointerEvents.push({
            el: cur,
            original: cur.style.pointerEvents ?? "",
          });
          cur.style.pointerEvents = "auto";
          cur.dataset.pintaPeRestored = "1";
        }
        cur = cur.parentElement;
      }
    }
    for (const el of document.querySelectorAll(DISABLED_SELECTOR)) {
      unblockAncestorsOf(el);
    }
    // Catch disabled elements that mount AFTER select mode begins
    // (e.g. user toggles a section, opens a modal). Cheap MutationObserver
    // that only fires when childList changes.
    const disabledMo = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.(DISABLED_SELECTOR)) unblockAncestorsOf(node);
          for (const child of node.querySelectorAll?.(DISABLED_SELECTOR) ?? []) {
            unblockAncestorsOf(child);
          }
        }
      }
    });
    disabledMo.observe(document.body, { childList: true, subtree: true });

    function isDisabledFormControl(el: Element): boolean {
      // Native `disabled` on form elements suppresses `click` per HTML
      // spec — that's the case we route through `mousedown` below.
      // `aria-disabled="true"` and `data-disabled` do NOT suppress click
      // in browsers, but some component libs (Radix, Headless UI,
      // shadcn/ui) intercept and swallow it; cheaper to treat them the
      // same.
      if ("disabled" in el && (el as HTMLButtonElement).disabled) return true;
      if (el.getAttribute("aria-disabled") === "true") return true;
      if (el.hasAttribute("data-disabled")) return true;
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
      disabledMo.disconnect();
      // Restore pointer-events on ancestors we modified so the page's
      // post-select-mode interactivity is exactly what it was before.
      for (const { el, original } of restoredPointerEvents) {
        if (original) {
          el.style.pointerEvents = original;
        } else {
          el.style.removeProperty("pointer-events");
        }
        delete el.dataset.pintaPeRestored;
      }
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

  function newAnnId(): string {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `ann-${crypto.randomUUID()}`
      : `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ─── Move tool (drag & drop an existing element) ────────────────────
  // Grab an element, drag it with a live inline-transform preview, and
  // record where it should go. The preview stays applied after submit
  // (like select-mode edits) and rolls back through the same
  // originalCssText snapshot in content.annotated. The DOM is NEVER
  // reparented during preview — only translated — so rollback is safe.

  /** One extra element being dragged along with the primary (a Ctrl/Cmd+
   *  click sibling). Carries its own capture + rollback snapshot so the
   *  agent gets all N targets and the page restores cleanly. */
  type MoveExtra = {
    el: HTMLElement;
    target: AnnotationTarget;
    originalCssText: string;
    originalInnerHtml: string;
  };

  type PendingMove = {
    el: HTMLElement;
    /** Captured at grab time, pre-transform, so boundingRect/outerHTML
     *  reflect where the element really lives in the layout. */
    sourceTarget: AnnotationTarget;
    /** Inline style to restore on cancel/remove (true original when the
     *  element was annotated before). */
    originalCssText: string;
    /** innerHTML snapshot of the primary (for the extraPreviews rollback
     *  shape — the primary itself uses originalCssText). */
    originalInnerHtml: string;
    /** Ctrl/Cmd-clicked siblings moving with the primary. Empty for a
     *  plain single-element drag. */
    extras: MoveExtra[];
    dx: number;
    dy: number;
    drop: ResolvedDrop | null;
    /** True once dropped — drag finished, comment popover open. */
    frozen: boolean;
  };
  let pendingMove = $state<PendingMove | null>(null);
  let moveComment = $state("");
  let moveImages = $state<AnnotationImage[]>([]);
  // Elements Ctrl/Cmd+clicked in move mode BEFORE a drag begins. When the
  // user then grabs any element, these ride along (translated together and
  // recorded as extra targets). Cleared once folded into a pendingMove.
  let moveExtras = $state<HTMLElement[]>([]);

  function cancelMove(): void {
    const p = pendingMove;
    if (p) {
      if (p.el.isConnected) p.el.style.cssText = p.originalCssText;
      for (const ex of p.extras) {
        if (ex.el.isConnected) ex.el.style.cssText = ex.originalCssText;
      }
    }
    pendingMove = null;
    moveComment = "";
    moveImages = [];
    moveExtras = [];
    hovered = null;
  }

  // Leaving move mode (hotkey, side panel toggle, another tool) with a
  // drag, an un-submitted drop, or a pre-drag multi-selection in flight →
  // roll everything back.
  $effect(() => {
    if (content.mode !== "move" && (pendingMove || moveExtras.length)) {
      cancelMove();
    }
  });

  function beginMoveDrag(el: HTMLElement, e: MouseEvent): void {
    const existing = content.findAnnotatedByElement(el);
    const sourceTarget = captureTarget(el);
    // Fold the pre-drag Ctrl/Cmd+click selection into this drag. The
    // grabbed element is always the primary; any others become extras
    // (deduped so grabbing one of the pre-selected elements doesn't
    // list it twice).
    const extras: MoveExtra[] = moveExtras
      .filter((ex) => ex !== el && ex.isConnected)
      .map((ex) => {
        const prev = content.findAnnotatedByElement(ex);
        return {
          el: ex,
          target: captureTarget(ex),
          originalCssText: prev ? prev.originalCssText : ex.style.cssText,
          originalInnerHtml: prev ? prev.originalInnerHtml : ex.innerHTML,
        };
      });
    moveExtras = [];
    pendingMove = {
      el,
      sourceTarget,
      originalCssText: existing
        ? existing.originalCssText
        : el.style.cssText,
      originalInnerHtml: existing ? existing.originalInnerHtml : el.innerHTML,
      extras,
      dx: 0,
      dy: 0,
      drop: null,
      frozen: false,
    };
    const startX = e.clientX;
    const startY = e.clientY;
    // Dragged elements must not swallow hit-tests for the drop target —
    // and transitions would fight the per-frame transform.
    el.style.transition = "none";
    el.style.pointerEvents = "none";
    el.style.willChange = "transform";
    for (const ex of extras) {
      ex.el.style.transition = "none";
      ex.el.style.pointerEvents = "none";
      ex.el.style.willChange = "transform";
    }

    function onPointerMove(ev: PointerEvent) {
      const p = pendingMove;
      if (!p || p.frozen) return;
      if (!p.el.isConnected) {
        // SPA re-render detached the element mid-drag — abort cleanly.
        cleanup();
        cancelMove();
        return;
      }
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      p.el.style.transform = `translate(${dx}px, ${dy}px)`;
      for (const ex of p.extras) {
        if (ex.el.isConnected) ex.el.style.transform = `translate(${dx}px, ${dy}px)`;
      }
      pendingMove = {
        ...p,
        dx,
        dy,
        drop: resolveInsertionPoint(ev.clientX, ev.clientY, p.el),
      };
    }
    function onPointerUp(ev: PointerEvent) {
      cleanup();
      const p = pendingMove;
      if (!p) return;
      const moved = Math.hypot(ev.clientX - startX, ev.clientY - startY) >= 4;
      if (!moved || !p.el.isConnected) {
        // Accidental click / element gone — nothing to record.
        cancelMove();
        return;
      }
      p.el.style.pointerEvents = "";
      for (const ex of p.extras) ex.el.style.pointerEvents = "";
      pendingMove = { ...p, frozen: true };
    }
    function cleanup() {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
    }
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
  }

  function submitMove(): void {
    const p = pendingMove;
    if (!p || !p.frozen) return;
    const el = p.el;
    const dropKind = el.isConnected ? detectDropKind(p.drop, el) : "free";
    const rect = el.getBoundingClientRect();
    const move: NonNullable<Annotation["move"]> =
      dropKind === "reorder" && p.drop
        ? {
            drop: "reorder",
            container: captureTarget(p.drop.container),
            reference: p.drop.reference
              ? captureTarget(p.drop.reference)
              : undefined,
            position: p.drop.position,
          }
        : {
            drop: "free",
            offset: { dx: Math.round(p.dx), dy: Math.round(p.dy) },
            // Same coordinate space as AnnotationTarget.boundingRect
            // (raw getBoundingClientRect) so renderers can relate them.
            destinationRect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          };
    const annId = newAnnId();
    // Primary first, then each Ctrl-clicked extra in pick order, so the
    // agent moves them all to the destination in a predictable sequence.
    const targets = [p.sourceTarget, ...p.extras.map((ex) => ex.target)];
    const annotation: Annotation = {
      id: annId,
      createdAt: Date.now(),
      kind: "move",
      strokes: [],
      color: "#10B981",
      comment: moveComment.trim(),
      images: moveImages.length ? moveImages : undefined,
      targets,
      target: p.sourceTarget,
      move,
      viewport: snapshotViewport(),
      url: location.href,
    };
    chrome.runtime.sendMessage({ type: "annotation.draw-committed", annotation });
    // Snapshot so Remove / new-session restores the translate preview for
    // the primary AND every extra that rode along.
    content.recordAnnotated(
      annId,
      el,
      p.originalCssText,
      el.innerHTML,
      p.sourceTarget.selector,
      p.sourceTarget.outerHTML,
      p.sourceTarget.nearbyText,
      location.href,
      false,
      p.extras.map((ex) => ({
        element: ex.el,
        originalCssText: ex.originalCssText,
        originalInnerHtml: ex.originalInnerHtml,
      })),
    );
    pendingMove = null;
    moveComment = "";
    moveImages = [];
    moveExtras = [];
    setMode("idle");
  }

  // Move-mode pointer handlers: hover to aim, mousedown to grab.
  $effect(() => {
    if (content.mode !== "move") return;
    function onMove(e: MouseEvent) {
      if (pendingMove) return;
      const el = e.target as Element | null;
      if (!el || el === document.documentElement || el === document.body || isOurNode(el)) {
        hovered = null;
        return;
      }
      hovered = el;
    }
    function onDown(e: MouseEvent) {
      if (e.button !== 0 || pendingMove) return;
      const el = e.target as Element | null;
      if (!el || el === document.documentElement || el === document.body || isOurNode(el)) return;
      e.preventDefault();
      e.stopPropagation();
      // Ctrl/Cmd+click → toggle this element into the pre-drag multi-move
      // selection instead of starting a drag. Grab any element afterward
      // and the whole set moves together.
      if (e.ctrlKey || e.metaKey) {
        const target = el as HTMLElement;
        const i = moveExtras.indexOf(target);
        moveExtras =
          i >= 0
            ? moveExtras.filter((_, idx) => idx !== i)
            : [...moveExtras, target];
        hovered = null;
        return;
      }
      hovered = null;
      beginMoveDrag(el as HTMLElement, e);
    }
    function onClickSwallow(e: MouseEvent) {
      // The page must not react to the grab/drop clicks (links, buttons).
      if (isOurNode(e.target as Element | null)) return;
      e.preventDefault();
      e.stopPropagation();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (pendingMove) cancelMove();
      else if (moveExtras.length) moveExtras = [];
      else setMode("idle");
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClickSwallow, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClickSwallow, true);
      document.removeEventListener("keydown", onKey, true);
    };
  });

  // Live rects for the move overlay. The dragged element's rect reflects
  // its transform, so the anchor follows the preview.
  let moveRect = $derived.by(() => {
    void tick;
    const p = pendingMove;
    if (!p || !p.el.isConnected) return null;
    const r = p.el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  });
  // Highlights for the pre-drag Ctrl/Cmd+click multi-move selection AND
  // the extras that are mid-drag (so the whole group stays visibly
  // ganged together). Detached elements are dropped silently.
  let moveExtraRects = $derived.by(() => {
    void tick;
    const els = pendingMove ? pendingMove.extras.map((ex) => ex.el) : moveExtras;
    return els
      .map((el) => ({ el, rect: rectOf(el) }))
      .filter(
        (x): x is { el: HTMLElement; rect: NonNullable<ReturnType<typeof rectOf>> } =>
          x.rect !== null && x.el.isConnected,
      );
  });
  let moveDropRects = $derived.by(() => {
    void tick;
    const p = pendingMove;
    if (!p?.drop) return null;
    if (!p.drop.container.isConnected) return null;
    const c = p.drop.container.getBoundingClientRect();
    // barRect is viewport-coords from resolve time — fresh during the
    // drag (recomputed every pointermove). After the drop it can go
    // stale on scroll, matching the popover anchor's behavior.
    const bar = p.drop.barRect;
    return {
      container: { top: c.top, left: c.left, width: c.width, height: c.height },
      bar: { top: bar.y, left: bar.x, width: bar.width, height: bar.height },
    };
  });

  // ─── Text tool (click-to-edit + add paragraph) ──────────────────────
  // Click an element with direct text → edit it in place (contenteditable,
  // live preview, rides kind:"select" + contentChange — the agent already
  // knows how to apply those). Click a container / gap → insert a NEW
  // paragraph there (kind:"text-insert"); the inserted node stays as the
  // live preview and rollback simply removes it.

  type TextStyleSnapshot = {
    fontSize: string;
    fontWeight: string;
    fontStyle: string;
    underline: boolean;
    color: string;
    textAlign: string;
    lineHeight: string;
    letterSpacing: string;
    textTransform: string;
  };
  type PendingTextEdit = {
    el: HTMLElement;
    /** TRUE original inline style / markup — rollback snapshots only. */
    originalCssText: string;
    originalInnerHtml: string;
    /** Inline style + markup when the text edit began (carries earlier
     *  tools). Live format preview resets to `baseCssText` so it doesn't
     *  wipe a prior resize; a cancelled edit rolls back to both, not the
     *  true original, so it can't undo an earlier tool. */
    baseCssText: string;
    baseInnerHtml: string;
    textBefore: string;
    /** Text-formatting overrides from the floating toolbar (font-size,
     *  font-weight, color, text-align, …). Applied live and folded into
     *  the committed annotation's `cssChanges`. */
    cssChanges: Record<string, string>;
    /** Computed text styles at edit start — seeds the toolbar controls. */
    initialStyles: TextStyleSnapshot;
  };
  let pendingTextEdit = $state<PendingTextEdit | null>(null);

  function readTextStyles(el: Element): TextStyleSnapshot {
    const cs = window.getComputedStyle(el);
    return {
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      underline: cs.textDecorationLine.includes("underline"),
      color: cs.color,
      textAlign: cs.textAlign,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textTransform: cs.textTransform,
    };
  }

  // Apply one text-formatting property from the toolbar. Empty value
  // resets it (drop the key, then re-layer the remaining overrides on the
  // edit-start base). Resetting to the base — not the true original —
  // preserves any earlier tool's edits on the same element. Reassigning
  // cssText doesn't disturb the contentEditable caret or its text.
  function applyTextFormat(prop: string, value: string): void {
    const p = pendingTextEdit;
    if (!p) return;
    const next = { ...p.cssChanges };
    if (value.trim()) next[prop] = value.trim();
    else delete next[prop];
    pendingTextEdit = { ...p, cssChanges: next };
    if (!p.el.isConnected) return;
    applyPreview(p.el, p.baseCssText, next);
  }

  type PendingTextInsert = {
    el: HTMLElement; // the inserted placeholder <p>
    containerTarget: AnnotationTarget;
    reference?: AnnotationTarget;
    position: "before" | "after" | "inside";
  };
  let pendingTextInsert = $state<PendingTextInsert | null>(null);

  // Live viewport rect of the element being text-edited — anchors the
  // floating format toolbar and follows the element on scroll/resize.
  let textEditRect = $derived(rectOf(pendingTextEdit?.el ?? null));

  /** Elements whose text can be edited in place: has a non-empty direct
   *  Text child and isn't a form control / replaced element. */
  function hasDirectText(el: Element): boolean {
    if (
      el.matches(
        "input, textarea, select, option, img, svg, svg *, video, audio, canvas, iframe",
      )
    ) {
      return false;
    }
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim()) return true;
    }
    return false;
  }

  function startTextEdit(el: HTMLElement): void {
    const existing = content.findAnnotatedByElement(el);
    pendingTextEdit = {
      el,
      originalCssText: existing ? existing.originalCssText : el.style.cssText,
      originalInnerHtml: existing
        ? existing.originalInnerHtml
        : el.innerHTML,
      baseCssText: el.style.cssText,
      baseInnerHtml: el.innerHTML,
      textBefore: textOf(el),
      cssChanges: {},
      initialStyles: readTextStyles(el),
    };
    try {
      el.contentEditable = "plaintext-only";
    } catch {
      el.contentEditable = "true";
    }
    el.focus();
    // Select-all so typing replaces; caret-click still works for tweaks.
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      // selection is a nicety only
    }
  }

  function finishTextEdit(commit: boolean): void {
    const p = pendingTextEdit;
    if (!p) return;
    pendingTextEdit = null; // clear first — blur fired by cleanup re-enters
    const el = p.el;
    if (!el.isConnected) return;
    el.removeAttribute("contenteditable");
    const textAfter = textOf(el);
    const textChanged = textAfter !== p.textBefore;
    const hasFormat = Object.keys(p.cssChanges).length > 0;
    if (!commit || (!textChanged && !hasFormat)) {
      // Untouched or cancelled — roll back to how the element looked when
      // THIS edit began (base), not the true original, so an earlier tool's
      // edit on the same element survives.
      el.style.cssText = p.baseCssText;
      el.innerHTML = p.baseInnerHtml;
      return;
    }
    const annId = newAnnId();
    // Capture AFTER the edit so outerHTML reflects the intended state
    // (same ordering rule as submitSelect).
    const target = captureTarget(el);
    const annotation: Annotation = {
      id: annId,
      createdAt: Date.now(),
      kind: "select",
      strokes: [],
      color: "#2563eb",
      comment: "",
      contentChange: textChanged
        ? { textBefore: p.textBefore, textAfter }
        : undefined,
      cssChanges: hasFormat ? p.cssChanges : undefined,
      targets: [target],
      target,
      viewport: snapshotViewport(),
      url: location.href,
    };
    chrome.runtime.sendMessage({ type: "annotation.draw-committed", annotation });
    content.recordAnnotated(
      annId,
      el,
      p.originalCssText,
      p.originalInnerHtml,
      target.selector,
      target.outerHTML,
      target.nearbyText,
      location.href,
    );
    content.attachPreviewChanges(annId, diffAppliedProps(p.baseCssText, el.style.cssText));
  }

  function startTextInsert(clientX: number, clientY: number): void {
    const resolved = resolveInsertionPoint(clientX, clientY, null);
    if (!resolved) return;
    // Capture the container BEFORE inserting so its outerHTML doesn't
    // include our placeholder.
    const containerTarget = captureTarget(resolved.container);
    const reference = resolved.reference
      ? captureTarget(resolved.reference)
      : undefined;
    const p = document.createElement("p");
    p.dataset.pintaInsert = "1";
    p.style.outline = "1px dashed rgba(16, 185, 129, 0.7)";
    p.style.outlineOffset = "2px";
    p.style.minHeight = "1em";
    p.style.minWidth = "40px";
    try {
      p.contentEditable = "plaintext-only";
    } catch {
      p.contentEditable = "true";
    }
    if (resolved.position === "inside" || !resolved.reference) {
      resolved.container.appendChild(p);
    } else if (resolved.position === "before") {
      resolved.container.insertBefore(p, resolved.reference);
    } else {
      resolved.container.insertBefore(p, resolved.reference.nextSibling);
    }
    pendingTextInsert = {
      el: p,
      containerTarget,
      reference,
      position: resolved.position,
    };
    p.focus();
  }

  function finishTextInsert(commit: boolean): void {
    const p = pendingTextInsert;
    if (!p) return;
    pendingTextInsert = null; // clear first — blur re-enters
    const el = p.el;
    const text = el.isConnected ? textOf(el) : "";
    if (!commit || !text) {
      el.remove();
      return;
    }
    el.removeAttribute("contenteditable");
    el.style.outline = "";
    el.style.outlineOffset = "";
    const annId = newAnnId();
    const annotation: Annotation = {
      id: annId,
      createdAt: Date.now(),
      kind: "text-insert",
      strokes: [],
      color: "#10B981",
      comment: "",
      targets: [p.containerTarget],
      target: p.containerTarget,
      textInsert: {
        reference: p.reference,
        position: p.position,
        text,
      },
      viewport: snapshotViewport(),
      url: location.href,
    };
    chrome.runtime.sendMessage({ type: "annotation.draw-committed", annotation });
    // `inserted: true` → rollback removes the node instead of restoring.
    content.recordAnnotated(
      annId,
      el,
      "",
      "",
      undefined,
      undefined,
      undefined,
      location.href,
      true,
    );
  }

  function cancelTextTool(): void {
    if (pendingTextEdit) finishTextEdit(false);
    if (pendingTextInsert) finishTextInsert(false);
    hovered = null;
  }

  // Leaving text mode with an un-committed edit/insert → roll back.
  $effect(() => {
    if (content.mode !== "text" && (pendingTextEdit || pendingTextInsert)) {
      cancelTextTool();
    }
  });

  // Text-mode pointer handlers.
  $effect(() => {
    if (content.mode !== "text") return;
    function editingEl(): HTMLElement | null {
      return pendingTextEdit?.el ?? pendingTextInsert?.el ?? null;
    }
    function onMove(e: MouseEvent) {
      if (editingEl()) return;
      const el = e.target as Element | null;
      if (!el || el === document.documentElement || el === document.body || isOurNode(el)) {
        hovered = null;
        return;
      }
      hovered = hasDirectText(el) ? el : null;
    }
    function onClick(e: MouseEvent) {
      const el = e.target as Element | null;
      if (!el || isOurNode(el)) return;
      const editing = editingEl();
      if (editing) {
        // Clicking inside the live edit repositions the caret; clicking
        // anywhere else commits it (blur also fires, but be explicit).
        if (el === editing || editing.contains(el)) return;
        e.preventDefault();
        e.stopPropagation();
        if (pendingTextEdit) finishTextEdit(true);
        if (pendingTextInsert) finishTextInsert(true);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      hovered = null;
      if (
        el !== document.documentElement &&
        el !== document.body &&
        hasDirectText(el)
      ) {
        startTextEdit(el as HTMLElement);
      } else {
        startTextInsert(e.clientX, e.clientY);
      }
    }
    function onKey(e: KeyboardEvent) {
      const editing = editingEl();
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (editing) cancelTextTool();
        else setMode("idle");
        return;
      }
      // Enter commits (Shift+Enter keeps typing a newline).
      if (e.key === "Enter" && !e.shiftKey && editing) {
        e.preventDefault();
        e.stopPropagation();
        if (pendingTextEdit) finishTextEdit(true);
        if (pendingTextInsert) finishTextInsert(true);
      }
    }
    function onBlur(e: FocusEvent) {
      const editing = editingEl();
      if (!editing || e.target !== editing) return;
      // Focus moving INTO the Pinta formatting toolbar (color picker,
      // size input, …) must NOT commit — the user is still formatting.
      // relatedTarget is retargeted to our shadow host across the
      // boundary, so isOurNode catches it.
      if (isOurNode(e.relatedTarget as Element | null)) return;
      // Commit on blur — matches the "click away = done" instinct.
      if (pendingTextEdit) finishTextEdit(true);
      if (pendingTextInsert) finishTextInsert(true);
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("blur", onBlur, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("blur", onBlur, true);
    };
  });

  // ─── Delete tool (remove elements on click) ─────────────────────────
  // Click an element → it is REMOVED from the page immediately (hidden via
  // inline `display:none`) and a `kind:"delete"` annotation is created on
  // the spot. Undo = remove that annotation's card in the side panel,
  // which restores the element (rollback of the inline-style snapshot).
  // The tool stays active so you can click through several deletions in a
  // row. No confirm popover — the click IS the action.

  const DELETE_COLOR = "#EF4444";

  function deleteElementNow(el: HTMLElement): void {
    // Capture the target from the element's CURRENT (visible) state before
    // hiding — outerHTML / computedStyles / boundingRect must describe the
    // real element the agent will delete in source.
    const target = captureTarget(el);
    // Snapshot the exact inline style to restore on undo, then hide. Using
    // `display:none !important` so the element visibly disappears (and the
    // page reflows) regardless of the page's own CSS.
    const originalCssText = el.style.cssText;
    const sep = originalCssText && !originalCssText.endsWith(";") ? "; " : "";
    el.style.cssText = originalCssText + sep + "display: none !important;";

    const annId = newAnnId();
    const annotation: Annotation = {
      id: annId,
      createdAt: Date.now(),
      kind: "delete",
      strokes: [],
      color: DELETE_COLOR,
      comment: "",
      targets: [target],
      target,
      viewport: snapshotViewport(),
      url: location.href,
    };
    chrome.runtime.sendMessage({ type: "annotation.draw-committed", annotation });
    // Record for rollback. `deleted: true` suppresses the on-page pin
    // badge (there's nothing to point at — the element is gone). Removing
    // the card fires `annotated.remove`, which restores originalCssText.
    content.recordAnnotated(
      annId,
      el,
      originalCssText,
      el.innerHTML,
      target.selector,
      target.outerHTML,
      target.nearbyText,
      location.href,
      false,
      undefined,
      true,
    );
    hovered = null;
  }

  // Delete-mode pointer handlers: hover to aim, click to remove.
  $effect(() => {
    if (content.mode !== "delete") return;
    function onMove(e: MouseEvent) {
      const el = e.target as Element | null;
      if (!el || el === document.documentElement || el === document.body || isOurNode(el)) {
        hovered = null;
        return;
      }
      hovered = el;
    }
    function onDown(e: MouseEvent) {
      // Act on mousedown so natively-disabled controls (which swallow
      // `click`) can still be deleted, mirroring select mode's approach.
      if (e.button !== 0) return;
      const el = e.target as Element | null;
      if (!el || isOurNode(el)) return;
      if (el === document.documentElement || el === document.body) return;
      e.preventDefault();
      e.stopPropagation();
      deleteElementNow(el as HTMLElement);
    }
    function onClickSwallow(e: MouseEvent) {
      // Don't let the page react to the delete click (links, buttons).
      if (isOurNode(e.target as Element | null)) return;
      e.preventDefault();
      e.stopPropagation();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setMode("idle");
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClickSwallow, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClickSwallow, true);
      document.removeEventListener("keydown", onKey, true);
    };
  });

  // ─── Resize tool (drag handles to size divs / grids / any box) ──────
  // Click an element to select it, then drag any of the 8 handles to change
  // its width and/or height. Live inline-style preview; commit rides
  // `kind:"select"` with `cssChanges` — the agent already knows how to
  // translate those into the project's system.
  //
  // Dragging a LEFT/TOP edge moves that edge while the opposite edge stays
  // put — the design-tool behavior people expect. Width/height alone can't
  // express that (a box grows from its layout origin), so those drags also
  // accumulate a margin-left / margin-top offset. That offset is previewed
  // AND emitted, so what you see is exactly what the agent applies. Pure
  // right/bottom/corner drags emit width/height only, as before.

  /** Which edges a handle moves. */
  type ResizeEdge = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
  const MIN_SIZE = 16;

  /** Handle placement as a fraction of the element's rect (0 = left/top,
   *  1 = right/bottom), so the template can lay all 8 out in one loop. */
  const RESIZE_HANDLES: {
    edge: ResizeEdge;
    x: number;
    y: number;
    label: string;
  }[] = [
    { edge: "nw", x: 0, y: 0, label: "Resize from top-left" },
    { edge: "n", x: 0.5, y: 0, label: "Resize from the top edge" },
    { edge: "ne", x: 1, y: 0, label: "Resize from top-right" },
    { edge: "e", x: 1, y: 0.5, label: "Resize width from the right edge" },
    { edge: "se", x: 1, y: 1, label: "Resize from bottom-right" },
    { edge: "s", x: 0.5, y: 1, label: "Resize height from the bottom edge" },
    { edge: "sw", x: 0, y: 1, label: "Resize from bottom-left" },
    { edge: "w", x: 0, y: 0.5, label: "Resize width from the left edge" },
  ];

  type ResizePending = {
    el: HTMLElement;
    /** TRUE original inline style — rollback snapshot only. */
    originalCssText: string;
    originalInnerHtml: string;
    /** Inline style when Resize began (carries earlier tools). Preview
     *  rebuilds from THIS so it doesn't wipe a prior text / paint / scale. */
    baseCssText: string;
    sourceTarget: AnnotationTarget;
    /** Current previewed size in CSS px (border-box, from the rect). */
    width: number;
    height: number;
    /** The element's own computed margins at select time — offsets are
     *  emitted relative to these so we don't clobber existing spacing. */
    baseMarginLeft: number;
    baseMarginTop: number;
    /** Accumulated shift from left/top-edge drags, in px. 0 = untouched. */
    offsetX: number;
    offsetY: number;
  };
  let resizePending = $state<ResizePending | null>(null);
  let resizeComment = $state("");

  function beginResizeSelect(el: HTMLElement): void {
    const existing = content.findAnnotatedByElement(el);
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    resizePending = {
      el,
      originalCssText: existing ? existing.originalCssText : el.style.cssText,
      originalInnerHtml: existing ? existing.originalInnerHtml : el.innerHTML,
      baseCssText: el.style.cssText,
      sourceTarget: captureTarget(el),
      width: Math.round(r.width),
      height: Math.round(r.height),
      baseMarginLeft: parseFloat(cs.marginLeft) || 0,
      baseMarginTop: parseFloat(cs.marginTop) || 0,
      offsetX: 0,
      offsetY: 0,
    };
  }

  function cancelResize(): void {
    const p = resizePending;
    // Restore to the base (before Resize began), not the true original, so
    // an earlier tool's edit on the same element survives.
    if (p && p.el.isConnected) p.el.style.cssText = p.baseCssText;
    resizePending = null;
    resizeComment = "";
    hovered = null;
  }

  // Leaving resize mode with an un-committed selection → roll back.
  $effect(() => {
    if (content.mode !== "resize" && resizePending) cancelResize();
  });

  /** Re-apply the whole resize preview from the original inline style, so
   *  repeated drags never stack duplicate declarations. */
  function applyResizePreview(p: ResizePending): void {
    const el = p.el;
    if (!el.isConnected) return;
    const orig = p.sourceTarget.boundingRect;
    el.style.cssText = p.baseCssText;
    if (Math.round(orig.width) !== p.width) el.style.width = `${p.width}px`;
    if (Math.round(orig.height) !== p.height) el.style.height = `${p.height}px`;
    if (p.offsetX !== 0) {
      el.style.marginLeft = `${Math.round(p.baseMarginLeft + p.offsetX)}px`;
    }
    if (p.offsetY !== 0) {
      el.style.marginTop = `${Math.round(p.baseMarginTop + p.offsetY)}px`;
    }
  }

  function onResizeHandleDown(e: PointerEvent, edge: ResizeEdge): void {
    const p = resizePending;
    if (!p || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = p.width;
    const startH = p.height;
    const startOX = p.offsetX;
    const startOY = p.offsetY;
    const el = p.el;
    const handle = e.currentTarget as HTMLElement;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // capture unsupported — pointer events still fire on the handle
    }
    const prevTransition = el.style.transition;
    el.style.transition = "none";
    const movesE = edge === "e" || edge === "ne" || edge === "se";
    const movesW = edge === "w" || edge === "nw" || edge === "sw";
    const movesS = edge === "s" || edge === "se" || edge === "sw";
    const movesN = edge === "n" || edge === "ne" || edge === "nw";

    function onMove(ev: PointerEvent): void {
      const cur = resizePending;
      if (!cur || !el.isConnected) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let w = startW;
      let h = startH;
      let ox = startOX;
      let oy = startOY;
      if (movesE) w = Math.max(MIN_SIZE, Math.round(startW + dx));
      if (movesW) {
        // Left edge follows the cursor: shrink the width and shift the box
        // right by the same amount, so the RIGHT edge stays anchored. When
        // the width clamps at MIN_SIZE the offset stops too — otherwise the
        // element would keep sliding after it stopped shrinking.
        w = Math.max(MIN_SIZE, Math.round(startW - dx));
        ox = startOX + (startW - w);
      }
      if (movesS) h = Math.max(MIN_SIZE, Math.round(startH + dy));
      if (movesN) {
        h = Math.max(MIN_SIZE, Math.round(startH - dy));
        oy = startOY + (startH - h);
      }
      const next = { ...cur, width: w, height: h, offsetX: ox, offsetY: oy };
      resizePending = next;
      applyResizePreview(next);
    }
    function onUp(ev: PointerEvent): void {
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        // already released
      }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      el.style.transition = prevTransition;
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  function submitResize(): void {
    const p = resizePending;
    if (!p) return;
    const el = p.el;
    const orig = p.sourceTarget.boundingRect;
    const cssChanges: Record<string, string> = {};
    if (Math.round(orig.width) !== p.width) cssChanges["width"] = `${p.width}px`;
    if (Math.round(orig.height) !== p.height) cssChanges["height"] = `${p.height}px`;
    // Only present when the user actually dragged a left / top edge.
    if (p.offsetX !== 0) {
      cssChanges["margin-left"] = `${Math.round(p.baseMarginLeft + p.offsetX)}px`;
    }
    if (p.offsetY !== 0) {
      cssChanges["margin-top"] = `${Math.round(p.baseMarginTop + p.offsetY)}px`;
    }
    const hasComment = resizeComment.trim().length > 0;
    if (Object.keys(cssChanges).length === 0 && !hasComment) {
      // Nothing actually changed — treat as a cancel.
      cancelResize();
      setMode("idle");
      return;
    }
    const annId = newAnnId();
    // Capture WITH the resize preview applied so outerHTML / computedStyles
    // reflect the intended size (same rule as submitSelect).
    const target = captureTarget(el);
    const annotation: Annotation = {
      id: annId,
      createdAt: Date.now(),
      kind: "select",
      strokes: [],
      color: "#2563eb",
      comment: resizeComment.trim(),
      cssChanges: Object.keys(cssChanges).length ? cssChanges : undefined,
      targets: [target],
      target,
      viewport: snapshotViewport(),
      url: location.href,
    };
    chrome.runtime.sendMessage({ type: "annotation.draw-committed", annotation });
    // Keep the preview applied; snapshot for rollback on Remove / clear.
    content.recordAnnotated(
      annId,
      el,
      p.originalCssText,
      p.originalInnerHtml,
      target.selector,
      target.outerHTML,
      target.nearbyText,
      location.href,
    );
    content.attachPreviewChanges(annId, diffAppliedProps(p.baseCssText, el.style.cssText));
    resizePending = null;
    resizeComment = "";
    setMode("idle");
  }

  // Resize-mode pointer handlers: hover to aim, click to select. Handles
  // carry their own pointerdown (onResizeHandleDown) and are skipped here
  // via isOurNode.
  $effect(() => {
    if (content.mode !== "resize") return;
    function onMove(e: MouseEvent) {
      if (resizePending) return;
      const el = e.target as Element | null;
      if (!el || el === document.documentElement || el === document.body || isOurNode(el)) {
        hovered = null;
        return;
      }
      hovered = el;
    }
    function onDown(e: MouseEvent) {
      if (e.button !== 0) return;
      const el = e.target as Element | null;
      if (!el || isOurNode(el)) return;
      if (el === document.documentElement || el === document.body) return;
      e.preventDefault();
      e.stopPropagation();
      if (resizePending) {
        if (resizePending.el === el) return; // already selected
        // Switching target — roll the previous preview back to its base
        // (earlier tools intact), not the true original.
        if (resizePending.el.isConnected) {
          resizePending.el.style.cssText = resizePending.baseCssText;
        }
        resizeComment = "";
      }
      hovered = null;
      beginResizeSelect(el as HTMLElement);
    }
    function onClickSwallow(e: MouseEvent) {
      if (isOurNode(e.target as Element | null)) return;
      e.preventDefault();
      e.stopPropagation();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (resizePending) cancelResize();
      else setMode("idle");
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClickSwallow, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClickSwallow, true);
      document.removeEventListener("keydown", onKey, true);
    };
  });

  // Live rect of the element being resized (tracks its previewed size).
  let resizeRect = $derived.by(() => {
    void tick;
    void resizePending?.width;
    void resizePending?.height;
    const p = resizePending;
    if (!p || !p.el.isConnected) return null;
    const r = p.el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  });

  // ─── Free Transform (v1) ────────────────────────────────────────────
  // Self-contained mode: pick ONE element, then move (drag the box) and
  // resize (corner handle) it freely — every op accumulates into ONE
  // annotation. Does NOT touch the other tools' commit paths, so normal
  // annotating can't regress. Text-edit merges into this next.
  type TransformPending = {
    el: HTMLElement;
    target: AnnotationTarget;
    annId: string;
    baseCssText: string; // style at session start (diff base)
    originalCssText: string; // rollback original for recordAnnotated
    originalInnerHtml: string;
  };
  let transformPending = $state<TransformPending | null>(null);
  let transformComment = $state("");
  // Accumulated inline changes (move + resize), re-applied over baseCssText
  // each update so they layer losslessly (same helper as the other tools).
  let tChanges: Record<string, string> = $state({});
  let tTx = $state(0);
  let tTy = $state(0);

  function beginTransformSelect(el: HTMLElement): void {
    const existing = content.findAnnotatedByElement(el);
    transformPending = {
      el,
      target: captureTarget(el),
      annId: newAnnId(),
      baseCssText: el.style.cssText,
      originalCssText: existing ? existing.originalCssText : el.style.cssText,
      originalInnerHtml: existing ? existing.originalInnerHtml : el.innerHTML,
    };
    tChanges = {};
    tTx = 0;
    tTy = 0;
  }

  function tApply(): void {
    const p = transformPending;
    if (!p || !p.el.isConnected) return;
    applyPreview(p.el, p.baseCssText, tChanges);
  }

  function cancelTransform(): void {
    const p = transformPending;
    if (p && p.el.isConnected) p.el.style.cssText = p.baseCssText;
    transformPending = null;
    transformComment = "";
    tChanges = {};
  }

  $effect(() => {
    if (content.mode !== "transform" && transformPending) cancelTransform();
  });

  function commitTransform(): void {
    const p = transformPending;
    if (!p || !p.el.isConnected) {
      transformPending = null;
      return;
    }
    const el = p.el;
    const diff = diffAppliedProps(p.baseCssText, el.style.cssText);
    const cssChanges: Record<string, string> = {};
    for (const [k, v] of Object.entries(diff)) if (v) cssChanges[k] = v;
    if (Object.keys(cssChanges).length === 0 && !transformComment.trim()) {
      cancelTransform();
      return;
    }
    const annId = p.annId;
    const annotation: Annotation = {
      id: annId,
      createdAt: Date.now(),
      kind: "select",
      strokes: [],
      color: "#a855f7",
      comment: transformComment.trim(),
      cssChanges: Object.keys(cssChanges).length ? cssChanges : undefined,
      targets: [p.target],
      target: p.target,
      viewport: snapshotViewport(),
      url: location.href,
    };
    chrome.runtime.sendMessage({ type: "annotation.draw-committed", annotation });
    content.recordAnnotated(
      annId,
      el,
      p.originalCssText,
      p.originalInnerHtml,
      p.target.selector,
      p.target.outerHTML,
      p.target.nearbyText,
      location.href,
    );
    content.attachPreviewChanges(annId, diff);
    transformPending = null;
    transformComment = "";
    tChanges = {};
  }

  // Select-on-click for transform mode (mirrors resize's picker).
  $effect(() => {
    if (content.mode !== "transform") return;
    function onMove(e: MouseEvent) {
      if (transformPending) return;
      const el = e.target as Element | null;
      if (!el || el === document.documentElement || el === document.body || isOurNode(el)) {
        hovered = null;
        return;
      }
      hovered = el;
    }
    function onDown(e: MouseEvent) {
      if (e.button !== 0) return;
      const el = e.target as Element | null;
      if (!el || isOurNode(el)) return;
      if (el === document.documentElement || el === document.body) return;
      if (transformPending) return; // already selected — the box owns input
      e.preventDefault();
      e.stopPropagation();
      hovered = null;
      beginTransformSelect(el as HTMLElement);
    }
    function onClickSwallow(e: MouseEvent) {
      if (isOurNode(e.target as Element | null)) return;
      e.preventDefault();
      e.stopPropagation();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (transformPending) cancelTransform();
      else setMode("idle");
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClickSwallow, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClickSwallow, true);
      document.removeEventListener("keydown", onKey, true);
    };
  });

  let transformRect = $derived.by(() => {
    void tick;
    void tTx;
    void tTy;
    void tChanges;
    const p = transformPending;
    if (!p || !p.el.isConnected) return null;
    const r = p.el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  });

  // Drag the box body → move via transform: translate. Pointer capture on the
  // handle element so move/up fire AT_TARGET (the overlay host traps pointerup
  // in the bubble phase — see the toolbar drag fix).
  function onTransformMoveDown(e: PointerEvent): void {
    if (!transformPending) return;
    e.preventDefault();
    e.stopPropagation();
    const tgt = e.currentTarget as HTMLElement;
    const sx = e.clientX;
    const sy = e.clientY;
    const bx = tTx;
    const by = tTy;
    tgt.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      tTx = bx + (ev.clientX - sx);
      tTy = by + (ev.clientY - sy);
      tChanges = {
        ...tChanges,
        transform: `translate(${Math.round(tTx)}px, ${Math.round(tTy)}px)`,
      };
      tApply();
    };
    const up = (ev: PointerEvent) => {
      tgt.releasePointerCapture?.(ev.pointerId);
      tgt.removeEventListener("pointermove", move);
      tgt.removeEventListener("pointerup", up);
    };
    tgt.addEventListener("pointermove", move);
    tgt.addEventListener("pointerup", up);
  }

  // Drag the bottom-right handle → resize width/height.
  function onTransformResizeDown(e: PointerEvent): void {
    const p = transformPending;
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    const tgt = e.currentTarget as HTMLElement;
    const r = p.el.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const sw = r.width;
    const sh = r.height;
    tgt.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const w = Math.max(8, Math.round(sw + (ev.clientX - sx)));
      const h = Math.max(8, Math.round(sh + (ev.clientY - sy)));
      tChanges = { ...tChanges, width: `${w}px`, height: `${h}px` };
      tApply();
    };
    const up = (ev: PointerEvent) => {
      tgt.releasePointerCapture?.(ev.pointerId);
      tgt.removeEventListener("pointermove", move);
      tgt.removeEventListener("pointerup", up);
    };
    tgt.addEventListener("pointermove", move);
    tgt.addEventListener("pointerup", up);
  }

  // ─── Paint tool (recolor from the page's own palette) ───────────────
  // Click an element, then pick a color from the swatches harvested off
  // the live page (or point at any element / use the screen eyedropper).
  // Live inline-style preview; commits as `kind:"select"` + `cssChanges`
  // (background-color / color / border-color) — no new agent contract.

  type PaintProp = "background-color" | "color" | "border-color";

  type PaintPending = {
    el: HTMLElement;
    /** TRUE original inline style — the rollback snapshot only. */
    originalCssText: string;
    originalInnerHtml: string;
    /** The element's inline style when Paint began (already carries any
     *  earlier tools' edits). Live preview resets to THIS, not the true
     *  original, so painting doesn't wipe a prior resize / text / scale. */
    baseCssText: string;
    cssChanges: Record<string, string>;
    initial: Record<PaintProp, string>;
  };
  let paintPending = $state<PaintPending | null>(null);
  // Harvested once per entry into paint mode — walking the DOM for every
  // selection would be wasteful and the page palette doesn't change.
  let paintSwatches = $state<Swatch[]>([]);
  let paintEyedropping = $state(false);
  let paintPicker = $state<PaintPicker | null>(null);

  /** The element's current colors as #RRGGBB, or "" when it has none
   *  (transparent background / no border). Empty matters: it means ANY
   *  pick is a real change, so painting white onto a transparent element
   *  isn't mistaken for "same as the original" and dropped. */
  function readPaintColors(el: Element): Record<PaintProp, string> {
    const cs = window.getComputedStyle(el);
    return {
      "background-color": normalizeColor(cs.backgroundColor) ?? "",
      color: normalizeColor(cs.color) ?? "",
      "border-color": normalizeColor(cs.borderTopColor) ?? "",
    };
  }

  function beginPaint(el: HTMLElement): void {
    const existing = content.findAnnotatedByElement(el);
    paintPending = {
      el,
      originalCssText: existing ? existing.originalCssText : el.style.cssText,
      originalInnerHtml: existing ? existing.originalInnerHtml : el.innerHTML,
      baseCssText: el.style.cssText,
      cssChanges: {},
      initial: readPaintColors(el),
    };
  }

  function cancelPaint(): void {
    const p = paintPending;
    // Restore to the base (before Paint began), NOT the true original —
    // cancelling Paint must not undo an earlier resize / text on the
    // same element.
    if (p && p.el.isConnected) p.el.style.cssText = p.baseCssText;
    paintPending = null;
    paintEyedropping = false;
    hovered = null;
  }

  // Leaving paint mode with an un-submitted pick → roll the preview back.
  $effect(() => {
    if (content.mode !== "paint" && paintPending) cancelPaint();
  });

  // Harvest the page palette on entry; drop it on exit so a later run
  // re-reads a possibly-changed page.
  $effect(() => {
    if (content.mode === "paint") {
      paintSwatches = harvestPageColors();
    } else {
      paintSwatches = [];
    }
  });

  /** Apply one color live. Empty value resets that property. */
  function applyPaint(prop: string, value: string): void {
    const p = paintPending;
    if (!p) return;
    const next = { ...p.cssChanges };
    if (value.trim()) next[prop] = value.trim();
    else delete next[prop];
    paintPending = { ...p, cssChanges: next };
    if (!p.el.isConnected) return;
    // Reset to the base (earlier tools' edits intact), then layer colors.
    applyPreview(p.el, p.baseCssText, next);
  }

  /**
   * Sample a color from the page. Prefers Chrome's native EyeDropper (any
   * pixel, including images); falls back to a point-at-an-element sampler
   * driven by the paint-mode click handler when it isn't available.
   */
  async function startEyedrop(): Promise<void> {
    const Picker = (
      window as unknown as {
        EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> };
      }
    ).EyeDropper;
    if (Picker) {
      try {
        paintEyedropping = true;
        const { sRGBHex } = await new Picker().open();
        const hex = normalizeColor(sRGBHex);
        if (hex) paintPicker?.applySampled(hex);
      } catch {
        // user pressed Esc / dismissed — nothing to do
      } finally {
        paintEyedropping = false;
      }
      return;
    }
    // No native picker — arm the DOM sampler; the next page click samples
    // the element under the cursor instead of re-selecting a target.
    paintEyedropping = true;
  }

  function submitPaint(): void {
    const p = paintPending;
    if (!p) return;
    if (Object.keys(p.cssChanges).length === 0) {
      cancelPaint();
      setMode("idle");
      return;
    }
    const el = p.el;
    const annId = newAnnId();
    // Capture WITH the paint applied so outerHTML / computedStyles show
    // the intended colors (same rule as submitSelect).
    const target = captureTarget(el);
    const annotation: Annotation = {
      id: annId,
      createdAt: Date.now(),
      kind: "select",
      strokes: [],
      color: "#2563eb",
      comment: "",
      cssChanges: p.cssChanges,
      targets: [target],
      target,
      viewport: snapshotViewport(),
      url: location.href,
    };
    chrome.runtime.sendMessage({ type: "annotation.draw-committed", annotation });
    content.recordAnnotated(
      annId,
      el,
      p.originalCssText,
      p.originalInnerHtml,
      target.selector,
      target.outerHTML,
      target.nearbyText,
      location.href,
    );
    content.attachPreviewChanges(annId, diffAppliedProps(p.baseCssText, el.style.cssText));
    paintPending = null;
    paintEyedropping = false;
    setMode("idle");
  }

  // Paint-mode pointer handlers: hover to aim, click to select a target
  // (or, while eyedropping, to sample the pointed element's color).
  $effect(() => {
    if (content.mode !== "paint") return;
    function onMove(e: MouseEvent) {
      if (paintPending && !paintEyedropping) return;
      const el = e.target as Element | null;
      if (!el || el === document.documentElement || el === document.body || isOurNode(el)) {
        hovered = null;
        return;
      }
      hovered = el;
    }
    function onDown(e: MouseEvent) {
      if (e.button !== 0) return;
      const el = e.target as Element | null;
      if (!el || isOurNode(el)) return;
      if (el === document.documentElement || el === document.body) return;
      e.preventDefault();
      e.stopPropagation();
      // Eyedropper armed → this click samples the element's color and
      // hands it to the picker rather than re-selecting the target.
      if (paintEyedropping && paintPending) {
        const hex = sampleElementColor(el);
        if (hex) paintPicker?.applySampled(hex);
        paintEyedropping = false;
        hovered = null;
        return;
      }
      if (paintPending) {
        if (paintPending.el === el) return; // already selected
        // Switch target — restore the previous element to its base
        // (earlier tools intact), not the true original.
        if (paintPending.el.isConnected) {
          paintPending.el.style.cssText = paintPending.baseCssText;
        }
      }
      hovered = null;
      beginPaint(el as HTMLElement);
    }
    function onClickSwallow(e: MouseEvent) {
      if (isOurNode(e.target as Element | null)) return;
      e.preventDefault();
      e.stopPropagation();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (paintEyedropping) paintEyedropping = false;
      else if (paintPending) cancelPaint();
      else setMode("idle");
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClickSwallow, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClickSwallow, true);
      document.removeEventListener("keydown", onKey, true);
    };
  });

  let paintRect = $derived(rectOf(paintPending?.el ?? null));

  // ─── Scale tool (make a widget proportionally bigger / smaller) ──────
  // Distinct from Resize: Resize sets an explicit width/height box and lets
  // the content reflow. Scale expresses INTENT — "make this 125% bigger,
  // every dimension" — and the agent scales the real values (font-size,
  // box, padding, gaps, radius) in the project's styling system. The
  // annotation carries NO computed CSS, just the percentage as a plain
  // instruction; the on-page `transform: scale()` is preview-ONLY so the
  // user can see the size they're choosing.

  type ScalePending = {
    el: HTMLElement;
    /** TRUE original inline style — rollback snapshot only. */
    originalCssText: string;
    originalInnerHtml: string;
    /** Inline style when Scale began (carries earlier tools). The preview
     *  transform layers on THIS so it doesn't wipe a prior resize / paint,
     *  and is peeled back to it before capturing the target. */
    baseCssText: string;
    percent: number;
    /** Unscaled top-left origin + rect, captured at select time — the
     *  corner-drag gesture measures against this. */
    baseW: number;
    baseH: number;
  };
  let scalePending = $state<ScalePending | null>(null);
  let scaleNote = $state("");

  const SCALE_MIN = 25;
  const SCALE_MAX = 300;

  function applyScalePreview(p: ScalePending): void {
    const el = p.el;
    if (!el.isConnected) return;
    // Layer the preview transform on the base (earlier tools intact), not
    // the true original.
    el.style.cssText = p.baseCssText;
    if (p.percent === 100) return;
    // Preview only — grows from the element's own top-left so it expands
    // into the page the way the real change would read.
    el.style.transformOrigin = "top left";
    el.style.transform = `scale(${p.percent / 100})`;
  }

  function setScalePercent(next: number): void {
    const p = scalePending;
    if (!p) return;
    const percent = Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(next)));
    scalePending = { ...p, percent };
    applyScalePreview(scalePending);
  }

  function beginScale(el: HTMLElement): void {
    const existing = content.findAnnotatedByElement(el);
    const r = el.getBoundingClientRect();
    scalePending = {
      el,
      originalCssText: existing ? existing.originalCssText : el.style.cssText,
      originalInnerHtml: existing ? existing.originalInnerHtml : el.innerHTML,
      baseCssText: el.style.cssText,
      percent: 100,
      baseW: Math.max(1, r.width),
      baseH: Math.max(1, r.height),
    };
  }

  function cancelScale(): void {
    const p = scalePending;
    // Restore the base (before Scale began), not the true original.
    if (p && p.el.isConnected) p.el.style.cssText = p.baseCssText;
    scalePending = null;
    scaleNote = "";
    hovered = null;
  }

  // Leaving scale mode with an un-submitted pick → roll the preview back.
  $effect(() => {
    if (content.mode !== "scale" && scalePending) cancelScale();
  });

  /** Corner-drag: scale radially from the element's top-left origin, so
   *  dragging away grows it and dragging in shrinks it. */
  function onScaleHandleDown(e: PointerEvent): void {
    const p = scalePending;
    if (!p || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = p.el;
    const rect = el.getBoundingClientRect();
    const ox = rect.left;
    const oy = rect.top;
    const startPercent = p.percent;
    const d0 = Math.max(8, Math.hypot(e.clientX - ox, e.clientY - oy));
    const handle = e.currentTarget as HTMLElement;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // capture unsupported — pointer events still fire on the handle
    }
    function onMove(ev: PointerEvent): void {
      if (!scalePending) return;
      const d1 = Math.hypot(ev.clientX - ox, ev.clientY - oy);
      setScalePercent(startPercent * (d1 / d0));
    }
    function onUp(ev: PointerEvent): void {
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        // already released
      }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  /** The instruction the agent acts on. Deliberately prose, not CSS —
   *  the agent picks the right expression for the project. */
  function scaleComment(percent: number, note: string): string {
    const dir = percent >= 100 ? "bigger" : "smaller";
    const base =
      `Scale this element to ${percent}% of its current size — make it ${dir} ` +
      `proportionally. Grow/shrink EVERY dimension together: font-size, ` +
      `width/height, padding, margins, gaps, border-radius and any icon sizes. ` +
      `Apply it as real values in this project's styling system (utility steps, ` +
      `design tokens, or plain CSS — whatever the file already uses). Do NOT use ` +
      `a CSS \`transform: scale()\`, and keep the element responsive.`;
    const extra = note.trim();
    return extra ? `${base}\n\n${extra}` : base;
  }

  function submitScale(): void {
    const p = scalePending;
    if (!p || p.percent === 100) return;
    const el = p.el;
    // Capture from the base geometry (earlier tools intact, but WITHOUT
    // the scale transform): peeling to the base keeps a prior resize/paint
    // in the captured outerHTML while dropping the transform we tell the
    // agent not to emit.
    const previewCss = el.style.cssText;
    if (el.isConnected) el.style.cssText = p.baseCssText;
    const target = captureTarget(el);
    if (el.isConnected) el.style.cssText = previewCss;

    const annId = newAnnId();
    const annotation: Annotation = {
      id: annId,
      createdAt: Date.now(),
      kind: "select",
      strokes: [],
      color: "#2563eb",
      comment: scaleComment(p.percent, scaleNote),
      targets: [target],
      target,
      viewport: snapshotViewport(),
      url: location.href,
    };
    chrome.runtime.sendMessage({ type: "annotation.draw-committed", annotation });
    content.recordAnnotated(
      annId,
      el,
      p.originalCssText,
      p.originalInnerHtml,
      target.selector,
      target.outerHTML,
      target.nearbyText,
      location.href,
    );
    // Scale leaves a transform preview on the element — record it so a
    // rebuild after removing a sibling reinstates (or drops) it correctly.
    content.attachPreviewChanges(annId, diffAppliedProps(p.baseCssText, el.style.cssText));
    scalePending = null;
    scaleNote = "";
    setMode("idle");
  }

  // Scale-mode pointer handlers: hover to aim, click to select.
  $effect(() => {
    if (content.mode !== "scale") return;
    function onMove(e: MouseEvent) {
      if (scalePending) return;
      const el = e.target as Element | null;
      if (!el || el === document.documentElement || el === document.body || isOurNode(el)) {
        hovered = null;
        return;
      }
      hovered = el;
    }
    function onDown(e: MouseEvent) {
      if (e.button !== 0) return;
      const el = e.target as Element | null;
      if (!el || isOurNode(el)) return;
      if (el === document.documentElement || el === document.body) return;
      e.preventDefault();
      e.stopPropagation();
      if (scalePending) {
        if (scalePending.el === el) return; // already selected
        if (scalePending.el.isConnected) {
          scalePending.el.style.cssText = scalePending.baseCssText;
        }
        scaleNote = "";
      }
      hovered = null;
      beginScale(el as HTMLElement);
    }
    function onClickSwallow(e: MouseEvent) {
      if (isOurNode(e.target as Element | null)) return;
      e.preventDefault();
      e.stopPropagation();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (scalePending) cancelScale();
      else setMode("idle");
    }
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClickSwallow, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClickSwallow, true);
      document.removeEventListener("keydown", onKey, true);
    };
  });

  // Live rect of the scaled element — tracks the preview transform so the
  // picker + corner handle follow it.
  let scaleRect = $derived.by(() => {
    void tick;
    void scalePending?.percent;
    const p = scalePending;
    if (!p || !p.el.isConnected) return null;
    const r = p.el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  });

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
  // The element's inline style + markup as they were when THIS selection
  // began — already carrying any earlier tool's edits. Live preview
  // resets to these (not the true original) so editing an element that was
  // already resized / painted doesn't wipe that work. `originalCssText`
  // stays the true original, used only for the rollback snapshot.
  let previewBaseCss = $state<string | null>(null);
  let previewBaseInnerHtml = $state<string | null>(null);
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
      // Preview base = the element's CURRENT inline state (includes any
      // earlier tool's edits), so the live preview layers on top of them.
      previewBaseCss = (selected as HTMLElement).style.cssText;
      previewBaseInnerHtml = (selected as HTMLElement).innerHTML;
      originalText = textOf(selected);
    } else {
      originalCssText = null;
      originalInnerHtml = null;
      previewBaseCss = null;
      previewBaseInnerHtml = null;
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
    if (!selected || !selected.isConnected || previewBaseCss === null) return;
    const el = selected as HTMLElement;
    // Reset to the preview BASE (earlier tools intact), then re-apply this
    // annotation's edits on top.
    el.style.cssText = previewBaseCss;
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
    } else if (textWasMutated && previewBaseInnerHtml !== null) {
      // User cleared their Content edit — restore the base markup
      // (NOT innerText, which would collapse children).
      el.innerHTML = previewBaseInnerHtml;
      textWasMutated = false;
    }
  });

  function restoreOriginal() {
    if (!selected || previewBaseCss === null) return;
    const el = selected as HTMLElement;
    if (!el.isConnected) return;
    // Roll back to the base (before this selection's edits), not the true
    // original, so an earlier tool's edit on the same element survives.
    el.style.cssText = previewBaseCss;
    if (textWasMutated && previewBaseInnerHtml !== null) {
      el.innerHTML = previewBaseInnerHtml;
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
   * Roll back ONE removed annotation. When it's the only annotation on the
   * element, snap to the true original (the simple case — also restores
   * markup for a content edit). When the element carries OTHER annotations
   * too (tools were combined on it), rebuild its inline STYLE from the true
   * original + the survivors' deltas so peeling off this one edit doesn't
   * drop the others. Markup is left as-is in the survivors path: combined
   * style tools never touch it, and re-asserting it here would risk
   * clobbering a sibling's text-content edit.
   */
  function restoreFromEntry(entry: {
    element: Element;
    originalCssText: string;
    originalInnerHtml: string;
    previewChanges?: Record<string, string>;
  }): void {
    const el = entry.element as HTMLElement;
    if (!el?.isConnected) return;
    const survivors = content.annotatedForElement(el);
    if (survivors.length === 0) {
      restoreFromSnapshot(entry);
      return;
    }
    rebuildInline(
      el,
      entry.originalCssText,
      survivors.map((s) => s.previewChanges ?? {}),
    );
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
  // Redo / undo-of-remove: re-resolve the element and RE-APPLY the
  // annotation's preview (unlike replay, which only re-paints the badge over
  // the current state). Covers the common kinds — select(cssChanges), delete,
  // in-place text edit. Move / text-insert fall back to a badge-only replay.
  function reapplyAnnotation(ann: Annotation): void {
    if (content.annotated.some((a) => a.id === ann.id)) return; // already live
    const targets = ann.targets ?? (ann.target ? [ann.target] : []);
    const primary = targets[0];
    if (!primary) {
      return;
    }
    const el = content.findElementForEntry({
      selector: primary.selector,
      outerHTML: primary.outerHTML,
      nearbyText: primary.nearbyText,
    });
    if (!el) return;
    const html = el as HTMLElement;
    const orig = html.style?.cssText ?? "";
    const origHtml = html.innerHTML;
    const url = ann.url ?? location.href;
    if (ann.kind === "delete") {
      html.style.setProperty("display", "none", "important");
      content.recordAnnotated(
        ann.id, el, orig, origHtml,
        primary.selector, primary.outerHTML, primary.nearbyText,
        url, false, undefined, true,
      );
      return;
    }
    const changes = ann.cssChanges ?? {};
    if (Object.keys(changes).length) applyPreview(html, orig, changes);
    if (ann.contentChange) {
      try { html.textContent = ann.contentChange.textAfter; } catch { /* ignore */ }
    }
    content.recordAnnotated(
      ann.id, el, orig, origHtml,
      primary.selector, primary.outerHTML, primary.nearbyText, url,
    );
    if (Object.keys(changes).length) {
      content.attachPreviewChanges(ann.id, diffAppliedProps(orig, html.style.cssText));
    }
  }

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
    // Record the snapshot WITH the annotation. If the element was already
    // annotated (re-edit / combined tools), recordAnnotated stores another
    // entry pointing at the same true-original snapshot, plus this edit's
    // `previewChanges` delta — so removing ONE annotation rebuilds from the
    // survivors instead of nuking the element back to the true original.
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
      content.attachPreviewChanges(
        annId,
        diffAppliedProps(previewBaseCss ?? "", (selected as HTMLElement).style.cssText),
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

<!-- Floating on-page toolbar (Settings-gated). Same tools as the side panel;
  clicking one drives the overlay directly. Hidden while viewing an imported
  read-only session so the two overlays never fight. -->
{#if content.floatingToolbarEnabled && !imported}
  <FloatingToolbar
    mode={content.mode}
    tool={content.tool}
    transformOn={content.freeTransform}
    onpick={pickTool}
    onaction={(id) =>
      chrome.runtime
        .sendMessage({
          type:
            id === "add-task" ? "toolbar.add-task" : "toolbar.add-selector",
        })
        .catch(() => {})}
  />
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
  {#if r && !a.deleted && (!a.url || a.url === currentUrl)}
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

{#if content.mode === "move"}
  {#if hoverRect && !pendingMove}
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
      {describe(hovered)} · {moveExtras.length ? "drag to move all · Ctrl/Cmd+click to add" : "drag to move · Ctrl/Cmd+click for multi"}
    </div>
  {/if}
  <!-- Ctrl/Cmd-clicked siblings — dashed emerald halos, shown both while
    selecting (pre-drag) and mid-drag so the group stays visibly ganged. -->
  {#each moveExtraRects as ex (ex.el)}
    <div
      class="hl hl--move-extra"
      style:top="{ex.rect.top}px"
      style:left="{ex.rect.left}px"
      style:width="{ex.rect.width}px"
      style:height="{ex.rect.height}px"
    ></div>
  {/each}
  {#if pendingMove && moveRect}
    <div
      class="hl hl--selected"
      style:top="{moveRect.top}px"
      style:left="{moveRect.left}px"
      style:width="{moveRect.width}px"
      style:height="{moveRect.height}px"
    ></div>
  {/if}
  {#if moveDropRects}
    <div
      class="hl hl--drop"
      style:top="{moveDropRects.container.top}px"
      style:left="{moveDropRects.container.left}px"
      style:width="{moveDropRects.container.width}px"
      style:height="{moveDropRects.container.height}px"
    ></div>
    <div
      class="drop-bar"
      style:top="{moveDropRects.bar.top}px"
      style:left="{moveDropRects.bar.left}px"
      style:width="{moveDropRects.bar.width}px"
      style:height="{moveDropRects.bar.height}px"
    ></div>
  {/if}
  {#if pendingMove?.frozen && moveRect}
    <CommentInput
      anchor={moveRect}
      title="Move {describe(pendingMove.el)}"
      allowEmpty={true}
      bind:value={moveComment}
      bind:images={moveImages}
      onsubmit={submitMove}
      oncancel={cancelMove}
    />
  {/if}
{/if}

{#if content.mode === "text"}
  {#if hoverRect && !pendingTextEdit && !pendingTextInsert}
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
      {describe(hovered)} · click to edit text
    </div>
  {/if}
  <!-- Floating format toolbar while editing an existing element's text. -->
  {#if pendingTextEdit && textEditRect}
    <TextFormatToolbar
      anchor={textEditRect}
      title={describe(pendingTextEdit.el)}
      initial={pendingTextEdit.initialStyles}
      onformat={applyTextFormat}
      ondone={() => finishTextEdit(true)}
      oncancel={cancelTextTool}
    />
  {/if}
{/if}

{#if content.mode === "delete"}
  {#if hoverRect}
    <div
      class="hl hl--delete"
      style:top="{hoverRect.top}px"
      style:left="{hoverRect.left}px"
      style:width="{hoverRect.width}px"
      style:height="{hoverRect.height}px"
    ></div>
    <div
      class="label label--delete"
      style:top="{Math.max(0, hoverRect.top - 22)}px"
      style:left="{hoverRect.left}px"
    >
      {describe(hovered)} · click to remove
    </div>
  {/if}
{/if}

{#if content.mode === "resize"}
  {#if hoverRect && !resizePending}
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
      {describe(hovered)} · click to resize
    </div>
  {/if}
  {#if resizePending && resizeRect}
    <div
      class="hl hl--selected"
      style:top="{resizeRect.top}px"
      style:left="{resizeRect.left}px"
      style:width="{resizeRect.width}px"
      style:height="{resizeRect.height}px"
    ></div>
    <!-- Live dimension readout. -->
    <div
      class="rsz-dim"
      style:top="{Math.max(0, resizeRect.top - 22)}px"
      style:left="{resizeRect.left}px"
    >
      {resizePending.width} × {resizePending.height}
    </div>
    <!-- All 8 handles. Left / top drags move that edge and keep the
         opposite one anchored (see applyResizePreview). -->
    {#each RESIZE_HANDLES as h (h.edge)}
      <div
        class="rsz-handle rsz-handle--{h.edge}"
        style:top="{resizeRect.top + resizeRect.height * h.y - 7}px"
        style:left="{resizeRect.left + resizeRect.width * h.x - 7}px"
        onpointerdown={(e) => onResizeHandleDown(e, h.edge)}
        role="button"
        tabindex="0"
        aria-label={h.label}
      ></div>
    {/each}
    <CommentInput
      anchor={resizeRect}
      title="Resize {describe(resizePending.el)} → {resizePending.width}×{resizePending.height}"
      allowEmpty={true}
      bind:value={resizeComment}
      onsubmit={submitResize}
      oncancel={cancelResize}
    />
  {/if}
{/if}

{#if content.mode === "transform"}
  {#if hoverRect && !transformPending}
    <div
      class="hl hl--selected"
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
      {describe(hovered)} · click to free-transform
    </div>
  {/if}
  {#if transformPending && transformRect}
    <!-- Drag the box body → move; drag the corner → resize. Both accumulate
         into ONE annotation, committed via the comment box's ✓. -->
    <div
      class="ft-move"
      style:top="{transformRect.top}px"
      style:left="{transformRect.left}px"
      style:width="{transformRect.width}px"
      style:height="{transformRect.height}px"
      onpointerdown={onTransformMoveDown}
      role="button"
      tabindex="-1"
      aria-label="Drag to move"
    ></div>
    <div
      class="rsz-handle rsz-handle--se"
      style:top="{transformRect.top + transformRect.height - 7}px"
      style:left="{transformRect.left + transformRect.width - 7}px"
      onpointerdown={onTransformResizeDown}
      role="button"
      tabindex="0"
      aria-label="Resize"
    ></div>
    <CommentInput
      anchor={transformRect}
      title="Free transform {describe(transformPending.el)}"
      allowEmpty={true}
      bind:value={transformComment}
      onsubmit={commitTransform}
      oncancel={cancelTransform}
    />
  {/if}
{/if}

{#if content.mode === "paint"}
  {#if hoverRect && (!paintPending || paintEyedropping)}
    <div
      class="hl hl--paint"
      style:top="{hoverRect.top}px"
      style:left="{hoverRect.left}px"
      style:width="{hoverRect.width}px"
      style:height="{hoverRect.height}px"
    ></div>
    <div
      class="label label--paint"
      style:top="{Math.max(0, hoverRect.top - 22)}px"
      style:left="{hoverRect.left}px"
    >
      {describe(hovered)} · {paintEyedropping ? "click to sample this color" : "click to paint"}
    </div>
  {/if}
  {#if paintPending && paintRect}
    <div
      class="hl hl--selected"
      style:top="{paintRect.top}px"
      style:left="{paintRect.left}px"
      style:width="{paintRect.width}px"
      style:height="{paintRect.height}px"
    ></div>
    <!-- Re-key on the selected element so switching paint targets remounts
         the picker and re-seeds its swatch state from the new element's
         colors (its `picked` snapshots `initial` at mount). -->
    {#key paintPending.el}
      <PaintPicker
        bind:this={paintPicker}
        anchor={paintRect}
        title={describe(paintPending.el)}
        swatches={paintSwatches}
        initial={paintPending.initial}
        onpaint={applyPaint}
        eyedropping={paintEyedropping}
        onEyedropStart={startEyedrop}
        onsubmit={submitPaint}
        oncancel={cancelPaint}
      />
    {/key}
  {/if}
{/if}

{#if content.mode === "scale"}
  {#if hoverRect && !scalePending}
    <div
      class="hl hl--scale"
      style:top="{hoverRect.top}px"
      style:left="{hoverRect.left}px"
      style:width="{hoverRect.width}px"
      style:height="{hoverRect.height}px"
    ></div>
    <div
      class="label label--scale"
      style:top="{Math.max(0, hoverRect.top - 22)}px"
      style:left="{hoverRect.left}px"
    >
      {describe(hovered)} · click to scale
    </div>
  {/if}
  {#if scalePending && scaleRect}
    <div
      class="hl hl--scale hl--selected"
      style:top="{scaleRect.top}px"
      style:left="{scaleRect.left}px"
      style:width="{scaleRect.width}px"
      style:height="{scaleRect.height}px"
    ></div>
    <div
      class="rsz-dim scale__badge"
      style:top="{Math.max(0, scaleRect.top - 22)}px"
      style:left="{scaleRect.left}px"
    >
      {scalePending.percent}%
    </div>
    <!-- Corner handle: drag away from the top-left to grow, in to shrink. -->
    <div
      class="rsz-handle rsz-handle--se scale__handle"
      style:top="{scaleRect.top + scaleRect.height - 7}px"
      style:left="{scaleRect.left + scaleRect.width - 7}px"
      onpointerdown={onScaleHandleDown}
      role="button"
      tabindex="0"
      aria-label="Drag to scale"
    ></div>
    <ScalePicker
      anchor={scaleRect}
      title={describe(scalePending.el)}
      percent={scalePending.percent}
      bind:note={scaleNote}
      onpercent={setScalePercent}
      onsubmit={submitScale}
      oncancel={cancelScale}
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
    {:else if content.mode === "move"}
      Move · {pendingMove?.frozen ? "confirm in the popover · Esc to undo" : pendingMove ? "release to drop" : moveExtras.length ? `${moveExtras.length} picked · drag any to move all · Ctrl/Cmd+click to add` : "drag an element · Ctrl/Cmd+click to move several"} · Esc to exit
    {:else if content.mode === "text"}
      Text · {pendingTextEdit ? "type + format in the toolbar · Enter to save · Esc to cancel" : pendingTextInsert ? "type · Enter to save · Esc to cancel" : "click text to edit · click a gap to add a paragraph"} · Esc to exit
    {:else if content.mode === "delete"}
      Delete · click an element to remove it · undo by removing its card in the side panel · Esc to exit
    {:else if content.mode === "resize"}
      Resize · {resizePending ? "drag the handles · Save to keep · Esc to undo" : "click an element to resize"} · Esc to exit
    {:else if content.mode === "paint"}
      Paint · {paintEyedropping ? "click anything to sample its color" : paintPending ? "pick a color from the page palette · Esc to undo" : "click an element to recolor it"} · Esc to exit
    {:else if content.mode === "scale"}
      Scale · {scalePending ? "drag the corner or pick a % · Save to keep · Esc to undo" : "click a widget to scale it"} · Esc to exit
    {/if}
  </div>
{/if}

<!-- Styles are injected into the shadow root by overlay.ts via styles.css -->
