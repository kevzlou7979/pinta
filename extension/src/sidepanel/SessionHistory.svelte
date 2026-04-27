<script lang="ts">
  import { onMount } from "svelte";
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
  }

  onMount(refresh);

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
</script>

<details class="rounded-md border border-ink-200 bg-white dark:border-night-line dark:bg-night-card">
  <summary class="px-3 py-2 text-xs text-ink-600 dark:text-night-dim cursor-pointer flex justify-between items-center">
    <span>History ({summaries.length})</span>
    {#if loading}
      <span class="text-[10px] text-ink-400 dark:text-night-mute">…</span>
    {/if}
  </summary>
  <div class="p-2 pt-0 space-y-1.5 max-h-72 overflow-y-auto">
    {#if error}
      <p class="text-[11px] text-red-600 dark:text-red-300 px-1">{error}</p>
    {:else if summaries.length === 0}
      <p class="text-[11px] text-ink-500 dark:text-night-mute italic px-1">No sessions yet.</p>
    {:else}
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
</details>
