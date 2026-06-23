<script lang="ts">
  import type { AnnotationImage } from "@pinta/shared";

  type Props = {
    /** Mirrors the other Annotate forms — locked while a batch is in
     *  flight or all annotations have settled. */
    disabled?: boolean;
    /** Hands the finished note back to App.svelte, which wraps it in a
     *  `kind: "note"` annotation and pushes it into the session. */
    onadd: (payload: { comment: string; images: AnnotationImage[] }) => void;
  };
  let { disabled = false, onadd }: Props = $props();

  let comment = $state("");
  let images = $state<AnnotationImage[]>([]);
  let dropActive = $state(false);
  let textarea: HTMLTextAreaElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();

  const canAdd = $derived(
    !disabled && (comment.trim().length > 0 || images.length > 0),
  );

  function readBlob(blob: File | Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(blob);
    });
  }

  async function attachImage(blob: File | Blob, name?: string) {
    const dataUrl = await readBlob(blob);
    const id = `image${images.length + 1}`;
    images = [...images, { id, mediaType: blob.type || "image/png", dataUrl, name }];
    insertPlaceholder(`[${id}]`);
  }

  // Drop an `[imageN]` token at the cursor so the agent (and the user)
  // can refer to the attachment inline — mirrors ElementEditor's popover.
  function insertPlaceholder(token: string) {
    const ta = textarea;
    if (ta) {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const before = comment.slice(0, start);
      const after = comment.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      comment =
        before + sep + token + (after.startsWith(" ") || after.length === 0 ? "" : " ") + after;
      requestAnimationFrame(() => {
        const pos = before.length + sep.length + token.length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
    } else {
      const sep = comment.length > 0 && !comment.endsWith(" ") ? " " : "";
      comment = comment + sep + token;
    }
  }

  function removeImageAt(idx: number) {
    const removed = images[idx];
    if (!removed) return;
    images = images
      .filter((_, i) => i !== idx)
      .map((img, i) => ({ ...img, id: `image${i + 1}` }));
    // Strip the removed placeholder and renumber the rest so [imageN]
    // references keep matching the thumbnails.
    let next = comment.split(`[${removed.id}]`).join("").replace(/\s{2,}/g, " ").trim();
    for (let i = images.length; i >= 1; i--) {
      const oldToken = `[image${i + 1}]`;
      const newToken = `[image${i}]`;
      next = next.split(oldToken).join(newToken);
    }
    comment = next;
  }

  async function onPaste(e: ClipboardEvent) {
    if (disabled) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) await attachImage(blob, blob.name);
      }
    }
  }

  async function onDrop(e: DragEvent) {
    dropActive = false;
    if (disabled) return;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    for (const file of files) {
      if (file.type.startsWith("image/")) await attachImage(file, file.name);
    }
  }

  function onDragOver(e: DragEvent) {
    if (disabled) return;
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      dropActive = true;
    }
  }

  async function onFilePicked(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    input.value = "";
    if (!files) return;
    for (const file of files) {
      if (file.type.startsWith("image/")) await attachImage(file, file.name);
    }
  }

  function submit() {
    if (!canAdd) return;
    onadd({ comment: comment.trim(), images: $state.snapshot(images) as AnnotationImage[] });
    comment = "";
    images = [];
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }
</script>

<div
  class="p-3 pt-0 space-y-2"
  class:opacity-60={disabled}
  ondragover={onDragOver}
  ondragleave={() => (dropActive = false)}
  ondrop={onDrop}
  role="group"
  aria-label="Add a task"
>
  <textarea
    bind:this={textarea}
    placeholder="Describe a task — e.g. “Create a new dialog for this feature”. No element needed."
    rows={3}
    class="w-full rounded-md border bg-white text-ink-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink dark:bg-night-alt dark:text-night-text dark:placeholder-night-mute disabled:opacity-50 {dropActive ? 'border-brand-pink ring-2 ring-brand-pink/30' : 'border-ink-300 dark:border-night-line'}"
    bind:value={comment}
    onkeydown={onKey}
    onpaste={onPaste}
    {disabled}
  ></textarea>

  {#if images.length > 0}
    <div class="flex gap-1 flex-wrap">
      {#each images as img, i (img.id)}
        <div class="relative w-12 h-12 rounded overflow-hidden border border-ink-200 dark:border-night-line">
          {#if img.dataUrl}
            <img src={img.dataUrl} alt={img.id} class="w-full h-full object-cover" />
          {/if}
          <span
            class="absolute bottom-0 left-0 right-0 text-[8px] text-white text-center font-mono"
            style="background: rgba(15, 23, 42, 0.78);"
          >{img.id}</span>
          <button
            type="button"
            class="absolute top-0 right-0 w-4 h-4 inline-flex items-center justify-center bg-black/60 text-white text-[10px] leading-none rounded-bl"
            title="Remove {img.id}"
            aria-label="Remove {img.id}"
            onclick={() => removeImageAt(i)}
          >×</button>
        </div>
      {/each}
    </div>
  {/if}

  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    multiple
    class="hidden"
    onchange={onFilePicked}
    aria-hidden="true"
  />

  <div class="flex items-center gap-2">
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded-md border border-ink-300 bg-white text-ink-700 text-xs px-2.5 py-2 hover:bg-brand-cream hover:border-brand-pink/40 dark:border-night-line dark:bg-night-card dark:text-night-dim dark:hover:bg-night-alt disabled:opacity-50"
      onclick={() => fileInput?.click()}
      {disabled}
      title="Attach reference image(s) — or paste / drop into the box above"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/><path d="m3 16 5-5c.928-.893 2.072-.893 3 0l5 5"/><circle cx="9" cy="9" r="1.5" fill="currentColor"/><path d="M19 3v4"/><path d="M17 5h4"/></svg>
      Image
    </button>
    <button
      type="button"
      class="flex-1 rounded-md bg-brand-pink text-white text-sm font-medium py-2 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50"
      disabled={!canAdd}
      onclick={submit}
    >
      Add task
    </button>
  </div>
  <p class="text-[11px] text-ink-500 dark:text-night-mute">
    Paste or drop images to attach as <code>[image{images.length + 1}]</code>. ⌘/Ctrl+Enter to add.
  </p>
</div>
