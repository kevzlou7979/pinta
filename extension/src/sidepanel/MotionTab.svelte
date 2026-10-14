<script lang="ts">
  // Phase 25 — Motion module. Element first, exactly like Design
  // Variants: open the tab and the page is already in pick mode; click the
  // element and the best previewable suggestion plays on the real page.
  // The rows ARE the controls — hover one to try it, click it to keep it;
  // there is no Play button. Everything a designer touches in the
  // twentieth minute (reverse, speed, scrub, loop, trigger, tokens, note)
  // sits in one collapsed Tune disclosure.
  //
  // Everything in this tab up to Apply is in-page Web Animations with no
  // companion attached.

  import { onDestroy, onMount } from "svelte";
  import type { AnnotationTarget } from "@pinta/shared";
  import { app } from "../lib/state.svelte.js";
  import EmptyState from "../lib/EmptyState.svelte";
  import {
    TRIGGER_LABELS,
    readTarget,
    staggerChoices,
    type MotionPattern,
    type MotionTrigger,
  } from "../lib/motion.js";

  const SPEEDS = [1, 0.5, 0.25];
  /** Resting the pointer, not sweeping past: the hover-to-try debounce. */
  const HOVER_DELAY = 120;
  /** No hover preview this soon after the panel scrolled — Chrome fires
   *  a synthetic mousemove when a scroll ends, and a still pointer over a
   *  list that moves under it must not read as a hover (F14). */
  const SCROLL_GRACE = 200;

  const ranked = $derived(app.motionRanked);
  const pattern = $derived(app.motionPattern);
  const timing = $derived(app.motionTiming);
  const blocked = $derived(app.motionBlockedReason);
  const picked = $derived(app.motion.pickedTarget);
  const stepChoices = $derived(staggerChoices(app.motion.system));
  /** The kept row renders above the heading; the lists hold the rest. */
  const suggestedOthers = $derived(ranked.suggested.filter((p) => p.id !== app.motion.patternId));
  const restOthers = $derived(ranked.rest.filter((p) => p.id !== app.motion.patternId));

  // Arm on open: the tab IS pick mode until something is picked. The
  // leave-tab $effect in App.svelte also cancels — the guard here keeps
  // the two from sending a second pick-cancel.
  onMount(() => {
    if (!app.motion.pickedTarget && !app.motion.picking) void app.startMotionPick("start");
    // Capture phase: <main> in App.svelte is the panel's scroller and
    // scroll events don't bubble.
    window.addEventListener("scroll", onAnyScroll, true);
  });
  onDestroy(() => {
    clearHoverTimer();
    window.removeEventListener("scroll", onAnyScroll, true);
    if (app.motion.picking) void app.cancelMotionPick();
  });

  /** Short, clickable form of a selector — the tail is the readable bit. */
  function shortSelector(sel: string): string {
    const tail = sel.split(">").pop()?.trim() ?? sel;
    return tail.length > 34 ? `…${tail.slice(-33)}` : tail;
  }

  /** What a chip says: a leaf's own text when it has any, else the
   *  selector tail — a container's text is a run-on of its children
   *  ("Card 1 Card 2 …"). The full selector always rides in the title. */
  function chipLabel(t: AnnotationTarget): string {
    const hasChildren = (readTarget(t)?.descendants ?? 0) > 0;
    const text = hasChildren ? "" : (t.nearbyText?.[0]?.trim() ?? "");
    return text ? (text.length > 40 ? `${text.slice(0, 39)}…` : text) : shortSelector(t.selector);
  }

  /** The error banner mounts at the top; failures are triggered from
   *  rows and Tune well below it, so bring it into view when it appears.
   *  Its scroll-margin clears the sticky tab bar (F12). */
  let errorBanner = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (app.motion.error && errorBanner) errorBanner.scrollIntoView?.({ block: "nearest" });
  });

  const durationTokens = $derived(Object.keys(app.motion.system.durations));
  const easingTokens = $derived(Object.keys(app.motion.system.easings));
  /** The token each select shows — may be one the system doesn't have. */
  const curDuration = $derived(timing?.durationToken ?? pattern?.duration ?? "");
  const curEasing = $derived(timing?.easingToken ?? pattern?.easing ?? "");

  /** Triggers are an effects concept; a nav-only pattern doesn't ask. */
  const showTriggers = $derived(!!pattern && pattern.triggers.length > 1);

  function pick(role: "start" | "end") {
    void app.startMotionPick(role);
  }

  /** ✕ on the target chip: back to square one, which is pick mode —
   *  the same state the tab opens in (F20). */
  function clearTarget() {
    app.clearMotionTarget("start");
    pick("start");
  }

  // --- rows are the controls -------------------------------------------

  /** Click = keep + play. A two-target row keeps and goes straight to the
   *  destination pick instead (nothing to play yet). A pending end pick
   *  is cancelled first so the next page click can't land as a
   *  destination for a one-target pattern (F10). */
  function keep(p: MotionPattern) {
    clearHoverTimer();
    if (app.motion.picking === "end") void app.cancelMotionPick();
    if (app.motion.patternId !== p.id) app.selectMotionPattern(p.id);
    if (p.targets === 2) {
      if (!app.motion.destTarget) pick("end");
      return;
    }
    void app.rehearseMotion(true);
  }

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  /** The row whose preview the timer is counting down to. */
  let hoverPendingId: string | null = null;
  let suppressUntil = 0;

  function clearHoverTimer() {
    if (hoverTimer != null) clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverPendingId = null;
  }

  function onAnyScroll() {
    suppressUntil = Date.now() + SCROLL_GRACE;
  }

  function canPreview(p: MotionPattern): boolean {
    return !!picked && p.targets !== 2 && p.rehearsable && app.motion.patternId !== p.id;
  }

  /** Count down to a preview. A pointer that rests through the scroll
   *  grace still previews — the timer defers to the end of the grace
   *  instead of dropping, so one scroll-stop costs at most one preview. */
  function schedule(p: MotionPattern, delay: number, honourScroll: boolean) {
    clearHoverTimer();
    hoverPendingId = p.id;
    hoverTimer = setTimeout(() => {
      const left = honourScroll ? suppressUntil - Date.now() : 0;
      if (left > 0) {
        schedule(p, left, honourScroll);
        return;
      }
      hoverTimer = null;
      hoverPendingId = null;
      void app.previewMotionPattern(p.id);
    }, delay);
  }

  /** Hover to try — armed by the pointer MOVING inside the row, not by
   *  entering it, so a list scrolling under a still pointer arms nothing
   *  (F14). The kept row doesn't preview (click replays it, and a stray
   *  hover must not reset a scrub in progress); two-target rows have
   *  nothing to play. */
  function hoverMove(p: MotionPattern) {
    if (!canPreview(p)) return;
    if (app.motion.previewingId === p.id) return; // already on the page
    if (hoverPendingId === p.id && hoverTimer != null) return; // counting down
    schedule(p, HOVER_DELAY, true);
  }

  /** Keyboard: focus previews the same way, scroll grace or not — a Tab
   *  that scrolls the row into view is a deliberate move. */
  function focusStart(p: MotionPattern) {
    if (!canPreview(p)) return;
    schedule(p, HOVER_DELAY, false);
  }

  function hoverEnd(p: MotionPattern) {
    clearHoverTimer();
    if (app.motion.previewingId === p.id) void app.endMotionPreview();
  }

  /** A chip is a click to hear it, so it re-arms even after a hover
   *  preview left nothing live (setMotionStaggerStep only re-arms a
   *  running rehearsal). */
  function chooseStep(ms: number) {
    app.setMotionStaggerStep(ms);
    if (!app.motion.rehearsing) void app.rehearseMotion(true);
  }

  function onScrub(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    void app.seekMotion(v);
  }
