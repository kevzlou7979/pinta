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
      <div class="flex items-end gap-2">
        <textarea
          rows="2"
          {placeholder}
          class="flex-1 text-[12.5px] text-ink-800 dark:text-night-text bg-white dark:bg-night-card border border-ink-200 dark:border-night-line rounded-md px-2.5 py-1.5 leading-snug resize-none focus:outline-none focus:ring-2 focus:ring-brand-pink/40 placeholder:text-ink-400 dark:placeholder:text-night-mute"
          bind:value={draft}
          onkeydown={onKeyDown}
          onpaste={handlePaste}
          disabled={pending}
        ></textarea>
        <button
          type="button"
          class="shrink-0 h-10 px-3 rounded-md bg-brand-pink text-white text-[12.5px] font-semibold hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
          onclick={handleSend}
          disabled={pending || (draft.trim() === "" && attachedImages.length === 0) || app.connectionStatus !== "connected"}
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
