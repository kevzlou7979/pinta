<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { Annotation, AnnotationTarget } from "@pinta/shared";
  import { app } from "../lib/state.svelte.js";
  import { uid } from "../lib/id.js";
  import { compositeAnnotations } from "../lib/composite.js";
  import { formatSessionAsClipboard } from "../lib/format-clipboard.js";
  import StatusPill from "./StatusPill.svelte";
  import AnnotationCard from "./AnnotationCard.svelte";
  import SessionHistory from "./SessionHistory.svelte";

  type Tool = "select" | "arrow" | "rect" | "circle" | "freehand" | "pin";
  type ActiveMode = "idle" | "select" | "draw";

  const TOOLS: { id: Tool; label: string; icon: string }[] = [
    { id: "select", label: "Select", icon: "▢" },
    { id: "arrow", label: "Arrow", icon: "↘" },
    { id: "rect", label: "Rect", icon: "▭" },
    { id: "circle", label: "Circle", icon: "◯" },
    { id: "freehand", label: "Pen", icon: "✎" },
    { id: "pin", label: "Pin", icon: "●" },
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

  type IncomingMsg = {
    type?: string;
    target?: AnnotationTarget;
    comment?: string;
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
          id: uid("ann"),
          createdAt: Date.now(),
          kind: "select",
          strokes: [],
          color: "#FF3D6E",
          comment: (m.comment ?? "").trim(),
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
  }

  async function cancelSession() {
    if (!app.session) return;
    await app.cancelAndRestart(pageUrl || app.session.url);
    activeTool = null;
  }

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
        app.submit();
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
      app.submit(composited);
    } catch (err) {
      app.lastError = `screenshot failed: ${(err as Error).message}`;
    } finally {
      capturing = false;
    }
  }
</script>

<div class="flex flex-col h-full">
  <header
    class="px-4 py-3 border-b border-ink-200 bg-white flex items-center justify-between"
  >
    <div class="flex items-center gap-2 min-w-0">
      <img src="/icons/icon-32.png" alt="" width="24" height="24" />
      <div class="min-w-0">
        <h1 class="font-semibold text-sm">Pinta</h1>
        <p class="text-xs text-ink-500 truncate max-w-[200px]" title={pageUrl}>
          {pageUrl || "no active page"}
        </p>
      </div>
    </div>
    <StatusPill status={app.connectionStatus} />
  </header>

  <main class="flex-1 overflow-y-auto p-4 space-y-4">
    <section class="space-y-2">
      <h2 class="text-xs uppercase tracking-wide text-ink-500 font-medium">
        Tool
      </h2>
      <div class="grid grid-cols-6 gap-1">
        {#each TOOLS as t (t.id)}
          <button
            type="button"
            class="rounded-md border border-ink-300 bg-white py-2 text-sm flex flex-col items-center gap-0.5 hover:bg-brand-cream disabled:opacity-50"
            class:bg-brand-pink={activeTool === t.id}
            class:text-white={activeTool === t.id}
            class:border-brand-pink={activeTool === t.id}
            disabled={activeTabId == null}
            onclick={() => setActive(activeTool === t.id ? null : t.id)}
            title={t.label}
          >
            <span class="text-base leading-none">{t.icon}</span>
            <span class="text-[10px]">{t.label}</span>
          </button>
        {/each}
      </div>
      {#if activeTool}
        <p class="text-[11px] text-ink-500">
          {#if activeTool === "select"}
            Hover the page → click an element → type a comment.
          {:else}
            Drag on the page to draw → type a comment.
          {/if}
          Press Esc to cancel.
        </p>
      {/if}
    </section>

    <details class="rounded-md border border-ink-200 bg-white">
      <summary class="px-3 py-2 text-xs text-ink-600 cursor-pointer">
        Add by CSS selector instead
      </summary>
      <div class="p-3 pt-0 space-y-2">
        <input
          type="text"
          placeholder="CSS selector (e.g. .submit-btn)"
          class="w-full rounded-md border border-ink-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
          bind:value={selector}
        />
        <textarea
          placeholder="What do you want changed?"
          rows={3}
          class="w-full rounded-md border border-ink-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ink-900"
          bind:value={comment}
        ></textarea>
        <button
          type="button"
          class="w-full rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta disabled:opacity-50"
          disabled={!selector.trim() || !comment.trim()}
          onclick={addAnnotationFromForm}
        >
          Add annotation
        </button>
      </div>
    </details>

    <section class="space-y-2">
      <div class="flex items-center justify-between">
        <h2 class="text-xs uppercase tracking-wide text-ink-500 font-medium">
          Annotations ({annotations.length})
        </h2>
      </div>
      {#if annotations.length === 0}
        <p class="text-xs text-ink-500 italic">
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
        class="text-xs text-red-600 border border-red-200 bg-red-50 rounded-md p-2"
      >
        {app.lastError}
      </p>
    {/if}

    <SessionHistory />
  </main>

  <footer class="border-t border-ink-200 p-3 bg-white space-y-2">
    {#if !allDone && app.session?.status === "drafting"}
      <label
        class="flex items-start gap-2 text-[12px] text-ink-700 select-none"
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
            <span class="text-brand-pink font-medium">(required)</span>
          {/if}
          <span class="block text-[11px] text-ink-500">
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
          class="flex-1 rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta"
          onclick={cancelSession}
        >
          {#if app.session?.status === "error"}
            Start new batch (some failed)
          {:else}
            ✓ Done — start new batch
          {/if}
        </button>
      {:else}
        <button
          type="button"
          class="flex-1 rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta disabled:opacity-50"
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
            class="rounded-md border border-ink-300 bg-white text-ink-700 text-sm font-medium px-3 hover:bg-ink-50"
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
            class="rounded-md border border-ink-300 bg-white text-ink-700 text-sm font-medium px-3 hover:bg-ink-50"
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
      <p class="text-[11px] text-ink-500 text-center">
        Stuck? Click ✕ to cancel and start a new session.
      </p>
    {:else if app.session?.status === "applying"}
      <p class="text-[11px] text-ink-500 text-center">
        Watch the cards above — each annotation flips to ✓ as the agent finishes it.
      </p>
    {/if}
  </footer>
</div>
