<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { Annotation, AnnotationTarget } from "@pinta/shared";
  import { app } from "../lib/state.svelte.js";
  import { uid } from "../lib/id.js";
  import { compositeAnnotations } from "../lib/composite.js";
  import { formatSessionAsClipboard } from "../lib/format-clipboard.js";
  import { theme, toggleTheme } from "../lib/theme.svelte.js";
  import StatusPill from "./StatusPill.svelte";
  import AnnotationCard from "./AnnotationCard.svelte";
  import SessionHistory from "./SessionHistory.svelte";

  type Tool = "select" | "arrow" | "rect" | "circle" | "freehand" | "pin";
  type ActiveMode = "idle" | "select" | "draw";

  // SVG paths render reliably across fonts/OSes, follow currentColor in
  // both light + dark mode, and don't depend on unicode glyph coverage.
  const TOOLS: { id: Tool; label: string; svg: string }[] = [
    {
      id: "select",
      label: "Select",
      // Lucide mouse-pointer-2 — solid cursor arrow. fill=currentColor
      // overrides the container's fill="none" so the cursor renders solid.
      svg: '<path d="M4 4l7 17 2.5-7.5L21 11z" fill="currentColor" stroke="currentColor" stroke-width="1"/>',
    },
    {
      id: "arrow",
      label: "Arrow",
      svg: '<path d="M7 17 L17 7"/><path d="M9 7 L17 7 L17 15"/>',
    },
    {
      id: "rect",
      label: "Rect",
      svg: '<rect x="3" y="6" width="18" height="12" rx="1.5"/>',
    },
    {
      id: "freehand",
      label: "Pen",
      svg: '<path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    },
    {
      id: "pin",
      label: "Pin",
      svg: '<path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="3"/>',
    },
  ];

  let pageUrl = $state<string>("");
  let activeTabId = $state<number | null>(null);
  let activeTool = $state<Tool | null>(null);
  let selector = $state("");
  let comment = $state("");
  let capturing = $state(false);
  // Screenshots add ~1.5–2k vision tokens per submit. Off by default; the
  // agent works fine with selector + outerHTML + nearbyText alone for most
  // text/style edits.
  let includeScreenshot = $state(false);
  let copiedAt = $state<number | null>(null);
  let autoReloadEnabled = $state(true);
  let autoApplyEnabled = $state(false);
  let hmrDetected = $state<boolean | null>(null);
  let reloadingAt = $state<number | null>(null);
  let lastHandledSessionId = $state<string | null>(null);

  type IncomingMsg = {
    type?: string;
    annotationId?: string;
    target?: AnnotationTarget;
    comment?: string;
    customCss?: string;
    cssChanges?: Record<string, string>;
    contentChange?: { textBefore: string; textAfter: string };
    viewport?: { scrollY: number; width: number; height: number };
    annotation?: Annotation;
  };

  onMount(async () => {
    app.start();
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      pageUrl = tab?.url ?? "";
      activeTabId = tab?.id ?? null;
    } catch {
      // not running in extension context (e.g. dev preview)
    }

    const handler = (msg: unknown) => {
      const m = msg as IncomingMsg;
      if (m?.type === "annotation.target-selected" && m.target) {
        const annotation: Annotation = {
          id: m.annotationId ?? uid("ann"),
          createdAt: Date.now(),
          kind: "select",
          strokes: [],
          color: "#FF3D6E",
          comment: (m.comment ?? "").trim(),
          customCss: m.customCss?.trim() || undefined,
          cssChanges:
            m.cssChanges && Object.keys(m.cssChanges).length > 0
              ? m.cssChanges
              : undefined,
          contentChange: m.contentChange,
          target: m.target,
          viewport: m.viewport ?? snapshotViewport(),
        };
        app.addAnnotation(annotation);
        activeTool = null;
      } else if (m?.type === "annotation.draw-committed" && m.annotation) {
        app.addAnnotation(m.annotation);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  });

  onDestroy(() => app.stop());

  $effect(() => {
    if (app.connectionStatus === "connected" && pageUrl && !app.session) {
      app.ensureSession(pageUrl);
    }
  });

  const annotations = $derived(app.session?.annotations ?? []);
  const canSubmit = $derived(
    annotations.length > 0 && app.session?.status === "drafting",
  );
  const canEditAnnotations = $derived(app.session?.status === "drafting");
  const allDone = $derived(
    app.session?.status === "done" || app.session?.status === "error",
  );
  // Drawing-kind annotations carry only stroke coords + comment — no DOM
  // selector, no outerHTML. Without a screenshot the agent has nothing to
  // act on, so we auto-enable capture as soon as one lands in the session
  // and lock the toggle.
  const hasDrawingAnnotation = $derived(
    annotations.some((a) => a.kind !== "select"),
  );
  $effect(() => {
    if (hasDrawingAnnotation && !includeScreenshot) {
      includeScreenshot = true;
    }
  });

  async function setActive(tool: Tool | null) {
    if (activeTabId == null) return;
    const next = tool;
    const mode: ActiveMode =
      next == null ? "idle" : next === "select" ? "select" : "draw";
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: "mode.set",
        mode,
        tool: mode === "draw" ? next : undefined,
      });
      activeTool = next;
    } catch (err) {
      const msg = (err as Error).message;
      if (
        /Receiving end does not exist|Could not establish connection/.test(msg)
      ) {
        app.lastError =
          "Pinta isn't injected on this tab yet. Refresh the tab (F5) and try again. " +
          "If it's a chrome:// or new-tab page, navigate to your app first.";
      } else {
        app.lastError = `couldn't reach page: ${msg}`;
      }
    }
  }

  function snapshotViewport() {
    return {
      scrollY: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  function addAnnotationFromForm() {
    if (!selector.trim() || !comment.trim()) return;
    const annotation: Annotation = {
      id: uid("ann"),
      createdAt: Date.now(),
      kind: "select",
      strokes: [],
      color: "#FF3D6E",
      comment: comment.trim(),
      viewport: snapshotViewport(),
      target: {
        selector: selector.trim(),
        outerHTML: "",
        computedStyles: {},
        nearbyText: [],
        boundingRect: { x: 0, y: 0, width: 0, height: 0 },
      },
    };
    app.addAnnotation(annotation);
    selector = "";
    comment = "";
  }

  function removeAnnotation(id: string) {
    app.removeAnnotation(id);
    // Drop the matching pin badge in the content overlay too.
    if (activeTabId != null) {
      chrome.tabs
        .sendMessage(activeTabId, { type: "annotated.remove", annotationId: id })
        .catch(() => {});
    }
  }

  async function cancelSession() {
    if (!app.session) return;
    // Wipe pin badges in the content overlay before the session resets.
    if (activeTabId != null) {
      chrome.tabs
        .sendMessage(activeTabId, { type: "annotated.clear" })
        .catch(() => {});
    }
    await app.cancelAndRestart(pageUrl || app.session.url);
    activeTool = null;
  }

  // Best-effort HMR detection: probe the page for known dev-mode markers.
  // Returns true if any are present (Vite, Webpack/Next.js, Parcel HMR).
  async function detectHmr(tabId: number): Promise<boolean> {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const w = window as unknown as Record<string, unknown>;
          if (document.querySelector('script[src*="@vite/client"]')) return true;
          if (document.querySelector('script[src*="vite/dist"]')) return true;
          if (w.__vite_plugin_react_preamble_installed__) return true;
          if (w.__HMR__) return true;
          if (w.webpackHotUpdate || w.__webpack_hmr) return true;
          if (w.__NEXT_HMR_LATENCY_CB || w.__NEXT_DATA__) {
            // __NEXT_DATA__ exists in prod too; only treat as HMR if there
            // is also a websocket-ish error overlay element.
            if (document.querySelector("nextjs-portal, nextjs-build-watcher")) {
              return true;
            }
          }
          if (document.querySelector("vite-error-overlay")) return true;
          if (document.querySelector("[data-svelte-h]") && location.hostname === "localhost") {
            // Heuristic only — Svelte 5 hydration markers + localhost.
            return true;
          }
          return false;
        },
      });
      return !!result;
    } catch {
      return false;
    }
  }

  async function reloadActiveTab() {
    if (activeTabId == null) return;
    reloadingAt = Date.now();
    try {
      await chrome.tabs.reload(activeTabId);
      setTimeout(() => {
        if (reloadingAt && Date.now() - reloadingAt >= 1500) reloadingAt = null;
      }, 1600);
    } catch (err) {
      app.lastError = `reload failed: ${(err as Error).message}`;
      reloadingAt = null;
    }
  }

  // When a session reaches done/error, optionally auto-reload the tab if
  // no HMR was detected. Tracked by session id so we don't re-trigger on
  // re-renders.
  $effect(() => {
    const session = app.session;
    if (!session) return;
    if (session.status !== "done") return;
    if (lastHandledSessionId === session.id) return;
    lastHandledSessionId = session.id;
    if (activeTabId == null) return;

    detectHmr(activeTabId).then((hasHmr) => {
      hmrDetected = hasHmr;
      if (!hasHmr && autoReloadEnabled) reloadActiveTab();
    });
  });

  async function copyToClipboard() {
    if (!annotations.length) return;
    const text = formatSessionAsClipboard({
      url: pageUrl || app.session?.url || "",
      annotations,
    });
    try {
      await navigator.clipboard.writeText(text);
      copiedAt = Date.now();
      setTimeout(() => {
        if (copiedAt && Date.now() - copiedAt >= 2000) copiedAt = null;
      }, 2100);
    } catch (err) {
      app.lastError = `clipboard write failed: ${(err as Error).message}`;
    }
  }

  async function submit() {
    if (capturing || activeTabId == null) return;
    capturing = true;
    app.lastError = null;
    try {
      // Take element selection / drawing modes off the page so the screenshot
      // doesn't include the active toolbar/highlight.
      try {
        await chrome.tabs.sendMessage(activeTabId, {
          type: "mode.set",
          mode: "idle",
        });
      } catch {
        // content script may not be present (e.g. chrome:// page); fail soft
      }
      activeTool = null;

      if (!includeScreenshot) {
        // Text-only mode — let the agent work from selector + outerHTML
        // + nearbyText alone. Cheaper and faster.
        app.submit("", autoApplyEnabled);
        return;
      }

      const resp = (await chrome.runtime.sendMessage({
        type: "capture.full-page",
        tabId: activeTabId,
      })) as { ok: boolean; capture?: { dataUrl: string }; error?: string };

      if (!resp?.ok || !resp.capture) {
        throw new Error(resp?.error ?? "capture failed");
      }

      const composited = await compositeAnnotations(
        resp.capture.dataUrl,
        annotations,
      );
      app.submit(composited, autoApplyEnabled);
    } catch (err) {
      app.lastError = `screenshot failed: ${(err as Error).message}`;
    } finally {
      capturing = false;
    }
  }
