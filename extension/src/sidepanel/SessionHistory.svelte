<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { app } from "../lib/state.svelte.js";

  type Summary = {
    id: string;
    url: string;
    status: string;
    startedAt: number;
    submittedAt?: number;
    annotationCount: number;
    appliedSummary?: string;
    errorMessage?: string;
    fullPageScreenshotPath?: string;
  };

  let summaries = $state<Summary[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let open = $state(false);
  let rootEl: HTMLDivElement | undefined = $state();

  async function refresh() {
    loading = true;
    try {
      const res = await fetch("http://127.0.0.1:7878/v1/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      summaries = (await res.json()) as Summary[];
      error = null;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
    // Imported sessions live in IndexedDB, not the companion — refresh
    // them in parallel so a single ↻ click syncs both lists.
    void app.refreshImported();
  }

  function viewImported(id: string) {
    open = false;
    app.viewImported(id);
  }
  async function forkImported(id: string) {
    open = false;
    const result = await app.forkImportedToLocal(id);
    if (result === "would-overwrite") {
      const ok = confirm(
        "Forking will replace your current draft annotations on this URL. " +
          "Continue and lose the current draft?",
      );
      if (!ok) return;
      await app.forkImportedToLocal(id, { allowOverwrite: true });
    }
  }
  async function removeImported(id: string) {
    if (!confirm("Remove this imported session?")) return;
    await app.removeImported(id);
  }

  onMount(() => {
    refresh();
    const onDocClick = (ev: MouseEvent) => {
      if (!open || !rootEl) return;
      if (!rootEl.contains(ev.target as Node)) open = false;
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && open) open = false;
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  });

  // Refetch whenever the active session id or status changes (something
  // moved in the store — likely worth re-listing).
  let sigKey = $derived(`${app.session?.id ?? ""}|${app.session?.status ?? ""}`);
  $effect(() => {
    void sigKey;
    refresh();
  });

  function statusBadge(s: string): { dot: string; label: string } {
    switch (s) {
      case "done":
        return { dot: "bg-emerald-600", label: "Done" };
      case "error":
        return { dot: "bg-red-600", label: "Error" };
      case "applying":
        return { dot: "bg-brand-pink animate-pulse", label: "Applying" };
      case "submitted":
        return { dot: "bg-amber-500", label: "Submitted" };
      case "drafting":
        return { dot: "bg-ink-300", label: "Drafting" };
      default:
        return { dot: "bg-ink-300", label: s };
    }
  }

  function relTime(ms?: number): string {
    if (!ms) return "";
    const seconds = Math.floor((Date.now() - ms) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86_400)}d ago`;
  }

  function shortUrl(u: string): string {
    try {
      const url = new URL(u);
      const path = url.pathname + url.search;
      return path.length > 28 ? path.slice(0, 27) + "…" : path;
    } catch {
      return u.length > 28 ? u.slice(0, 27) + "…" : u;
    }
  }

  function toggle() {
    open = !open;
    if (open) refresh();
  }
</script>

<div class="relative" bind:this={rootEl}>
  <button
    type="button"
    class="inline-flex items-center gap-1 rounded-full border border-ink-200 bg-white text-ink-600 hover:text-brand-pink hover:border-ink-400 dark:border-night-line dark:bg-night-alt dark:text-night-dim dark:hover:text-brand-pink-light dark:hover:border-night-line2 text-[11px] font-medium h-7 px-2.5 transition-colors"
    onclick={toggle}
    aria-haspopup="dialog"
    aria-expanded={open}
    title="Session history"
  >
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>
    <span>History</span>
    {#if summaries.length + app.importedSessions.length > 0}
      <span class="text-ink-500 dark:text-night-mute">({summaries.length + app.importedSessions.length})</span>
    {/if}
    {#if loading}
      <span class="text-[10px] text-ink-400 dark:text-night-mute">…</span>
    {/if}
  </button>

  {#if open}
    <div
      class="absolute right-0 top-full mt-1 w-[320px] z-30 rounded-md border border-ink-300 bg-white shadow-lg dark:border-night-line dark:bg-night-alt"
      role="dialog"
    >
      <div class="px-3 py-2 border-b border-ink-200 dark:border-night-line flex items-center justify-between">
        <span class="text-xs font-medium text-ink-700 dark:text-night-text">Session history</span>
        <button
          type="button"
          class="text-[11px] text-ink-500 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light disabled:opacity-50"
          onclick={refresh}
          disabled={loading}
        >
          {loading ? "…" : "↻ Refresh"}
        </button>
      </div>
      <div class="p-2 space-y-1.5 max-h-72 overflow-y-auto">
        {#if app.importedSessions.length > 0}
          <div class="space-y-1.5">
            <div class="text-[10px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-semibold px-1">
              Imported ({app.importedSessions.length})
            </div>
            {#each app.importedSessions as imp (imp.id)}
              <div class="rounded border border-ink-200 px-2.5 py-1.5 text-[12px] dark:border-night-line">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1.5 min-w-0 flex-1">
                    <span
                      class="w-2 h-2 rounded-full shrink-0"
                      style="background-color: {imp.manifest.accentColor};"
                    ></span>
                    <span class="text-ink-700 dark:text-night-text font-medium truncate" title={imp.manifest.title}>
                      {imp.manifest.title}
                    </span>
                  </div>
                  <span class="text-[10px] text-ink-400 dark:text-night-mute shrink-0">
                    {relTime(imp.importedAt)}
                  </span>
                </div>
                <div class="mt-0.5 flex items-center gap-1">
                  <span
                    class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-white text-[10px] font-medium"
                    style="background-color: {imp.manifest.accentColor};"
                  >
                    Imported · {imp.manifest.author}
                  </span>
                  <span class="text-[10px] text-ink-500 dark:text-night-mute">
                    {imp.session.annotations.length} annotation{imp.session.annotations.length === 1 ? "" : "s"}
                  </span>
                </div>
                {#if imp.manifest.description}
                  <div class="mt-0.5 text-[11px] text-ink-600 dark:text-night-dim leading-tight italic">
                    "{imp.manifest.description}"
                  </div>
                {/if}
                <div class="mt-1 flex gap-1">
                  <button
                    type="button"
                    class="text-[10px] px-1.5 py-0.5 rounded border border-ink-300 text-ink-700 hover:bg-ink-50 dark:border-night-line dark:text-night-dim dark:hover:bg-night-alt"
                    onclick={() => viewImported(imp.id)}
                  >
                    View
                  </button>
                  <button
                    type="button"
                    class="text-[10px] px-1.5 py-0.5 rounded border border-ink-300 text-ink-700 hover:bg-ink-50 dark:border-night-line dark:text-night-dim dark:hover:bg-night-alt disabled:opacity-50"
                    disabled={app.appMode !== "standalone"}
                    title={app.appMode === "standalone" ? "Clone into a fresh editable session" : "Forking is only available in standalone mode"}
                    onclick={() => forkImported(imp.id)}
                  >
                    Fork
                  </button>
                  <button
                    type="button"
                    class="ml-auto text-[10px] px-1.5 py-0.5 rounded text-ink-500 hover:text-red-600 dark:text-night-mute dark:hover:text-red-400"
                    onclick={() => removeImported(imp.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            {/each}
          </div>
          {#if summaries.length > 0}
            <div class="border-t border-ink-200 dark:border-night-line my-1"></div>
            <div class="text-[10px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-semibold px-1">
              Local sessions
            </div>
          {/if}
        {/if}
        {#if error && app.importedSessions.length === 0}
          <p class="text-[11px] text-red-600 dark:text-red-300 px-1">{error}</p>
        {:else if summaries.length === 0 && app.importedSessions.length === 0}
          <p class="text-[11px] text-ink-500 dark:text-night-mute italic px-1">No sessions yet.</p>
        {:else if summaries.length > 0}
          {#each summaries as s (s.id)}
            {@const badge = statusBadge(s.status)}
            <div
              class="rounded border border-ink-200 px-2.5 py-1.5 text-[12px] hover:bg-ink-50 dark:border-night-line dark:hover:bg-night-alt"
              class:ring-1={s.id === app.session?.id}
              class:ring-brand-pink={s.id === app.session?.id}
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="w-2 h-2 rounded-full shrink-0 {badge.dot}"></span>
                  <span class="text-ink-700 dark:text-night-text font-medium">{badge.label}</span>
                  <span class="text-ink-400 dark:text-night-mute truncate font-mono text-[11px]">
                    {shortUrl(s.url)}
                  </span>
                </div>
                <span class="text-[10px] text-ink-400 dark:text-night-mute shrink-0">
                  {relTime(s.submittedAt ?? s.startedAt)}
                </span>
              </div>
              {#if s.annotationCount > 0 || s.appliedSummary || s.errorMessage}
                <div class="mt-0.5 text-[11px] text-ink-600 dark:text-night-dim leading-tight">
                  {#if s.appliedSummary}
                    {s.appliedSummary}
                  {:else if s.errorMessage}
                    <span class="text-red-600 dark:text-red-300">{s.errorMessage}</span>
                  {:else}
                    {s.annotationCount} annotation{s.annotationCount === 1 ? "" : "s"}
                  {/if}
                </div>
              {/if}
              {#if s.fullPageScreenshotPath}
                <div class="text-[10px] text-ink-400 dark:text-night-mute mt-0.5 font-mono truncate">
                  {s.fullPageScreenshotPath}
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>
