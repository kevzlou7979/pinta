<script lang="ts">
  import type { AnnotationImage } from "@pinta/shared";

  type Props = {
    anchor: { top: number; left: number; width: number; height: number };
    title?: string;
    value: string;
    images?: AnnotationImage[];
    onsubmit: () => void;
    oncancel: () => void;
  };
  let {
    anchor,
    title = "",
    value = $bindable(""),
    images = $bindable<AnnotationImage[]>([]),
    onsubmit,
    oncancel,
  }: Props = $props();

  const POPUP_W = 300;
  const POPUP_H = 140;

  let top = $derived(
    anchor.top + anchor.height + 8 + POPUP_H < window.innerHeight
      ? anchor.top + anchor.height + 8
      : Math.max(8, anchor.top - POPUP_H - 8),
  );
  let left = $derived(
    Math.max(8, Math.min(window.innerWidth - POPUP_W - 8, anchor.left)),
  );

  let textarea: HTMLTextAreaElement | undefined = $state();
  let dropActive = $state(false);

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

  function insertPlaceholder(token: string) {
    const ta = textarea;
    if (ta) {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const before = value.slice(0, start);
      const after = value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      value = before + sep + token + (after.startsWith(" ") || after.length === 0 ? "" : " ") + after;
      requestAnimationFrame(() => {
        const pos = before.length + sep.length + token.length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
    } else {
      const sep = value.length > 0 && !value.endsWith(" ") ? " " : "";
      value = value + sep + token;
    }
  }

  function removeImageAt(idx: number) {
    const removed = images[idx];
    if (!removed) return;
    images = images.filter((_, i) => i !== idx).map((img, i) => ({ ...img, id: `image${i + 1}` }));
    let next = value.split(`[${removed.id}]`).join("").replace(/\s{2,}/g, " ").trim();
    for (let i = images.length; i >= 1; i--) {
      const oldToken = `[image${i + 1}]`;
      const newToken = `[image${i}]`;
      next = next.split(oldToken).join(newToken);
    }
    value = next;
  }

  async function onPaste(e: ClipboardEvent) {
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
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    for (const file of files) {
      if (file.type.startsWith("image/")) await attachImage(file, file.name);
    }
  }

  function onDragOver(e: DragEvent) {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      dropActive = true;
    }
  }

  function onDragLeave() {
    dropActive = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onsubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
    }
  }
</script>

<div
  class="popup"
  class:popup--drop={dropActive}
  style:top="{top}px"
  style:left="{left}px"
  style:width="{POPUP_W}px"
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  role="region"
  aria-label="Annotation comment"
>
  {#if title}
    <div class="popup__head">{title}</div>
  {/if}
  <textarea
    bind:this={textarea}
    bind:value
    onkeydown={onKey}
    onpaste={onPaste}
    placeholder="What do you want changed? Paste or drop images for visual reference."
    rows="3"
    autofocus
  ></textarea>
  {#if images.length > 0}
    <div class="thumbs">
      {#each images as img, i (img.id)}
        <div class="thumb">
          <img src={img.dataUrl} alt={`reference ${img.id}`} />
          <span class="thumb__token">[{img.id}]</span>
          <button
            type="button"
            class="thumb__x"
            title="Remove {img.id}"
            aria-label="Remove {img.id}"
            onclick={() => removeImageAt(i)}
          >×</button>
        </div>
      {/each}
    </div>
  {/if}
  <div class="popup__actions">
    <button class="btn btn--ghost" onclick={oncancel}>Cancel</button>
    <button
      class="btn btn--primary"
      onclick={onsubmit}
      disabled={!value.trim()}
    >
      Add annotation
    </button>
  </div>
</div>
