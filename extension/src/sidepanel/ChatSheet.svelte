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

  import { app, type ChatImage, type ChatMessage } from "../lib/state.svelte.js";
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
    /** When true, the textarea accepts pasted images. Currently only
     *  the global chat opts in — other tiers are text-only. Pasted
     *  images get downscaled client-side (max 1280px, JPEG q=0.85,
     *  capped at MAX_IMAGES_PER_MESSAGE per send) and forwarded to
     *  onSend's second argument. */
    imagesEnabled?: boolean;
    /** Optional thread-wipe hook. When provided AND messages.length > 0,
     *  a trash button appears in the header next to Close. Parent decides
     *  the storage path (global → clearGlobalChat, annotate → clearAnnotateChat,
     *  Test Pilot → clearChat) and whether to confirm. */
    onClear?: () => void;
    /** Optional synthetic greeting shown as the first agent bubble when
     *  the thread is empty. Replaces the bare `emptyHint` text with a
     *  proper avatar+bubble layout. Client-side only — does NOT cost a
     *  round trip to the agent. Interpolate context (e.g. row id, author
     *  name) at the call site. */
    greeting?: string;
    /** Optional quick-action pills shown under the greeting in the empty
     *  state. Each pill, when clicked, fires `onSend(prompt)` exactly as
     *  if the user had typed and submitted it. Render only when
     *  `greeting` is also set and the thread is empty. */
    quickPrompts?: { label: string; prompt: string }[];
    onClose: () => void;
    onSend: (prompt: string, images?: ChatImage[]) => void;
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
    imagesEnabled = false,
    onClear,
    greeting = "",
    quickPrompts = [],
    onClose,
    onSend,
  }: Props = $props();

  // Bound the per-message payload so a careless "paste every screenshot
  // in my clipboard buffer" doesn't blow chrome.storage or push the
  // queryComment past the companion's HTTP body cap. 4 covers typical
  // "before / after / spec / hint" use; further pastes drop with a
  // toast-style hint instead of silent truncation.
  const MAX_IMAGES_PER_MESSAGE = 4;
  // Max long-edge in CSS pixels after the downscale. 1280 keeps text
  // in screenshots legible for vision while pinning each image to
  // roughly 100-300 KB JPEG — comfortable budget under the 200-message
  // global cap.
  const MAX_IMAGE_EDGE_PX = 1280;
  // JPEG quality after resize. 0.85 is the sweet spot for screenshot
  // content (text + UI panels) — visually lossless, ~5-10× smaller
  // than PNG of the same content.
  const IMAGE_JPEG_QUALITY = 0.85;

  let draft = $state("");
  let attachedImages = $state<ChatImage[]>([]);
  let pasteHint = $state<string | null>(null);
  let scrollEl = $state<HTMLDivElement | null>(null);

  /** Compact wall-clock formatter for the bubble footer.
   *  Same-day → "HH:MM", older → "MMM D, HH:MM". Uses the browser's
   *  locale so timestamps match the user's regional format. */
  function formatClock(at: number): string {
    const d = new Date(at);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
    }
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  /** Elapsed-time formatter for agent bubbles. Sub-minute → "12s",
   *  sub-hour → "1.4m", otherwise "1h 12m". */
  function formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
    const m = s / 60;
    if (m < 60) return `${m.toFixed(1)}m`;
    const h = Math.floor(m / 60);
    const rem = Math.round(m - h * 60);
    return `${h}h ${rem}m`;
  }

  /** Token-count formatter — short ("256") or thousands ("3.2k"). */
  function formatTokens(n: number): string {
    if (n < 1000) return `${n} tok`;
    return `${(n / 1000).toFixed(1)}k tok`;
  }

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
    // Allow image-only sends — pasting a screenshot then hitting Send
    // is a valid ask ("what is this?"). Block only when neither field
    // has content, or when we're pending / offline.
    if ((!text && attachedImages.length === 0) || pending || app.connectionStatus !== "connected") return;
    const imagesToSend = attachedImages.length > 0 ? [...attachedImages] : undefined;
    draft = "";
    attachedImages = [];
    pasteHint = null;
    onSend(text, imagesToSend);
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
    attachedImages = [];
    pasteHint = null;
    onClose();
  }

  /** Click a quick-action pill — fires its prompt as if the user had
   *  typed it. Pills don't carry images. Skipped when pending / offline
   *  (the button itself is also visually disabled in those states). */
  function handleQuickPrompt(prompt: string) {
    if (pending || app.connectionStatus !== "connected") return;
    onSend(prompt);
  }

  /**
   * Handle a clipboard paste. Only image items are intercepted —
   * regular text paste falls through to the default behavior so
   * Cmd+V on copied text still works.
   *
   * Each pasted image is downscaled to MAX_IMAGE_EDGE_PX on the long
   * edge and re-encoded as JPEG q=0.85. This keeps the per-image
   * footprint small enough that 4 of them comfortably fit in a single
   * queryComment payload AND survive the 200-message global cap in
   * chrome.storage. The downscale also strips EXIF metadata as a
   * side effect — fine for the chat use case.
   */
  async function handlePaste(e: ClipboardEvent) {
    if (!imagesEnabled) return;
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.kind === "file" && it.type.startsWith("image/")) {
        imageItems.push(it);
      }
    }
    if (imageItems.length === 0) return; // pure text paste — let it through
    e.preventDefault();
    pasteHint = null;
    // Process each image; respect the per-message cap. We count both
    // already-attached and newly-pasted toward the limit so a user
    // can't paste twice in a row past the ceiling.
    let remaining = MAX_IMAGES_PER_MESSAGE - attachedImages.length;
    if (remaining <= 0) {
      pasteHint = `Already at ${MAX_IMAGES_PER_MESSAGE} images — remove one to add more.`;
      return;
    }
    const newImages: ChatImage[] = [];
    let dropped = 0;
    for (const item of imageItems) {
      if (remaining <= 0) {
        dropped++;
        continue;
      }
      const file = item.getAsFile();
      if (!file) continue;
      try {
        const downscaled = await downscaleToJpeg(file);
        newImages.push(downscaled);
        remaining--;
      } catch {
        // Bad bitmap — skip silently. Common cause is a non-decodable
        // weird image format (HEIC on older Chrome, etc.).
        dropped++;
      }
    }
    if (newImages.length > 0) {
      attachedImages = [...attachedImages, ...newImages];
    }
    if (dropped > 0) {
      pasteHint = `${dropped} image${dropped === 1 ? "" : "s"} dropped (cap is ${MAX_IMAGES_PER_MESSAGE} per message).`;
    }
  }

  function removeAttachedImage(idx: number) {
    attachedImages = attachedImages.filter((_, i) => i !== idx);
    pasteHint = null;
  }

  /**
   * Resize a File to fit within MAX_IMAGE_EDGE_PX on the long edge
   * and return a JPEG dataUrl. Uses an offscreen <canvas> rather than
   * OffscreenCanvas so it works inside the side-panel context without
   * worker plumbing. Aspect ratio preserved.
   */
  async function downscaleToJpeg(file: File): Promise<ChatImage> {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const longEdge = Math.max(width, height);
    const scale = longEdge > MAX_IMAGE_EDGE_PX ? MAX_IMAGE_EDGE_PX / longEdge : 1;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      throw new Error("no 2d context");
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
    return {
      dataUrl,
      mediaType: "image/jpeg",
      name: file.name || undefined,
    };
  }