</script>

<div class="flex flex-col h-full">
  <header
    class="px-4 py-3 border-b border-ink-200 bg-white dark:border-night-line dark:bg-night-card flex items-center justify-between"
  >
    <div class="flex items-center gap-2 min-w-0">
      <img src="/icons/icon-32.png" alt="" width="24" height="24" />
      <div class="min-w-0">
        <h1 class="font-semibold text-sm dark:text-night-text">Pinta</h1>
        <p
          class="text-xs text-ink-500 dark:text-night-dim truncate max-w-[200px]"
          title={pageUrl}
        >
          {pageUrl || "no active page"}
        </p>
      </div>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <button
        type="button"
        class="w-7 h-7 inline-flex items-center justify-center rounded-full border border-ink-200 bg-white text-ink-600 hover:text-brand-pink hover:border-ink-400 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:text-brand-pink-light dark:hover:border-night-line2 transition-colors"
        onclick={toggleTheme}
        aria-label={theme.value === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        title={theme.value === "dark" ? "Light mode" : "Dark mode"}
      >
        {#if theme.value === "dark"}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
        {:else}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        {/if}
      </button>
      <StatusPill status={app.connectionStatus} />
    </div>
  </header>

  <main class="flex-1 overflow-y-auto p-4 space-y-4">
    <section class="space-y-2">
      <h2 class="text-xs uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
        Tool
      </h2>
      <div class="grid grid-cols-5 gap-1">
        {#each TOOLS as t (t.id)}
          <button
            type="button"
            class={[
              "rounded-md border py-2 text-sm flex flex-col items-center gap-0.5 disabled:opacity-50 transition-colors",
              activeTool === t.id
                ? "bg-brand-pink text-white border-brand-pink shadow-inner ring-2 ring-brand-pink/30 dark:ring-brand-pink/50"
                : "bg-white text-ink-700 border-ink-300 hover:bg-brand-cream hover:border-brand-pink/40 dark:bg-night-card dark:text-night-text dark:border-night-line dark:hover:bg-night-line dark:hover:border-night-line2",
            ].join(" ")}
            disabled={activeTabId == null}
            onclick={() => setActive(activeTool === t.id ? null : t.id)}
            title={t.label}
            aria-pressed={activeTool === t.id}
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
              aria-hidden="true">{@html t.svg}</svg>
            <span class="text-[10px]">{t.label}</span>
          </button>
        {/each}
      </div>
      {#if activeTool}
        <p class="text-[11px] text-ink-500 dark:text-night-dim">
          {#if activeTool === "select"}
            Hover the page → click an element → type a comment.
          {:else}
            Drag on the page to draw → type a comment.
          {/if}
          Press Esc to cancel.
        </p>
      {/if}
    </section>

    <details class="rounded-md border border-ink-200 bg-white dark:border-night-line dark:bg-night-card">
      <summary class="px-3 py-2 text-xs text-ink-600 dark:text-night-dim cursor-pointer">
        Add by CSS selector instead
      </summary>
      <div class="p-3 pt-0 space-y-2">
        <input
          type="text"
          placeholder="CSS selector (e.g. .submit-btn)"
          class="w-full rounded-md border border-ink-300 bg-white text-ink-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink dark:border-night-line dark:bg-night-alt dark:text-night-text dark:placeholder-night-mute"
          bind:value={selector}
        />
        <textarea
          placeholder="What do you want changed?"
          rows={3}
          class="w-full rounded-md border border-ink-300 bg-white text-ink-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink dark:border-night-line dark:bg-night-alt dark:text-night-text dark:placeholder-night-mute"
          bind:value={comment}
        ></textarea>
        <button
          type="button"
          class="w-full rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50"
          disabled={!selector.trim() || !comment.trim()}
          onclick={addAnnotationFromForm}
        >
          Add annotation
        </button>
      </div>
    </details>

    <section class="space-y-2">
      <div class="flex items-center justify-between">
        <h2 class="text-xs uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
          Annotations ({annotations.length})
        </h2>
      </div>
      {#if annotations.length === 0}
        <p class="text-xs text-ink-500 dark:text-night-dim italic">
          No annotations yet. Pick a tool above.
        </p>
      {:else}
        <ul class="space-y-2">
          {#each annotations as annotation (annotation.id)}
            <AnnotationCard
              {annotation}
              canEdit={canEditAnnotations}
              onremove={() => removeAnnotation(annotation.id)}
              onsave={(comment) =>
                app.updateAnnotation(annotation.id, { comment })}
            />
          {/each}
        </ul>
      {/if}
    </section>

    {#if app.lastError}
      <p
        class="text-xs text-red-600 border border-red-200 bg-red-50 dark:text-red-300 dark:border-red-900/40 dark:bg-red-950/40 rounded-md p-2"
      >
        {app.lastError}
      </p>
    {/if}

    <SessionHistory />
  </main>

  <footer class="border-t border-ink-200 p-3 bg-white dark:border-night-line dark:bg-night-card space-y-2">
    {#if !allDone && app.session?.status === "drafting"}
      <label
        class="flex items-start gap-2 text-[12px] text-ink-700 dark:text-night-dim cursor-pointer select-none"
      >
        <input
          type="checkbox"
          class="mt-0.5 accent-brand-pink"
          bind:checked={autoApplyEnabled}
        />
        <span class="flex-1 leading-snug">
          Auto-apply (no agent confirmation)
          <span class="block text-[11px] text-ink-500 dark:text-night-mute">
            Skip the agent's "reply 'go' to apply" step. Plan is still shown
            briefly. Off by default — turn on for fast iteration.
          </span>
        </span>
      </label>
      <label
        class="flex items-start gap-2 text-[12px] text-ink-700 dark:text-night-dim select-none"
        class:cursor-pointer={!hasDrawingAnnotation}
        class:cursor-not-allowed={hasDrawingAnnotation}
      >
        <input
          type="checkbox"
          class="mt-0.5 accent-brand-pink"
          bind:checked={includeScreenshot}
          disabled={hasDrawingAnnotation}
        />
        <span class="flex-1 leading-snug">
          Include full-page screenshot
          {#if hasDrawingAnnotation}
            <span class="text-brand-pink dark:text-brand-pink-light font-medium">(required)</span>
          {/if}
          <span class="block text-[11px] text-ink-500 dark:text-night-mute">
            {#if hasDrawingAnnotation}
              A drawing is in this batch — the agent has no DOM target for
              freehand / arrow / circle / rect / pin annotations, so the
              screenshot is the only context it has.
            {:else}
              Adds visual context for the agent. ~1.5–2k extra vision tokens
              per submit. Off by default — selectors + nearby text are usually
              enough.
            {/if}
          </span>
        </span>
      </label>
    {/if}

    <div class="flex gap-2">
      {#if allDone}
        <button
          type="button"
          class="flex-1 rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta dark:hover:bg-brand-pink-light"
          onclick={cancelSession}
        >
          {#if app.session?.status === "error"}
            Start new batch (some failed)
          {:else}
            ✓ Done — start new batch
          {/if}
        </button>
        <button
          type="button"
          class="rounded-md border border-ink-300 dark:border-night-line bg-white dark:bg-night-card text-ink-700 dark:text-night-text text-sm font-medium px-3 hover:bg-ink-50 dark:hover:bg-night-line disabled:opacity-50"
          title={hmrDetected
            ? "HMR detected — page should already be updated. Click to reload anyway."
            : "Reload the page to see the changes"}
          onclick={reloadActiveTab}
          disabled={reloadingAt !== null || activeTabId == null}
          aria-label="Reload page"
        >
          {reloadingAt ? "↻…" : "↻"}
        </button>
      {:else}
        <button
          type="button"
          class="flex-1 rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50"
          disabled={!canSubmit || capturing}
          onclick={submit}
        >
          {#if capturing}
            Capturing screenshot…
          {:else if app.session?.status === "submitted"}
            Submitted — waiting for agent
          {:else if app.session?.status === "applying"}
            Agent is applying changes…
          {:else}
            Send to agent
          {/if}
        </button>
        {#if app.session?.status === "drafting" && annotations.length > 0}
          <button
            type="button"
            class="rounded-md border border-ink-300 bg-white text-ink-700 text-sm font-medium px-3 hover:bg-ink-50 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:bg-night-line dark:hover:text-night-text"
            title="Copy annotations as markdown — paste into claude.ai web, ChatGPT, or another agent"
            onclick={copyToClipboard}
            aria-label="Copy to clipboard"
          >
            {copiedAt ? "✓" : "Copy"}
          </button>
        {/if}
        {#if app.session?.status === "submitted" || app.session?.status === "applying"}
          <button
            type="button"
            class="rounded-md border border-ink-300 bg-white text-ink-700 text-sm font-medium px-3 hover:bg-ink-50 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:bg-night-line dark:hover:text-night-text"
            title="Cancel this session and start fresh"
            onclick={cancelSession}
            aria-label="Cancel session"
          >
            ✕
          </button>
        {/if}
      {/if}
    </div>
    {#if app.session?.status === "submitted"}
      <p class="text-[11px] text-ink-500 dark:text-night-mute text-center">
        Stuck? Click ✕ to cancel and start a new session.
      </p>
    {:else if app.session?.status === "applying"}
      <p class="text-[11px] text-ink-500 dark:text-night-mute text-center">
        Watch the cards above — each annotation flips to ✓ as the agent finishes it.
      </p>
    {:else if allDone}
      <div class="flex items-center justify-between gap-2">
        <label class="flex items-center gap-1.5 text-[11px] text-ink-600 dark:text-night-dim cursor-pointer select-none">
          <input
            type="checkbox"
            class="accent-brand-pink"
            bind:checked={autoReloadEnabled}
          />
          Auto-reload when not using HMR
        </label>
        {#if hmrDetected === true}
          <span class="text-[11px] text-emerald-600 dark:text-emerald-400">HMR detected ✓</span>
        {:else if hmrDetected === false}
          <span class="text-[11px] text-ink-500 dark:text-night-mute">No HMR detected</span>
        {/if}
      </div>
    {/if}
  </footer>
</div>
