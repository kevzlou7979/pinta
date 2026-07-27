<script lang="ts">
  import type { Annotation } from "@pinta/shared";
  import { deviceClassForWidth, viewportLabel } from "@pinta/shared";
  import { app } from "../lib/state.svelte.js";
  import MicButton from "../lib/voice/MicButton.svelte";

  type Props = {
    annotation: Annotation;
    canEdit: boolean;
    /** Session-level "waiting on agent" state. Lights up the spinner the
     *  moment the user clicks Send, so the UI doesn't sit idle while the
     *  agent decides which annotation to start with. Per-annotation
     *  status (done / error / applying) still wins over this. */
    pending?: boolean;
    /** When set, replaces the status indicator with a numbered badge in
     *  this hex color. Used by the imported-session read-only viewer so
     *  each shared session's annotations are visibly tagged with the
     *  exporter's chosen accent color. */
    accentColorOverride?: string;
    /** 1-based position of this annotation in its session. Required when
     *  `accentColorOverride` is set so the numbered badge has something
     *  to render. Ignored otherwise. */
    index?: number;
    /** Drift Check verdict for this annotation, if a check has run. When
     *  the status isn't "ok" the card shows a badge so the user can spot
     *  which changes drifted / were missed and need a resubmit. */
    drift?: { status: "ok" | "drifted" | "missing" | "unverifiable"; reason?: string } | null;
    onremove: () => void;
    onsave: (comment: string) => void;
  };
  let {
    annotation,
    canEdit,
    pending = false,
    accentColorOverride,
    index,
    drift = null,
    onremove,
    onsave,
  }: Props = $props();

  // Only surface a badge for verdicts that need attention; "ok" stays
  // quiet so the list doesn't turn into a wall of green.
  const driftBadge = $derived.by(() => {
    if (!drift || drift.status === "ok") return null;
    if (drift.status === "drifted")
      return {
        label: "Drifted",
        classes:
          "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
        title:
          drift.reason ??
          "The change was applied but has since diverged — resubmit to re-apply.",
      };
    if (drift.status === "missing")
      return {
        label: "Missing",
        classes:
          "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200",
        title:
          drift.reason ??
          "No trace of this change in source — the agent missed it. Resubmit to apply.",
      };
    return {
      label: "Unverified",
      classes:
        "bg-ink-100 text-ink-700 dark:bg-night-alt dark:text-night-dim",
      title:
        drift.reason ?? "The agent couldn't confirm this change either way.",
    };
  });

  // Viewport chip — surfaces the capture width so a mobile/tablet
  // annotation reads as breakpoint-scoped at a glance (and the agent is
  // told the same in the payload). Hidden for desktop-width captures so
  // the common case stays uncluttered.
  const viewportChip = $derived.by(() => {
    const label = viewportLabel(annotation.viewport);
    if (!label) return null;
    const cls = deviceClassForWidth(annotation.viewport!.width);
    return {
      label,
      icon: cls === "mobile" ? "📱" : "💻",
      classes:
        cls === "mobile"
          ? "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-200"
          : "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200",
      title: `Annotated at a ${cls} viewport (${Math.round(annotation.viewport!.width)}px). The agent scopes this change to the ${cls} breakpoint and leaves desktop untouched.`,
    };
  });

  let editing = $state(false);
  let draftComment = $state(annotation.comment);
  let draftCommentEl: HTMLTextAreaElement | undefined = $state();

  // Read targets[] when present, fall back to [target] for older
  // sessions persisted before v0.3. Empty if neither is set (drawing
  // annotations without a resolved target).
  const targets = $derived(
    annotation.targets && annotation.targets.length > 0
      ? annotation.targets
      : annotation.target
        ? [annotation.target]
        : [],
  );

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
  class:pinta-loading-card={annotation.status === "applying" || pending}
