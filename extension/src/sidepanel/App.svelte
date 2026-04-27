<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { Annotation, AnnotationTarget } from "@pinta/shared";
  import { app } from "../lib/state.svelte.js";
  import { uid } from "../lib/id.js";
  import StatusPill from "./StatusPill.svelte";
  import AnnotationCard from "./AnnotationCard.svelte";

  let pageUrl = $state<string>("");
  let activeTabId = $state<number | null>(null);
  let selecting = $state(false);
  let selector = $state("");
  let comment = $state("");

  type IncomingMsg = {
    type?: string;
    target?: AnnotationTarget;
    comment?: string;
    viewport?: { scrollY: number; width: number; height: number };
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
          color: "#ef4444",
          comment: (m.comment ?? "").trim(),
          target: m.target,
          viewport: m.viewport ?? {
            scrollY: 0,
            width: window.innerWidth,
            height: window.innerHeight,
          },
        };
        app.addAnnotation(annotation);
        selecting = false;
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

  async function toggleSelect() {
    if (activeTabId == null) return;
    const next = !selecting;
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: "select-mode.set",
        active: next,
      });
      selecting = next;
    } catch (err) {
      app.lastError = `couldn't reach page: ${(err as Error).message}`;
    }
  }

  function addAnnotationFromForm() {
    if (!selector.trim() || !comment.trim()) return;
    const annotation: Annotation = {
      id: uid("ann"),
      createdAt: Date.now(),
      kind: "select",
      strokes: [],
      color: "#ef4444",
      comment: comment.trim(),
      viewport: {
        scrollY: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      },
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

  function submit() {
    app.submit();
  }
</script>

<div class="flex flex-col h-full">
  <header
    class="px-4 py-3 border-b border-ink-200 bg-white flex items-center justify-between"
  >
    <div>
      <h1 class="font-semibold text-sm">Pinta</h1>
      <p class="text-xs text-ink-500 truncate max-w-[200px]" title={pageUrl}>
        {pageUrl || "no active page"}
      </p>
    </div>
    <StatusPill status={app.connectionStatus} />
  </header>

  <main class="flex-1 overflow-y-auto p-4 space-y-4">
    <section class="space-y-2">
      <h2 class="text-xs uppercase tracking-wide text-ink-500 font-medium">
        Pick an element
      </h2>
      <button
        type="button"
        class="w-full rounded-md border border-ink-300 bg-white text-sm font-medium py-2 hover:bg-ink-50 disabled:opacity-50"
        class:bg-ink-900={selecting}
        class:text-white={selecting}
        class:border-ink-900={selecting}
        disabled={activeTabId == null}
        onclick={toggleSelect}
      >
        {selecting ? "Selecting… (Esc to cancel)" : "Select element on page"}
      </button>
      <p class="text-[11px] text-ink-500">
        Hover the page → click an element → type a comment in the popup.
      </p>
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
          class="w-full rounded-md bg-ink-900 text-white text-sm font-medium py-2 hover:bg-ink-800 disabled:opacity-50"
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
          No annotations yet. Pick one above.
        </p>
      {:else}
        <ul class="space-y-2">
          {#each annotations as annotation (annotation.id)}
            <AnnotationCard
              {annotation}
              onremove={() => removeAnnotation(annotation.id)}
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
  </main>

  <footer class="border-t border-ink-200 p-3 bg-white">
    <button
      type="button"
      class="w-full rounded-md bg-emerald-600 text-white text-sm font-medium py-2 hover:bg-emerald-700 disabled:opacity-50"
      disabled={!canSubmit}
      onclick={submit}
    >
      {#if app.session?.status === "submitted"}
        Submitted — waiting for agent
      {:else if app.session?.status === "applying"}
        Agent is applying changes…
      {:else if app.session?.status === "done"}
        Done · {app.session?.appliedSummary ?? "applied"}
      {:else}
        Send to agent
      {/if}
    </button>
  </footer>
</div>
