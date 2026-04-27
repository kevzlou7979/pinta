<script lang="ts">
  import type { Annotation } from "@pinta/shared";

  type Props = {
    annotation: Annotation;
    canEdit: boolean;
    onremove: () => void;
    onsave: (comment: string) => void;
  };
  let { annotation, canEdit, onremove, onsave }: Props = $props();

  let editing = $state(false);
  let draftComment = $state(annotation.comment);

  function startEdit() {
    draftComment = annotation.comment;
    editing = true;
  }
  function cancelEdit() {
    editing = false;
    draftComment = annotation.comment;
  }
  function save() {
    const trimmed = draftComment.trim();
    if (!trimmed || trimmed === annotation.comment) {
      cancelEdit();
      return;
    }
    onsave(trimmed);
    editing = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  }
</script>

<li
  class="rounded-md border bg-white dark:bg-night-card p-3 text-sm space-y-1.5 shadow-sm dark:shadow-none"
  class:border-ink-200={annotation.status !== "error"}
  class:dark:border-night-line={annotation.status !== "error"}
  class:border-red-300={annotation.status === "error"}
  class:dark:border-red-900={annotation.status === "error"}
  class:opacity-90={annotation.status === "done"}
>
  <div class="flex items-start gap-2">
    <!-- Status indicator -->
    <div class="pt-0.5 shrink-0">
      {#if annotation.status === "applying"}
        <span
          class="inline-block w-3 h-3 rounded-full border-2 border-brand-pink border-t-transparent animate-spin"
          title="Agent is applying this change"
          aria-label="applying"
        ></span>
      {:else if annotation.status === "done"}
        <span
          class="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-600 text-white text-[10px] font-bold leading-none"
          title="Done"
          aria-label="done"
        >
          ✓
        </span>
      {:else if annotation.status === "error"}
        <span
          class="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-600 text-white text-[10px] font-bold leading-none"
          title={annotation.errorMessage ?? "Error"}
          aria-label="error"
        >
          !
        </span>
      {:else}
        <span
          class="inline-block w-3 h-3 rounded-full border border-ink-300 bg-white dark:bg-night-alt dark:border-night-line2"
          aria-hidden="true"
        ></span>
      {/if}
    </div>

    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5 text-[11px] text-ink-500 dark:text-night-mute">
        <span class="uppercase tracking-wide font-medium"
          >{annotation.kind}</span
        >
        {#if annotation.target?.selector}
          <span class="truncate font-mono">{annotation.target.selector}</span>
        {/if}
      </div>

      {#if editing}
        <textarea
          rows={3}
          autofocus
          bind:value={draftComment}
          onkeydown={onKey}
          class="w-full mt-1 rounded border border-ink-300 bg-white text-ink-900 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink dark:border-night-line dark:bg-night-alt dark:text-night-text dark:placeholder-night-mute"
        ></textarea>
        <div class="flex justify-end gap-1.5 mt-1.5">
          <button
            type="button"
            class="text-ink-500 hover:text-ink-900 dark:text-night-mute dark:hover:text-night-text text-xs px-2 py-1"
            onclick={cancelEdit}
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded bg-brand-pink text-white text-xs font-medium px-2.5 py-1 hover:bg-brand-magenta dark:hover:bg-brand-pink-light disabled:opacity-50"
            disabled={!draftComment.trim()}
            onclick={save}
          >
            Save
          </button>
        </div>
      {:else}
        {#if annotation.comment}
          <p class="text-ink-900 dark:text-night-text mt-1 break-words">{annotation.comment}</p>
        {/if}
        {#if annotation.contentChange}
          <p class="text-[11px] text-ink-600 dark:text-night-dim mt-1 break-words">
            <span class="text-ink-400 dark:text-night-mute">Text:</span>
            <span class="line-through text-ink-500 dark:text-night-mute">{annotation.contentChange.textBefore.slice(0, 60)}</span>
            <span class="text-ink-400 dark:text-night-mute">→</span>
            <span class="text-brand-magenta dark:text-brand-pink-light">{annotation.contentChange.textAfter.slice(0, 60)}</span>
          </p>
        {/if}
        {#if annotation.cssChanges && Object.keys(annotation.cssChanges).length > 0}
          <pre
            class="mt-1 px-2 py-1.5 rounded bg-brand-cream text-brand-magenta dark:bg-night-alt dark:text-brand-pink-light text-[11px] font-mono overflow-x-auto whitespace-pre-wrap break-words"
            title="Structured CSS changes">{Object.entries(annotation.cssChanges).map(([k, v]) => `${k}: ${v};`).join("\n")}</pre>
        {/if}
        {#if annotation.customCss}
          <pre
            class="mt-1 px-2 py-1.5 rounded bg-brand-cream text-brand-magenta dark:bg-night-alt dark:text-brand-pink-light text-[11px] font-mono overflow-x-auto whitespace-pre-wrap break-words"
            title="Custom CSS to apply">{annotation.customCss}</pre>
        {/if}
        {#if annotation.status === "error" && annotation.errorMessage}
          <p class="text-[11px] text-red-600 dark:text-red-300 mt-1">
            {annotation.errorMessage}
          </p>
        {/if}
      {/if}
    </div>

    {#if !editing}
      <div class="flex flex-col items-end gap-0.5 shrink-0">
        {#if canEdit}
          <button
            type="button"
            class="text-ink-400 hover:text-ink-900 dark:text-night-mute dark:hover:text-night-text text-xs"
            onclick={startEdit}
            aria-label="Edit annotation"
            title="Edit comment"
          >
            Edit
          </button>
          <button
            type="button"
            class="text-ink-400 hover:text-red-600 dark:text-night-mute dark:hover:text-red-400 text-xs"
            onclick={onremove}
            aria-label="Remove annotation"
          >
            Remove
          </button>
        {/if}
      </div>
    {/if}
  </div>
</li>