>
  <div class="flex items-start gap-2">
    <!-- Status indicator (or numbered badge in imported read-only mode) -->
    <div class="pt-0.5 shrink-0">
      {#if accentColorOverride && typeof index === "number"}
        <span
          class="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-[10px] font-bold leading-none"
          style="background-color: {accentColorOverride};"
          aria-label="annotation {index}"
        >
          {index}
        </span>
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
      {:else if annotation.status === "applying" || pending}
        <span
          class="inline-block w-3 h-3 rounded-full border-2 border-brand-pink border-t-transparent animate-spin"
          title={annotation.status === "applying"
            ? "Agent is applying this change"
            : "Waiting for agent"}
          aria-label={annotation.status === "applying" ? "applying" : "waiting"}
        ></span>
      {:else}
        <span
          class="inline-block w-3 h-3 rounded-full border border-ink-300 bg-white dark:bg-night-alt dark:border-night-line2"
          aria-hidden="true"
        ></span>
      {/if}
    </div>

    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5 text-[11px] text-ink-500 dark:text-night-mute flex-wrap">
        <span class="uppercase tracking-wide font-medium"
          >{annotation.kind}</span
        >
        {#if driftBadge}
          <span
            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide {driftBadge.classes}"
            title={driftBadge.title}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            {driftBadge.label}
          </span>
        {/if}
        {#if viewportChip}
          <span
            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wide {viewportChip.classes}"
            title={viewportChip.title}
          >
            <span aria-hidden="true">{viewportChip.icon}</span>
            {viewportChip.label}
          </span>
        {/if}
        {#if targets.length === 1 && targets[0]?.selector}
          <span class="truncate font-mono">{targets[0]!.selector}</span>
        {:else if targets.length > 1}
          <span
            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-200 text-[10px] font-semibold uppercase tracking-wide"
            title={annotation.groupingMode === "per-element"
              ? "Agent applies the comment as N independent edits, one per target"
              : "Agent finds one change that satisfies every target"}
          >
            {targets.length} picks
            {#if annotation.groupingMode === "per-element"}
              · per-element
            {/if}
          </span>
        {/if}
      </div>
      {#if targets.length > 1}
        <ul class="mt-1 space-y-0.5 text-[10px] font-mono text-ink-500 dark:text-night-mute">
          {#each targets as t, i (i + (t.selector ?? ""))}
            <li class="flex items-baseline gap-1.5 truncate">
              <span class="text-blue-600 dark:text-blue-400 font-semibold shrink-0">{i + 1}.</span>
              <span class="truncate" title={t.selector}>{t.selector}</span>
            </li>
          {/each}
        </ul>
      {/if}

      {#if editing}
        <div class="relative mt-1">
          <textarea
            rows={3}
            autofocus
            bind:this={draftCommentEl}
            bind:value={draftComment}
            onkeydown={onKey}
            class="w-full pr-10 rounded border border-ink-300 bg-white text-ink-900 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-pink dark:border-night-line dark:bg-night-alt dark:text-night-text dark:placeholder-night-mute"
          ></textarea>
          {#if app.voiceReady}
            <span class="absolute right-1.5 bottom-1.5">
              <MicButton el={draftCommentEl} lang={app.voiceLang} />
            </span>
          {/if}
        </div>
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
        {#if annotation.move}
          <p class="text-[11px] text-ink-600 dark:text-night-dim mt-1 break-words">
            <span class="text-ink-400 dark:text-night-mute">Move:</span>
            {#if annotation.move.drop === "reorder"}
              <span class="text-emerald-700 dark:text-emerald-400">→ {annotation.move.container?.selector ?? "container"}</span>
              {#if annotation.move.reference}
                <span class="text-ink-500 dark:text-night-mute">({annotation.move.position} <span class="font-mono text-[10px]">{annotation.move.reference.selector}</span>)</span>
              {:else}
                <span class="text-ink-500 dark:text-night-mute">(append inside)</span>
              {/if}
            {:else}
              <span class="text-emerald-700 dark:text-emerald-400">by {annotation.move.offset?.dx ?? 0}px, {annotation.move.offset?.dy ?? 0}px</span>
              <span class="text-ink-500 dark:text-night-mute">(free position)</span>
            {/if}
          </p>
        {/if}
        {#if annotation.textInsert}
          <p class="text-[11px] text-ink-600 dark:text-night-dim mt-1 break-words">
            <span class="text-ink-400 dark:text-night-mute">New paragraph:</span>
            <span class="text-brand-magenta dark:text-brand-pink-light">“{annotation.textInsert.text.slice(0, 80)}{annotation.textInsert.text.length > 80 ? "…" : ""}”</span>
            {#if annotation.textInsert.reference}
              <span class="text-ink-500 dark:text-night-mute">({annotation.textInsert.position} <span class="font-mono text-[10px]">{annotation.textInsert.reference.selector}</span>)</span>
            {/if}
          </p>
        {/if}
        {#if annotation.kind === "delete"}
          <p class="text-[11px] text-ink-600 dark:text-night-dim mt-1 break-words">
            <span class="text-red-600 dark:text-red-400 font-medium">Remove</span>
            <span class="text-ink-500 dark:text-night-mute"
              >{targets.length > 1
                ? `${targets.length} elements`
                : "this element"} from source</span
            >
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
        {#if annotation.images && annotation.images.length > 0}
          <div class="mt-1.5 flex gap-1 flex-wrap">
            {#each annotation.images as img (img.id)}
              <a
                href={img.dataUrl ?? "#"}
                target="_blank"
                rel="noopener"
                title="{img.id} — open in new tab"
                class="relative block w-12 h-12 rounded overflow-hidden border border-ink-200 dark:border-night-line"
              >
                {#if img.dataUrl}
                  <img
                    src={img.dataUrl}
                    alt={img.id}
                    class="w-full h-full object-cover"
                  />
                {/if}
                <span
                  class="absolute bottom-0 left-0 right-0 text-[8px] text-white text-center font-mono"
                  style="background: rgba(15, 23, 42, 0.78);"
                >{img.id}</span>
              </a>
            {/each}
          </div>
        {/if}
        {#if annotation.status === "error" && annotation.errorMessage}
          <p class="text-[11px] text-red-600 dark:text-red-300 mt-1">
            {annotation.errorMessage}
          </p>
        {/if}
      {/if}
    </div>

    {#if !editing}
      <div class="flex items-center gap-0.5 shrink-0">
        {#if canEdit}
          <button
            type="button"
            class="w-6 h-6 inline-flex items-center justify-center rounded text-ink-400 hover:text-ink-900 hover:bg-ink-100 dark:text-night-mute dark:hover:text-night-text dark:hover:bg-night-line transition-colors"
            onclick={startEdit}
            aria-label="Edit comment"
            title="Edit comment"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          </button>
          <button
            type="button"
            class="w-6 h-6 inline-flex items-center justify-center rounded text-ink-400 hover:text-red-600 hover:bg-red-50 dark:text-night-mute dark:hover:text-red-400 dark:hover:bg-red-950/40 transition-colors"
            onclick={onremove}
            aria-label="Remove annotation"
            title="Remove annotation"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        {/if}
      </div>
    {/if}
  </div>
</li>
