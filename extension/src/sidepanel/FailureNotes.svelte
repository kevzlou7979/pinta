<script lang="ts">
  // Failure notes for one failed Test Pilot row: what went wrong, how
  // to reproduce it, and screenshots. Rendered inline under the row in
  // the catalog and in the test's detail view. A row can carry several
  // notes; each is exported with the test id + title in the results
  // (.docx embeds the screenshots) and rides in the .pinta bundle.
  import { untrack } from "svelte";
  import { app, type TestPilotTest } from "../lib/state.svelte.js";
  import { confirmDialog } from "../lib/confirm.svelte.js";
  import { downscaleImage } from "../lib/downscale-image.js";
  import {
    cleanImageName,
    FAILURE_NOTE_LIMITS,
    isFailureNoteImage,
    NEW_NOTE,
    splitSteps,
    type FailureNote,
    type FailureNoteImage,
  } from "../lib/failure-notes.js";

  let {
    test,
    readOnly = false,
  }: {
    test: TestPilotTest;
    /** Imported-run view: the notes are the tester's, look don't touch. */
    readOnly?: boolean;
  } = $props();

  const notes = $derived(test.failNotes ?? []);
  const atLimit = $derived(notes.length >= FAILURE_NOTE_LIMITS.notesPerTest);

  /** `NEW_NOTE` = composing a fresh note, a note id = editing that note. */
  let editing = $state<string | null>(null);
  let description = $state("");
  let steps = $state("");
  let images = $state<FailureNoteImage[]>([]);
  let hint = $state<string | null>(null);
  /** Attach calls still downscaling — a paste can overlap a pick. */
  let attachCount = $state(0);
  const attaching = $derived(attachCount > 0);
  let fileInput = $state<HTMLInputElement | null>(null);
  let lightbox = $state<{ url: string; name?: string } | null>(null);

  /** Bumped whenever the draft is opened, saved or dropped, so a
   *  screenshot still being downscaled can tell its draft is gone. */
  let session = 0;
  /** What the composer opened with — lets Escape tell "nothing typed"
   *  from "would throw work away". */
  let baseline = "";

  const canSave = $derived(
    !attaching &&
      (description.trim().length > 0 || steps.trim().length > 0 || images.length > 0),
  );

  // The component under a row unmounts when the tester opens the test's
  // detail view, starts an inline title edit, or re-marks the row — a
  // half-written note (with pasted screenshots) must survive that, so
  // the open draft is parked on `app` (which drops them all when the
  // marks or the catalog are cleared).
  const parked = app.failureNoteDrafts;
  const draftKey = $derived(app.failureNoteDraftKey(test.id));

  function fingerprint(): string {
    return JSON.stringify([description, steps, images.map((im) => im.dataUrl.length)]);
  }

  /** Pick this row's parked draft back up — unless the note it was
   *  editing has since been deleted. */
  function restoreParked() {
    if (editing !== null) return;
    const draft = parked.get(draftKey);
    if (!draft) return;
    if (draft.editing === NEW_NOTE || notes.some((n) => n.id === draft.editing)) {
      editing = draft.editing;
      description = draft.description;
      steps = draft.steps;
      images = draft.images;
      // Restored work counts as unsaved: Escape must not drop it.
      baseline = "";
    } else {
      parked.delete(draftKey);
    }
  }

  // On mount, and again when an imported run is cleared. Under the run
  // the row shows the tester's notes, so the draft waits untouched.
  // Tracks `readOnly` only — it must not re-run on Cancel and bring the
  // draft straight back. Declared before the parking effect below so a
  // draft is restored before that effect could drop it.
  $effect(() => {
    if (readOnly) return;
    untrack(restoreParked);
  });

  // Keep the parked copy in step with the open draft.
  $effect(() => {
    if (readOnly) return;
    if (editing === null) {
      parked.delete(draftKey);
    } else {
      parked.set(draftKey, {
        editing,
        description,
        steps,
        images: $state.snapshot(images) as FailureNoteImage[],
      });
    }
  });

  // The note being edited was deleted from somewhere else. (Not under
  // an imported run: there the tester's notes stand in for it.)
  $effect(() => {
    if (readOnly) return;
    if (editing !== null && editing !== NEW_NOTE && !notes.some((n) => n.id === editing)) {
      session++;
      editing = null;
    }
  });

  function startNew() {
    session++;
    editing = NEW_NOTE;
    description = "";
    steps = "";
    images = [];
    hint = null;
    baseline = fingerprint();
  }

  function startEdit(note: FailureNote) {
    session++;
    editing = note.id;
    description = note.description;
    steps = note.steps ?? "";
    images = [...(note.images ?? [])];
    hint = null;
    baseline = fingerprint();
  }

  function cancel() {
    session++;
    editing = null;
    hint = null;
  }

  function save() {
    if (!canSave || editing === null) return;
    const ok = app.saveFailureNote(test.id, {
      ...(editing !== NEW_NOTE ? { id: editing } : {}),
      description,
      steps,
      images: $state.snapshot(images) as FailureNoteImage[],
    });
    if (ok) {
      session++;
      editing = null;
    } else {
      hint = "Couldn't save this note.";
    }
  }

  async function remove(note: FailureNote) {
    const ok = await confirmDialog({
      title: "Delete this failure note?",
      message: `The note on ${test.id} and its screenshots will be removed.`,
      confirmLabel: "Delete note",
      danger: true,
    });
    if (ok) app.deleteFailureNote(test.id, note.id);
  }

  /** Downscale + attach picked / pasted files, up to the per-note cap. */
  async function attach(files: File[]) {
    const picked = files.filter((f) => f.type.startsWith("image/"));
    if (picked.length === 0) return;
    hint = null;
    // Downscaling is async: if the draft is saved, cancelled or swapped
    // for another note meanwhile, the rest must not land in it.
    const mine = session;
    const full = () => images.length >= FAILURE_NOTE_LIMITS.imagesPerNote;
    let dropped = 0;
    let unreadable = 0;
    attachCount++;
    try {
      for (const file of picked) {
        if (full()) {
          dropped++;
          continue;
        }
        try {
          const img = await downscaleImage(file, {
            maxEdge: FAILURE_NOTE_LIMITS.imageMaxEdge,
            pngOrJpeg: true,
          });
          if (mine !== session) return;
          const name = cleanImageName(file.name);
          const next = { ...img, ...(name ? { name } : {}) };
          if (!isFailureNoteImage(next)) {
            unreadable++;
            continue;
          }
          // Another attach may have filled the note while this one
          // was downscaling.
          if (full()) {
            dropped++;
            continue;
          }
          images = [...images, next];
        } catch {
          unreadable++;
        }
      }
    } finally {
      attachCount--;
    }
    if (mine !== session) return;
    const bits: string[] = [];
    if (dropped > 0) {
      bits.push(
        `${dropped} screenshot${dropped === 1 ? "" : "s"} left out — ${FAILURE_NOTE_LIMITS.imagesPerNote} per note. Add another note for more.`,
      );
    }
    if (unreadable > 0) {
      bits.push(`${unreadable} image${unreadable === 1 ? "" : "s"} couldn't be read.`);
    }
    // Only ever add a notice here: a second attach finishing cleanly
    // must not wipe what the first one had to say.
    if (bits.length > 0) hint = bits.join(" ");
  }

  function onPaste(e: ClipboardEvent) {
    const files: File[] = [];
    const items = e.clipboardData?.items;
    for (let i = 0; i < (items?.length ?? 0); i++) {
      const item = items![i]!;
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return; // plain text paste — leave it alone
    e.preventDefault();
    void attach(files);
  }

  function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = ""; // picking the same file twice must fire again
    void attach(files);
  }

  function onComposerKey(e: KeyboardEvent) {
    if (e.key === "Escape" && lightbox) {
      // A screenshot preview is open on top — Escape closes that first.
      e.stopPropagation();
      lightbox = null;
    } else if (e.key === "Escape") {
      // Escape closes an untouched composer. Once something is typed or
      // attached it does nothing — Cancel is the deliberate way out.
      e.stopPropagation();
      if (fingerprint() === baseline) cancel();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  }

  function stamp(at: number): string {
    return new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (lightbox && e.key === "Escape") lightbox = null;
  }}