</script>

{#if open}
  <!-- Backdrop. `absolute inset-0` clips to the nearest positioned
       ancestor so the overlay stays inside the panel body and doesn't
       cover the App header (logo / project / Connected status).
       App.svelte wraps <main> + <footer> in a `relative` container
       for this. -->
  <button
    type="button"
    class="absolute inset-0 z-40 bg-black/30 dark:bg-black/50"
    onclick={handleClose}
    aria-label="Close chat"
  ></button>

  <!-- Sheet panel. Height is 70% of the *panel body* (not the iframe
       viewport) so it scales with the wrapping container instead of
       overflowing past the App header. -->
  <div
    class="absolute left-0 right-0 bottom-0 z-50 bg-white dark:bg-night-card border-t border-ink-200 dark:border-night-line rounded-t-xl shadow-2xl flex flex-col"
    style="height: 70%; max-height: 600px; animation: pinta-sheet-slide-up 250ms ease-out;"
    role="dialog"
    aria-label="Chat with agent"
  >
    <!-- Sheet header — avatar + AI assistant title + context status row.
         Matches the v0.4 chat-redesign mock: square gradient avatar with
         sparkle glyph on the left, "AI assistant" in bold, then a green
         dot + the context-label row underneath. Drag-handle stays at top
         for the mobile-style affordance. -->
    <div class="shrink-0 border-b border-ink-200 dark:border-night-line">
      <div class="pt-2 pb-1 flex justify-center">
        <div class="w-8 h-1 rounded-full bg-ink-300 dark:bg-night-line"></div>
      </div>
      <div class="px-4 pb-3 flex items-start gap-3">
        <!-- Avatar — same gradient + sparkle treatment used inline on
             agent messages below. 36x36 here, 28x28 inline. -->
        <div class="shrink-0 w-9 h-9 rounded-lg bg-gradient-to-br from-brand-pink to-purple-500 inline-flex items-center justify-center shadow-sm">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true">
            <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" />
            <path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z" opacity="0.85" />
            <path d="M5 15l.6 1.8L7.4 17.4l-1.8.6L5 19.8l-.6-1.8L2.6 17.4l1.8-.6L5 15z" opacity="0.7" />
          </svg>
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-[14px] font-bold text-ink-900 dark:text-night-text leading-tight">
            AI assistant
          </div>
          <div class="mt-0.5 text-[11.5px] text-ink-600 dark:text-night-dim leading-snug truncate inline-flex items-center gap-1.5">
            <span class="shrink-0 w-1.5 h-1.5 rounded-full {app.connectionStatus === 'connected' ? 'bg-emerald-500' : 'bg-ink-400 dark:bg-night-mute'}"></span>
            <span class="font-mono font-semibold text-ink-800 dark:text-night-text">{contextLabel}</span>
            {#if contextSubLabel}
              <span class="text-ink-400 dark:text-night-mute" aria-hidden="true">·</span>
              <span class="text-ink-600 dark:text-night-dim truncate">{contextSubLabel}</span>
            {/if}
          </div>
        </div>
        <div class="shrink-0 flex items-center gap-1">
          {#if onClear && messages.length > 0}
            <button
              type="button"
              class="w-7 h-7 inline-flex items-center justify-center rounded-full text-ink-500 dark:text-night-mute hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
              onclick={() => onClear?.()}
              aria-label="Clear chat thread"
              title="Clear all messages in this chat"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5L5 6" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
                <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          {/if}
          <button
            type="button"
            class="w-7 h-7 inline-flex items-center justify-center rounded-full text-ink-500 dark:text-night-mute hover:text-ink-900 dark:hover:text-night-text hover:bg-ink-100 dark:hover:bg-night-alt"
            onclick={handleClose}
            aria-label="Close chat"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Message list -->
    <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3" bind:this={scrollEl}>
      {#if messages.length === 0}
        {#if greeting}
          <!-- "TODAY" date separator above the first message. Constant
               for now — real per-day separators are out of scope for v1
               since threads typically live for one session. -->
          <div class="flex items-center gap-3 py-1">
            <div class="flex-1 h-px bg-ink-200 dark:bg-night-line"></div>
            <span class="text-[10px] uppercase tracking-wider font-semibold text-ink-400 dark:text-night-mute">Today</span>
            <div class="flex-1 h-px bg-ink-200 dark:bg-night-line"></div>
          </div>
          <!-- Synthetic agent greeting — no round trip. Same avatar +
               bubble shape as a real agent message so the visual
               vocabulary is consistent the moment a real reply lands. -->
          <div class="flex items-start gap-2">
            <div class="shrink-0 w-7 h-7 rounded-md bg-gradient-to-br from-brand-pink to-purple-500 inline-flex items-center justify-center shadow-sm mt-0.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white" aria-hidden="true">
                <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" />
                <path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z" opacity="0.85" />
                <path d="M5 15l.6 1.8L7.4 17.4l-1.8.6L5 19.8l-.6-1.8L2.6 17.4l1.8-.6L5 15z" opacity="0.7" />
              </svg>
            </div>
            <div class="min-w-0 flex-1 space-y-2">
              <div class="rounded-lg rounded-tl-sm bg-ink-100 dark:bg-night-alt text-ink-800 dark:text-night-text text-[12.5px] leading-snug px-3 py-2">
                {greeting}
              </div>
              {#if quickPrompts.length > 0}
                <!-- Quick-action pills — click fires onSend directly,
                     no typing required. Disabled visually + functionally
                     when pending / offline so the user can't queue while
                     the previous ask is in flight. -->
                <div class="flex flex-wrap gap-1.5">
                  {#each quickPrompts as p (p.prompt)}
                    <button
                      type="button"
                      class="text-[11.5px] text-ink-700 dark:text-night-text bg-white dark:bg-night-card border border-ink-200 dark:border-night-line rounded-full px-3 py-1 hover:border-brand-pink dark:hover:border-brand-pink-light hover:text-brand-pink dark:hover:text-brand-pink-light disabled:opacity-50 transition-colors"
                      onclick={() => handleQuickPrompt(p.prompt)}
                      disabled={pending || app.connectionStatus !== "connected"}
                      title={p.prompt}
                    >
                      {p.label}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {:else}
          <p class="text-[12px] text-ink-500 dark:text-night-mute italic leading-snug">
            {emptyHint || "Ask the agent anything. Inline `code`, fenced blocks, and `> Note:` callouts all render in replies."}
          </p>
        {/if}
      {:else}
        {#each messages as msg (msg.id)}
          {#if msg.role === "user"}
            <div class="flex flex-col items-end space-y-0.5">
              <div class="max-w-[85%] rounded-lg rounded-br-sm bg-brand-pink text-white text-[12.5px] leading-snug px-3 py-2 whitespace-pre-wrap break-words space-y-2">
                {#if msg.text}
                  <div>{msg.text}</div>
                {/if}
                {#if msg.images && msg.images.length > 0}
                  <!-- Thumbnail grid below the text. Sized to fit
                       comfortably in the bubble; click opens the full
                       dataUrl in a new tab for inspection. -->
                  <div class="flex flex-wrap gap-1.5">
                    {#each msg.images as img, i (i)}
                      <a
                        href={img.dataUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="block rounded overflow-hidden border border-white/30 hover:border-white/60 transition-colors"
                        title={img.name || `Image ${i + 1}`}
                      >
                        <img
                          src={img.dataUrl}
                          alt={img.name || `Pasted image ${i + 1}`}
                          class="block max-w-[140px] max-h-[140px] object-cover"
                        />
                      </a>
                    {/each}
                  </div>
                {/if}
              </div>
              <div class="text-[10px] text-ink-400 dark:text-night-mute px-1 tabular-nums" title={new Date(msg.at).toLocaleString()}>
                {formatClock(msg.at)}
              </div>
            </div>
          {:else}
            {@const blocks = parseStep(msg.text)}
            <div class="flex items-start gap-2">
              <!-- Inline avatar to the left of each agent reply.
                   Same gradient sparkle treatment as the header avatar
                   so the visual identity carries through the thread. -->
              <div class="shrink-0 w-7 h-7 rounded-md bg-gradient-to-br from-brand-pink to-purple-500 inline-flex items-center justify-center shadow-sm mt-0.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white" aria-hidden="true">
                  <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" />
                  <path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z" opacity="0.85" />
                  <path d="M5 15l.6 1.8L7.4 17.4l-1.8.6L5 19.8l-.6-1.8L2.6 17.4l1.8-.6L5 15z" opacity="0.7" />
                </svg>
              </div>
              <div class="min-w-0 flex-1 flex flex-col items-start space-y-0.5">
              <div class="max-w-full rounded-lg rounded-tl-sm bg-ink-100 dark:bg-night-alt text-ink-800 dark:text-night-text text-[12.5px] leading-snug px-3 py-2 space-y-2">
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
              <div class="text-[10px] text-ink-400 dark:text-night-mute px-1 tabular-nums inline-flex items-center gap-1.5" title={new Date(msg.at).toLocaleString()}>
                <span>{formatClock(msg.at)}</span>
                {#if msg.elapsedMs != null}
                  <span aria-hidden="true">·</span>
                  <span title="Round-trip from your send to the agent's reply">{formatElapsed(msg.elapsedMs)}</span>
                {/if}
                {#if msg.tokens != null}
                  <span aria-hidden="true">·</span>
                  <span title="Total tokens reported by the agent">{formatTokens(msg.tokens)}</span>
                {/if}
              </div>
              </div>
            </div>
          {/if}
        {/each}
        {#if pending}
          <!-- Agent-thinking indicator. Avatar + bubble matches the
               agent-reply layout so the user reads it as "the agent
               is mid-composing this exact slot". Three pulsing dots
               animate via the pinta-chat-dot keyframe in app.css. -->
          <div class="flex items-start gap-2">
            <div class="shrink-0 w-7 h-7 rounded-md bg-gradient-to-br from-brand-pink to-purple-500 inline-flex items-center justify-center shadow-sm mt-0.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white" aria-hidden="true">
                <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" />
                <path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z" opacity="0.85" />
                <path d="M5 15l.6 1.8L7.4 17.4l-1.8.6L5 19.8l-.6-1.8L2.6 17.4l1.8-.6L5 15z" opacity="0.7" />
              </svg>
            </div>
            <div class="rounded-lg rounded-tl-sm bg-ink-100 dark:bg-night-alt text-ink-600 dark:text-night-mute text-[12px] px-3 py-2.5 inline-flex items-center gap-1" title="Agent is composing a reply…">
              <span class="pinta-chat-dot w-1.5 h-1.5 rounded-full bg-brand-pink" style="animation-delay: 0ms"></span>
              <span class="pinta-chat-dot w-1.5 h-1.5 rounded-full bg-brand-pink" style="animation-delay: 150ms"></span>
              <span class="pinta-chat-dot w-1.5 h-1.5 rounded-full bg-brand-pink" style="animation-delay: 300ms"></span>
              <span class="ml-1.5">Thinking…</span>
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
      {#if imagesEnabled && attachedImages.length > 0}
        <!-- Pasted-image preview row. Each chip is a thumbnail with a
             remove × that detaches before send. Sits above the textarea
             so the user always sees what's about to ride along. -->
        <div class="mb-2 flex flex-wrap gap-1.5">
          {#each attachedImages as img, i (i)}
            <div class="relative group">
              <img
                src={img.dataUrl}
                alt={img.name || `Attachment ${i + 1}`}
                class="block w-12 h-12 object-cover rounded border border-ink-200 dark:border-night-line"
              />
              <button
                type="button"
                class="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-ink-900 dark:bg-night-line text-white text-[10px] leading-none inline-flex items-center justify-center opacity-90 hover:opacity-100"
                onclick={() => removeAttachedImage(i)}
                aria-label={`Remove attachment ${i + 1}`}
                title="Remove"
              >
                ×
              </button>
            </div>
          {/each}
        </div>
      {/if}
      {#if pasteHint}
        <p class="mb-2 text-[11px] text-ink-500 dark:text-night-mute leading-snug">
          {pasteHint}
        </p>
      {/if}
      <!-- Pill-shaped input wrapper. Textarea sits inside; send button
           overlays the right edge and slides in only when there's
           content to send. Matches the v0.4 mock where no chrome
           competes with the placeholder text in the empty state. -->
      <div class="relative flex items-stretch">
        <textarea
          rows="1"
          {placeholder}
          class="flex-1 text-[13px] text-ink-800 dark:text-night-text bg-ink-100 dark:bg-night-bg border border-transparent rounded-full pl-4 pr-12 py-2.5 leading-snug resize-none focus:outline-none focus:ring-2 focus:ring-brand-pink/30 placeholder:text-ink-500 dark:placeholder:text-night-mute"
          bind:value={draft}
          onkeydown={onKeyDown}
          onpaste={handlePaste}
          disabled={pending}
        ></textarea>
        {#if draft.trim() !== "" || attachedImages.length > 0 || pending}
          <button
            type="button"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-brand-pink text-white hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50 inline-flex items-center justify-center transition-opacity"
            onclick={handleSend}
            disabled={pending || (draft.trim() === "" && attachedImages.length === 0) || app.connectionStatus !== "connected"}
            title="Send (Cmd/Ctrl + Enter)"
            aria-label="Send message"
          >
            {#if pending}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            {:else}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            {/if}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
