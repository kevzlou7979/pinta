<script lang="ts">
  // Phase 14 — shared bottom-sheet chat surface. One component, three
  // surfaces (Test Pilot per-row, global header icon, Annotate "Just
  // Ask"). Parent owns the open-state + messages + onSend wiring; this
  // component renders the sheet animation, backdrop, header chip,
  // message list (with parseStep + Prism for agent replies), and
  // input bar with Cmd/Ctrl+Enter send.
  //
  // Companion-connection check reads from `app` directly since the
  // sheet is side-panel-specific anyway — keeping it as a prop would
  // just push the same dependency one layer up without buying
  // anything.

  import { app, type ChatMessage } from "../lib/state.svelte.js";
  import { parseStep } from "../lib/step-md.js";
  import { highlight } from "../lib/prism-setup.js";

  type Props = {
    open: boolean;
    /** Eyebrow text above the context chip — e.g. "Talking about" or
     *  "Quick ask · no context attached". */
    contextHeader: string;
    /** Primary context line — e.g. "AUTH-01" or "Pinta v0.3.2 · standalone". */
    contextLabel: string;
    /** Optional muted secondary line — e.g. "1.1 Authentication". */
    contextSubLabel?: string;
    messages: ChatMessage[];
    pending: boolean;
    error: string | null;
    placeholder?: string;
    /** Hint shown in the empty state above the input — replaces the
     *  default "Ask anything..." prompt with surface-specific copy. */
    emptyHint?: string;
    onClose: () => void;
    onSend: (prompt: string) => void;
  };

  let {
    open,
    contextHeader,
    contextLabel,
    contextSubLabel = "",
    messages,
    pending,
    error,
    placeholder = "Ask the agent…",
    emptyHint = "",
    onClose,
    onSend,
  }: Props = $props();

  let draft = $state("");
  let scrollEl = $state<HTMLDivElement | null>(null);

  // Auto-scroll to the most recent bubble on every message-list change
  // so the user always sees the latest reply land. Mounted only while
  // `open` so closed sheets don't pay the effect cost.
  $effect(() => {
    if (!open) return;
    // Touching .length is enough to re-run when messages append.
    void messages.length;
    void pending;
    if (scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  });

  function handleSend() {
    const text = draft.trim();
    if (!text || pending || app.connectionStatus !== "connected") return;
    draft = "";
    onSend(text);
  }

  function onKeyDown(e: KeyboardEvent) {
    // Cmd/Ctrl+Enter sends; bare Enter inserts a newline so testers
    // can write multi-line questions without accidentally sending.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleClose() {
    draft = "";
    onClose();
  }
</script>

{#if open}
  <!-- Backdrop -->
  <button
    type="button"
    class="fixed inset-0 z-40 bg-black/30 dark:bg-black/50"
    onclick={handleClose}
    aria-label="Close chat"
  ></button>

  <!-- Sheet panel -->
  <div
    class="fixed left-0 right-0 bottom-0 z-50 bg-white dark:bg-night-card border-t border-ink-200 dark:border-night-line rounded-t-xl shadow-2xl flex flex-col"
    style="height: 70vh; max-height: 600px; animation: pinta-sheet-slide-up 250ms ease-out;"
    role="dialog"
    aria-label="Chat with agent"
  >
    <!-- Sheet header -->
    <div class="shrink-0 border-b border-ink-200 dark:border-night-line">
      <div class="pt-2 pb-1 flex justify-center">
        <div class="w-8 h-1 rounded-full bg-ink-300 dark:bg-night-line"></div>
      </div>
      <div class="px-4 pb-3 flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-[10px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute">
            {contextHeader}
          </div>
          <div class="text-[12px] text-ink-800 dark:text-night-text leading-snug truncate">
            <span class="font-mono font-bold">{contextLabel}</span>
            {#if contextSubLabel}
              <span class="text-ink-400 dark:text-night-mute"> · </span>
              <span class="text-ink-600 dark:text-night-dim">{contextSubLabel}</span>
            {/if}
          </div>
        </div>
        <button
          type="button"
          class="shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full text-ink-500 dark:text-night-mute hover:text-ink-900 dark:hover:text-night-text hover:bg-ink-100 dark:hover:bg-night-alt"
          onclick={handleClose}
          aria-label="Close chat"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <!-- Message list -->
    <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3" bind:this={scrollEl}>
      {#if messages.length === 0}
        <p class="text-[12px] text-ink-500 dark:text-night-mute italic leading-snug">
          {emptyHint || "Ask the agent anything. Inline `code`, fenced blocks, and `> Note:` callouts all render in replies."}
        </p>
      {:else}
        {#each messages as msg (msg.id)}
          {#if msg.role === "user"}
            <div class="flex justify-end">
              <div class="max-w-[85%] rounded-lg rounded-br-sm bg-brand-pink text-white text-[12.5px] leading-snug px-3 py-2 whitespace-pre-wrap break-words">
                {msg.text}
              </div>
            </div>
          {:else}
            {@const blocks = parseStep(msg.text)}
            <div class="flex justify-start">
              <div class="max-w-[90%] rounded-lg rounded-bl-sm bg-ink-100 dark:bg-night-alt text-ink-800 dark:text-night-text text-[12.5px] leading-snug px-3 py-2 space-y-2">
                {#each blocks as block, bi (bi)}
                  {#if block.kind === "text"}
                    <p class="leading-relaxed">
                      {#each block.parts as part, pi (pi)}
                        {#if part.kind === "code"}
                          <code class="font-mono text-[11px] bg-white dark:bg-night-card text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                        {:else}
                          <span>{part.value}</span>
                        {/if}
                      {/each}
                    </p>
                  {:else if block.kind === "code"}
                    <div class="rounded-md overflow-hidden border border-ink-200 dark:border-night-line bg-white dark:bg-night-card/60">
                      <div class="px-2.5 py-1 text-[10px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute border-b border-ink-200 dark:border-night-line">
                        {block.lang || "code"}
                      </div>
                      <div class="pinta-code px-2.5 py-1.5 text-[11px] leading-relaxed overflow-x-auto"><pre><code class="font-mono">{@html highlight(block.body, block.lang)}</code></pre></div>
                    </div>
                  {:else if block.kind === "note"}
                    <div class="border-l-2 border-ink-300 dark:border-night-line pl-2.5 py-0.5 text-[11.5px] text-ink-600 dark:text-night-dim leading-relaxed">
                      <span class="font-semibold text-ink-800 dark:text-night-text">Note:</span>
                      {#each block.parts as part, pi (pi)}
                        {#if part.kind === "code"}
                          <code class="font-mono text-[11px] bg-white dark:bg-night-card text-brand-pink dark:text-brand-pink-light px-1.5 py-0.5 rounded">{part.value}</code>
                        {:else}
                          <span>{part.value}</span>
                        {/if}
                      {/each}
                    </div>
                  {/if}
                {/each}
              </div>
            </div>
          {/if}
        {/each}
        {#if pending}
          <div class="flex justify-start">
            <div class="rounded-lg rounded-bl-sm bg-ink-100 dark:bg-night-alt text-ink-600 dark:text-night-mute text-[12px] px-3 py-2 inline-flex items-center gap-2">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
              Agent is thinking…
            </div>
          </div>
        {/if}
      {/if}
      {#if error}
        <div class="rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[11.5px] text-red-700 dark:text-red-300 leading-snug">
          {error}
        </div>
      {/if}
    </div>

    <!-- Input bar -->
    <div class="shrink-0 border-t border-ink-200 dark:border-night-line p-3 bg-white dark:bg-night-card">
      {#if app.connectionStatus !== "connected"}
        <p class="text-[11px] text-red-600 dark:text-red-400 mb-2 leading-snug">
          Companion disconnected. Reconnect to ask the agent.
        </p>
      {/if}
      <div class="flex items-end gap-2">
        <textarea
          rows="2"
          {placeholder}
          class="flex-1 text-[12.5px] text-ink-800 dark:text-night-text bg-white dark:bg-night-card border border-ink-200 dark:border-night-line rounded-md px-2.5 py-1.5 leading-snug resize-none focus:outline-none focus:ring-2 focus:ring-brand-pink/40 placeholder:text-ink-400 dark:placeholder:text-night-mute"
          bind:value={draft}
          onkeydown={onKeyDown}
          disabled={pending}
        ></textarea>
        <button
          type="button"
          class="shrink-0 h-10 px-3 rounded-md bg-brand-pink text-white text-[12.5px] font-semibold hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
          onclick={handleSend}
          disabled={pending || draft.trim() === "" || app.connectionStatus !== "connected"}
          title="Send (Cmd/Ctrl + Enter)"
          aria-label="Send message"
        >
          {#if pending}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
          {:else}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Send
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