</script>

<section class="space-y-3">
  <div class="flex items-center justify-between gap-2">
    <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">Motion</h2>
    <span class="text-[10px] font-mono text-ink-400 dark:text-night-mute truncate max-w-[55%]">
      {app.motion.system.name}
    </span>
  </div>

  {#if app.motion.error}
    <div
      bind:this={errorBanner}
      class="scroll-mt-14 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[11.5px] text-red-700 dark:text-red-300 leading-snug"
    >
      <p class="flex-1 min-w-0 break-words">{app.motion.error}</p>
      <button
        class="shrink-0 text-red-500 hover:text-red-700 dark:hover:text-red-200 leading-none px-1"
        aria-label="Dismiss error"
        onclick={() => (app.motion.error = null)}>✕</button
      >
    </div>
  {/if}

  {#if !picked}
    <!-- The whole body is the instruction card: the page is already in
         pick mode. Esc on the page lands here as picking = null, and the
         text link re-arms it. -->
    <EmptyState
      title="Click the element to animate."
      hint={app.motion.picking ? "Esc leaves pick mode." : "Pick mode is off."}
      compact
      class="rounded-md border border-dashed border-brand-pink/60 bg-brand-pink/5"
    >
      {#snippet action()}
        {#if app.motion.picking}
          <button
            class="text-[11px] underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
            onclick={() => void app.cancelMotionPick()}>Cancel</button
          >
        {:else}
          <button
            class="text-[11px] underline text-brand-pink dark:text-brand-pink-light hover:text-brand-pink/80"
            onclick={() => pick("start")}>Pick on page</button
          >
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <!-- Target chip ------------------------------------------------------ -->
    {#if app.motion.picking === "start"}
      <div
        class="rounded-md border border-brand-pink/60 bg-brand-pink/5 p-2.5 space-y-1.5 text-center"
      >
        <p class="text-[11.5px] text-ink-900 dark:text-night-text">Click the element to animate.</p>
        <p class="text-[10.5px] text-ink-400 dark:text-night-mute">Esc cancels.</p>
        <button
          class="text-[11px] underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
          onclick={() => void app.cancelMotionPick()}>Cancel</button
        >
      </div>
    {:else}
      <div
        class="flex items-center gap-2 rounded-md border border-ink-200 dark:border-night-line px-2 py-1.5"
      >
        <span
          class="flex-1 min-w-0 truncate text-[11px] text-ink-700 dark:text-night-dim"
          title={picked.selector}>{chipLabel(picked)}</span
        >
        <span class="shrink-0 text-[10px] text-ink-400 dark:text-night-mute">
          {Math.round(picked.boundingRect.width)}×{Math.round(picked.boundingRect.height)}
        </span>
        <button
          class="shrink-0 text-[10.5px] underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
          onclick={() => pick("start")}>re-pick</button
        >
        <button
          class="shrink-0 text-ink-400 hover:text-ink-700 dark:hover:text-night-text leading-none px-1"
          aria-label="Clear target"
          onclick={clearTarget}>✕</button
        >
      </div>
    {/if}

    <!-- Rows ------------------------------------------------------------- -->
    {#snippet patternRow(p: MotionPattern)}
      {@const kept = app.motion.patternId === p.id}
      {@const previewing = app.motion.previewingId === p.id}
      {@const live = app.motion.rehearsing && (previewing || (kept && !app.motion.previewingId))}
      {@const atEnd = app.motion.total > 0 && app.motion.position >= app.motion.total}
      <div
        class="rounded-md border transition-colors {kept ? 'bg-brand-pink/5' : ''}"
        class:border-brand-pink={kept || previewing}
        class:border-dashed={previewing && !kept}
        class:border-ink-200={!kept && !previewing}
        class:dark:border-night-line={!kept && !previewing}
      >
        <button
          class="w-full text-left flex items-start gap-1.5 px-2 py-1.5"
          aria-pressed={kept}
          aria-labelledby="motion-row-{p.id}"
          onclick={() => keep(p)}
          onmousemove={() => hoverMove(p)}
          onmouseleave={() => hoverEnd(p)}
          onfocus={() => focusStart(p)}
          onblur={() => hoverEnd(p)}
        >
          <span
            class="shrink-0 w-3 text-[10px] leading-[15px] text-brand-pink dark:text-brand-pink-light"
            aria-hidden="true">{kept ? "▶" : ""}</span
          >
          <span class="flex-1 min-w-0">
            <span
              id="motion-row-{p.id}"
              class="block text-[11.5px] font-semibold text-ink-900 dark:text-night-text"
            >
              {p.name}
            </span>
            <span class="block text-[10.5px] text-ink-500 dark:text-night-mute leading-snug">
              {p.blurb}
            </span>
            <span
              class="block mt-0.5 text-[9.5px] font-mono tabular-nums text-ink-400 dark:text-night-mute"
            >
              {#if live}
                {#if previewing}
                  Previewing on page · {Math.round(app.motion.position)} / {app.motion.total} ms
                {:else if app.motion.playing}
                  Playing · {Math.round(app.motion.position)} / {app.motion.total} ms
                {:else if atEnd}
                  Played · {app.motion.total} ms
                {:else}
                  Paused · {Math.round(app.motion.position)} / {app.motion.total} ms
                {/if}
              {:else}
                <!-- Resting: the kept row shows what Tune resolved to (F11). -->
                {p.targets === 2 ? "needs a destination · " : ""}{kept && timing
                  ? timing.duration
                  : (app.motion.system.durations[p.duration] ?? "?")} ms · {kept && timing
                  ? timing.easingToken
                  : p.easing}
              {/if}
            </span>
          </span>
        </button>

        {#if kept && p.children}
          <!-- Stagger as three named steps, in the row itself. -->
          <div
            class="flex flex-wrap items-center gap-1 px-2 pb-1.5"
            role="group"
            aria-label="Stagger step"
          >
            {#each stepChoices as c (c.key)}
              <button
                class="px-2 py-0.5 rounded border text-[10px] font-mono"
                class:border-brand-pink={app.motion.staggerStep === c.ms}
                class:text-brand-pink={app.motion.staggerStep === c.ms}
                class:border-ink-200={app.motion.staggerStep !== c.ms}
                class:dark:border-night-line={app.motion.staggerStep !== c.ms}
                class:text-ink-500={app.motion.staggerStep !== c.ms}
                aria-pressed={app.motion.staggerStep === c.ms}
                onclick={() => chooseStep(c.ms)}>{c.key} · {c.ms}ms</button
              >
            {/each}
            {#if app.motion.childCount > 0}
              <span class="ml-auto text-[9.5px] font-mono text-ink-400 dark:text-night-mute">
                {app.motion.childCount} children
              </span>
            {/if}
          </div>
          {#if app.motion.staggerClamped}
            <p class="px-2 pb-1.5 text-[10.5px] text-amber-700 dark:text-amber-400 leading-snug">
              Stagger shortened to {app.motion.effectiveStep}ms so all {app.motion.childCount} land
              within {app.motion.system.stagger.maxTotal}ms.
            </p>
          {/if}
        {/if}

        {#if kept && p.targets === 2}
          <!-- Destination, for the two patterns that take one. The
               coming-soon note lives in Tune, not here (F22). -->
          <div class="px-2 pb-1.5">
            {#if app.motion.destTarget}
              <div class="flex items-center gap-1.5 text-[10.5px] text-ink-700 dark:text-night-dim">
                <span class="shrink-0 text-ink-400 dark:text-night-mute" aria-hidden="true">→</span>
                <span class="flex-1 min-w-0 truncate" title={app.motion.destTarget.selector}
                  >{chipLabel(app.motion.destTarget)}</span
                >
                <button
                  class="shrink-0 underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
                  aria-label="Re-pick destination"
                  onclick={() => pick("end")}>re-pick</button
                >
                <button
                  class="shrink-0 text-ink-400 hover:text-ink-700 dark:hover:text-night-text leading-none px-1"
                  aria-label="Clear destination"
                  onclick={() => app.clearMotionTarget("end")}>✕</button
                >
              </div>
            {:else if app.motion.picking === "end"}
              <p class="text-[11px] text-ink-900 dark:text-night-text">
                Click what it opens into.
                <span class="text-ink-400 dark:text-night-mute">Esc cancels.</span>
              </p>
            {:else}
              <button
                class="w-full rounded-md border border-dashed border-ink-300 dark:border-night-line text-ink-600 dark:text-night-dim py-1 text-[11px] hover:border-brand-pink hover:text-brand-pink"
                onclick={() => pick("end")}>Click what it opens into</button
              >
            {/if}
          </div>
        {/if}
      </div>
    {/snippet}

    <div class="space-y-1.5">
      <!-- The kept row sits above the heading; "Try another" heads only
           the alternatives (F13). -->
      {#if pattern}
        {@render patternRow(pattern)}
      {/if}

      <div class="flex items-baseline justify-between gap-2">
        <p class="text-[10px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
          {pattern ? "Try another" : "Suggested for this element"}
        </p>
        <span class="text-[10.5px] text-ink-500 dark:text-night-mute whitespace-nowrap">
          Hover to try · click to keep
        </span>
      </div>

      {#if suggestedOthers.length}
        <div class="space-y-1">
          {#each suggestedOthers as p (p.id)}{@render patternRow(p)}{/each}
        </div>
      {/if}

      {#if restOthers.length}
        {#if suggestedOthers.length}
          <button
            class="text-[11px] underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
            onclick={() => (app.motion.showAll = !app.motion.showAll)}
          >
            {app.motion.showAll ? "Hide" : "Show all"} patterns ({restOthers.length})
          </button>
        {/if}
        {#if app.motion.showAll || !suggestedOthers.length}
          <div class="space-y-1">
            {#each restOthers as p (p.id)}{@render patternRow(p)}{/each}
          </div>
        {/if}
      {/if}
    </div>

    <!-- Tune ------------------------------------------------------------- -->
    {#if pattern}
      <details
        class="rounded-md border border-ink-200 dark:border-night-line"
        bind:open={app.motion.tuneOpen}
      >
        <summary
          class="cursor-pointer select-none px-2.5 py-1.5 text-[11px] text-ink-700 dark:text-night-dim hover:text-ink-900 dark:hover:text-night-text"
        >
          Tune · reverse, speed, scrub, loop, trigger, tokens, note
        </summary>
        <div class="space-y-2 px-2.5 pb-2.5">
          {#if blocked}
            <p class="text-[11px] text-amber-700 dark:text-amber-400 leading-snug">{blocked}</p>
          {:else}
            <div class="flex flex-wrap items-center gap-1.5">
              <button
                class="px-2 py-1 rounded-md border border-ink-200 dark:border-night-line text-[11px] text-ink-600 dark:text-night-dim hover:border-brand-pink disabled:opacity-50"
                onclick={() => void app.reverseMotion()}
                disabled={!app.motion.rehearsing || app.motion.playing}>Reverse</button
              >
              <button
                class="px-2 py-1 rounded-md border border-ink-200 dark:border-night-line text-[11px] text-ink-600 dark:text-night-dim hover:border-brand-pink disabled:opacity-50"
                onclick={() => void app.stopMotionRehearsal()}
                disabled={!app.motion.rehearsing}>Reset</button
              >
              <label class="flex items-center gap-1 text-[10.5px] text-ink-500 dark:text-night-mute">
                <input type="checkbox" class="dark:[color-scheme:dark]" bind:checked={app.motion.loop} /> Loop
              </label>
              <span class="ml-auto flex items-center gap-1" role="group" aria-label="Playback speed">
                {#each SPEEDS as s (s)}
                  <button
                    class="px-2 py-0.5 rounded border text-[10px] font-mono"
                    class:border-brand-pink={app.motion.speed === s}
                    class:text-brand-pink={app.motion.speed === s}
                    class:border-ink-200={app.motion.speed !== s}
                    class:dark:border-night-line={app.motion.speed !== s}
                    class:text-ink-500={app.motion.speed !== s}
                    aria-pressed={app.motion.speed === s}
                    onclick={() => app.setMotionSpeed(s)}>{s}×</button
                  >
                {/each}
              </span>
            </div>

            <input
              type="range"
              class="w-full accent-brand-pink dark:[color-scheme:dark]"
              min="0"
              max={Math.max(1, app.motion.total)}
              value={app.motion.position}
              disabled={!app.motion.rehearsing}
              aria-label="Scrub transition"
              oninput={onScrub}
            />
          {/if}

          {#if showTriggers && pattern}
            <div class="flex flex-wrap gap-1" role="group" aria-label="Trigger">
              {#each pattern.triggers as t (t)}
                <button
                  class="px-2 py-1 rounded-md border text-[10.5px]"
                  class:border-brand-pink={app.motion.trigger === t}
                  class:text-brand-pink={app.motion.trigger === t}
                  class:border-ink-200={app.motion.trigger !== t}
                  class:dark:border-night-line={app.motion.trigger !== t}
                  class:text-ink-600={app.motion.trigger !== t}
                  class:dark:text-night-dim={app.motion.trigger !== t}
                  aria-pressed={app.motion.trigger === t}
                  onclick={() => app.setMotionTrigger(t as MotionTrigger)}
                >
                  {TRIGGER_LABELS[t]}
                </button>
              {/each}
            </div>
          {/if}

          <div class="flex items-center gap-1.5">
            <select
              class="flex-1 min-w-0 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-2 py-1 text-[11px] text-ink-900 dark:text-night-text dark:[color-scheme:dark]"
              aria-label="Duration token"
              value={curDuration}
              onchange={(e) =>
                app.setMotionToken("duration", (e.currentTarget as HTMLSelectElement).value)}
            >
              {#if !durationTokens.includes(curDuration)}
                <option value={curDuration} disabled>{curDuration} · not in system</option>
              {/if}
              {#each durationTokens as t (t)}
                <option value={t}>{t} · {app.motion.system.durations[t]}ms</option>
              {/each}
            </select>
            <select
              class="flex-1 min-w-0 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-2 py-1 text-[11px] text-ink-900 dark:text-night-text dark:[color-scheme:dark]"
              aria-label="Easing token"
              value={curEasing}
              onchange={(e) =>
                app.setMotionToken("easing", (e.currentTarget as HTMLSelectElement).value)}
            >
              {#if !easingTokens.includes(curEasing)}
                <option value={curEasing} disabled>{curEasing} · not in system</option>
              {/if}
              {#each easingTokens as t (t)}
                <option value={t}>{t}</option>
              {/each}
            </select>
          </div>
          {#if timing?.fallback}
            <p class="text-[10.5px] text-amber-700 dark:text-amber-400 leading-snug">
              That token isn't in the active motion system — falling back to {timing.duration}ms.
            </p>
          {/if}

          <label class="flex items-center gap-1.5 text-[10.5px] text-ink-500 dark:text-night-mute">
            <input
              type="checkbox"
              class="dark:[color-scheme:dark]"
              checked={app.motion.reduced}
              onchange={(e) => app.setMotionReduced((e.currentTarget as HTMLInputElement).checked)}
            />
            Preview the reduced-motion fallback
          </label>

          <input
            class="w-full rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-2 py-1 text-[11.5px] text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute"
            placeholder="What you noticed at quarter speed (optional)"
            aria-label="Note for the agent"
            bind:value={app.motion.note}
          />
        </div>
      </details>

      <!-- Apply -------------------------------------------------------- -->
      <div class="space-y-1.5">
        <button
          class="w-full px-4 py-1.5 rounded-md text-[12px] font-semibold bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-50"
          disabled
          title="Applying to source is coming soon"
        >
          Apply with agent
        </button>
        <p class="text-[10px] text-ink-400 dark:text-night-mute leading-snug text-center">
          Trying patterns costs nothing. Apply (coming soon) writes named tokens into your source
          and always adds a reduced-motion fallback.
        </p>
      </div>
    {/if}
  {/if}
</section>