/>

{#snippet thumbs(list: FailureNoteImage[], onRemove: ((i: number) => void) | null)}
  <div class="flex flex-wrap gap-1.5">
    {#each list.filter(isFailureNoteImage) as img, i (i)}
      <div class="relative">
        <button
          type="button"
          class="block w-16 h-16 rounded border border-ink-200 dark:border-night-line overflow-hidden bg-ink-50 dark:bg-night-alt hover:border-brand-pink dark:hover:border-brand-pink-light cursor-zoom-in"
          onclick={() => (lightbox = { url: img.dataUrl, name: img.name })}
          title={img.name ?? `Screenshot ${i + 1}`}
          aria-label={`View screenshot ${i + 1} for ${test.id}`}
        >
          <img src={img.dataUrl} alt={img.name ?? `Screenshot ${i + 1}`} class="w-full h-full object-cover" />
        </button>
        {#if onRemove}
          <button
            type="button"
            class="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-ink-800 text-white dark:bg-night-text dark:text-night-bg inline-flex items-center justify-center text-[9px] leading-none hover:bg-red-600 dark:hover:bg-red-500 dark:hover:text-white"
            onclick={() => onRemove(i)}
            aria-label={`Remove screenshot ${i + 1}`}
            title="Remove"
          >
            ✕
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/snippet}

{#snippet composer()}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="rounded-md border border-brand-pink/50 dark:border-brand-pink-light/50 bg-white dark:bg-night-card p-2.5 space-y-2"
    data-pinta-fail-note-composer
    onkeydown={onComposerKey}
  >
    <label class="block">
      <span class="block text-[10px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute mb-1">What went wrong</span>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        rows="2"
        class="block w-full text-[12px] text-ink-900 dark:text-night-text bg-white dark:bg-night-alt border border-ink-200 dark:border-night-line rounded px-2 py-1.5 leading-snug resize-y focus:outline-none focus:border-brand-pink dark:focus:border-brand-pink-light placeholder:text-ink-400 dark:placeholder:text-night-mute"
        placeholder="Describe what you saw instead of the expected result"
        maxlength={FAILURE_NOTE_LIMITS.descriptionChars}
        bind:value={description}
        onpaste={onPaste}
        aria-label={`Failure description for ${test.id}`}
        autofocus
      ></textarea>
    </label>
    <label class="block">
      <span class="block text-[10px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute mb-1">Steps to reproduce <span class="normal-case tracking-normal font-normal">(optional, one per line)</span></span>
      <textarea
        rows="3"
        class="block w-full text-[12px] text-ink-900 dark:text-night-text bg-white dark:bg-night-alt border border-ink-200 dark:border-night-line rounded px-2 py-1.5 leading-snug resize-y focus:outline-none focus:border-brand-pink dark:focus:border-brand-pink-light placeholder:text-ink-400 dark:placeholder:text-night-mute"
        placeholder={"Sign in as a claimant\nOpen the user menu\nClick Log out"}
        maxlength={FAILURE_NOTE_LIMITS.stepsChars}
        bind:value={steps}
        onpaste={onPaste}
        aria-label={`Steps to reproduce for ${test.id}`}
      ></textarea>
    </label>

    {#if images.length > 0}
      {@render thumbs(images, (i) => {
        images = images.filter((_, idx) => idx !== i);
        hint = null;
      })}
    {/if}

    {#if hint}
      <div class="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 dark:border-amber-800/50 dark:bg-amber-950/30 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-300 leading-snug" role="status">
        <span class="flex-1 min-w-0">{hint}</span>
        <button
          type="button"
          class="shrink-0 leading-none px-0.5 hover:text-amber-950 dark:hover:text-amber-100"
          onclick={() => (hint = null)}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    {/if}

    <div class="flex items-center gap-2">
      <input
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        bind:this={fileInput}
        onchange={onPick}
        aria-label={`Screenshot files for ${test.id}`}
      />
      <button
        type="button"
        class="inline-flex items-center gap-1 text-[11px] text-ink-700 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light px-2 py-1 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card disabled:opacity-40 disabled:cursor-not-allowed"
        onclick={() => fileInput?.click()}
        disabled={attaching || images.length >= FAILURE_NOTE_LIMITS.imagesPerNote}
        title={images.length >= FAILURE_NOTE_LIMITS.imagesPerNote
          ? `${FAILURE_NOTE_LIMITS.imagesPerNote} screenshots per note — add another note for more`
          : "Attach a screenshot (or paste one into a field)"}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        {attaching ? "Adding…" : "Add screenshot"}
      </button>
      <span class="flex-1 min-w-0 text-[10.5px] text-ink-500 dark:text-night-mute truncate">or paste an image</span>
      <button
        type="button"
        class="text-[11px] text-ink-600 dark:text-night-dim hover:text-ink-900 dark:hover:text-night-text px-2 py-1"
        onclick={cancel}
      >
        Cancel
      </button>
      <button
        type="button"
        class="text-[11px] font-semibold text-white bg-brand-pink hover:bg-brand-magenta dark:hover:bg-brand-pink-light rounded-md px-2.5 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
        onclick={save}
        disabled={!canSave}
        title="Save note (Ctrl+Enter)"
      >
        Save note
      </button>
    </div>
  </div>
{/snippet}

<div class="space-y-2" data-pinta-fail-notes={test.id}>
  {#each notes as note, i (note.id)}
    {#if editing === note.id && !readOnly}
      {@render composer()}
    {:else}
      {@const noteSteps = splitSteps(note.steps)}
      <div
        class="rounded-md border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-950/20 px-2.5 py-2 space-y-1.5"
        data-pinta-fail-note={note.id}
      >
        <div class="flex items-center gap-2">
          <span class="text-[10px] uppercase tracking-wider font-semibold text-red-700 dark:text-red-300">
            Failure note{notes.length > 1 ? ` ${i + 1}` : ""}
          </span>
          <span class="flex-1 min-w-0 text-[10px] text-ink-500 dark:text-night-mute truncate">{stamp(note.at)}</span>
          {#if !readOnly}
            <button
              type="button"
              class="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded text-ink-500 dark:text-night-mute hover:text-brand-pink dark:hover:text-brand-pink-light hover:bg-white dark:hover:bg-night-alt disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-500"
              onclick={() => startEdit(note)}
              disabled={editing !== null}
              aria-label={`Edit failure note ${i + 1} for ${test.id}`}
              title={editing !== null ? "Save or cancel the note you're writing first" : "Edit note"}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
            </button>
            <button
              type="button"
              class="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded text-ink-500 dark:text-night-mute hover:text-red-600 dark:hover:text-red-400 hover:bg-white dark:hover:bg-night-alt disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-500"
              onclick={() => remove(note)}
              disabled={editing !== null}
              aria-label={`Delete failure note ${i + 1} for ${test.id}`}
              title={editing !== null ? "Save or cancel the note you're writing first" : "Delete note"}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5L5 6"/></svg>
            </button>
          {/if}
        </div>
        {#if note.description}
          <p class="text-[12px] text-ink-900 dark:text-night-text leading-snug whitespace-pre-wrap break-words">{note.description}</p>
        {/if}
        {#if noteSteps.length > 0}
          <div>
            <div class="text-[10px] uppercase tracking-wider font-semibold text-ink-500 dark:text-night-mute">Steps to reproduce</div>
            <ol class="mt-0.5 pl-4 list-decimal text-[11.5px] text-ink-800 dark:text-night-text leading-snug space-y-0.5 marker:text-ink-400 dark:marker:text-night-mute">
              {#each noteSteps as step, si (si)}
                <li class="break-words">{step}</li>
              {/each}
            </ol>
          </div>
        {/if}
        {#if note.images && note.images.length > 0}
          {@render thumbs(note.images, null)}
        {/if}
      </div>
    {/if}
  {/each}

  <!-- Never in the read-only imported-run view: an open draft waits,
       hidden, until the run is cleared. -->
  {#if editing === NEW_NOTE && !readOnly}
    {@render composer()}
  {:else if !readOnly && editing === null}
    <button
      type="button"
      class="inline-flex items-center gap-1 text-[11px] font-medium text-ink-600 dark:text-night-dim hover:text-brand-pink dark:hover:text-brand-pink-light disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-ink-600"
      onclick={startNew}
      disabled={atLimit}
      title={atLimit
        ? `${FAILURE_NOTE_LIMITS.notesPerTest} notes per test`
        : "Describe the failure, add steps to reproduce and screenshots — exported with the results"}
      aria-label={`Add failure note for ${test.id}`}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      {notes.length > 0 ? "Add another note" : "Add failure note"}
    </button>
  {/if}
</div>

{#if lightbox}
  <!-- Full-size screenshot viewer. Click anywhere (or Esc) to dismiss. -->
  <div
    class="fixed inset-0 z-[120] flex items-center justify-center bg-black/85 p-4 cursor-zoom-out"
    role="button"
    tabindex="-1"
    aria-label="Close image preview"
    onclick={() => (lightbox = null)}
    onkeydown={(e) => e.key === "Escape" && (lightbox = null)}
  >
    <img
      src={lightbox.url}
      alt={lightbox.name ?? "screenshot preview"}
      class="max-w-full max-h-full object-contain rounded shadow-2xl"
    />
    <button
      type="button"
      class="absolute top-3 right-3 w-8 h-8 rounded-full bg-white/15 hover:bg-white/25 text-white inline-flex items-center justify-center"
      onclick={() => (lightbox = null)}
      aria-label="Close"
      title="Close"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
    </button>
  </div>
{/if}
