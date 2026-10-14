<script lang="ts">
  // Phase 25 — Motion module. Element first, exactly like Design
  // Variants: pick the element, the catalog re-ranks to what that element
  // can plausibly do, then rehearse it on the real page — replay, speed,
  // scrub — before handing the agent named tokens.
  //
  // Everything in this tab up to Apply is in-page Web Animations with no
  // companion attached.

  import type { AnnotationTarget } from "@pinta/shared";
  import { app } from "../lib/state.svelte.js";
  import EmptyState from "../lib/EmptyState.svelte";
  import {
    MOTION_PATTERNS,
    TRIGGER_LABELS,
    type MotionPattern,
    type MotionTrigger,
  } from "../lib/motion.js";

  const SPEEDS = [1, 0.5, 0.25];

  const ranked = $derived(app.motionRanked);
  const pattern = $derived(app.motionPattern);
  const timing = $derived(app.motionTiming);
  const blocked = $derived(app.motionBlockedReason);
  const picked = $derived(app.motion.pickedTarget);

  /** Short, clickable form of a selector — the tail is the readable bit. */
  function shortSelector(sel: string): string {
    const tail = sel.split(">").pop()?.trim() ?? sel;
    return tail.length > 34 ? `…${tail.slice(-33)}` : tail;
  }

  /** What the chip says: the element's own text when it has any, else
   *  the selector tail. The full selector always rides in the title. */
  function chipLabel(t: AnnotationTarget): string {
    const text = t.nearbyText?.[0]?.trim();
    return text ? (text.length > 40 ? `${text.slice(0, 39)}…` : text) : shortSelector(t.selector);
  }

  /** The error banner mounts at the top; failures are triggered from the
   *  Rehearse box well below it, so bring it into view when it appears. */
  let errorBanner = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (app.motion.error && errorBanner) errorBanner.scrollIntoView?.({ block: "nearest" });
  });

  /** The primary button: Play / Replay / Playing… (Reverse is its own). */
  const primaryLabel = $derived(
    app.motion.playing
      ? "Playing…"
      : app.motion.rehearsing && app.motion.total > 0 && app.motion.position >= app.motion.total
        ? "Replay"
        : "Play",
  );

  const durationTokens = $derived(Object.keys(app.motion.system.durations));
  const easingTokens = $derived(Object.keys(app.motion.system.easings));
  /** The token each select shows — may be one the system doesn't have. */
  const curDuration = $derived(timing?.durationToken ?? pattern?.duration ?? "");
  const curEasing = $derived(timing?.easingToken ?? pattern?.easing ?? "");

  /** Triggers are an effects concept; a nav-only pattern doesn't ask. */
  const showTriggers = $derived(!!pattern && pattern.triggers.length > 1);
  const showStagger = $derived(!!pattern?.children);

  function pick(role: "start" | "end") {
    void app.startMotionPick(role);
  }

  /** Single-select: clicking the chosen row keeps it chosen. */
  function choose(p: MotionPattern) {
    if (app.motion.patternId !== p.id) app.selectMotionPattern(p.id);
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
      class="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[11.5px] text-red-700 dark:text-red-300 leading-snug"
    >
      <p class="flex-1 min-w-0 break-words">{app.motion.error}</p>
      <button
        class="shrink-0 text-red-500 hover:text-red-700 dark:hover:text-red-200 leading-none px-1"
        aria-label="Dismiss error"
        onclick={() => (app.motion.error = null)}>✕</button
      >
    </div>
  {/if}

  <!-- 1 · Target ---------------------------------------------------------- -->
  <div class="space-y-1.5">
    <p class="text-[10px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
      Target
    </p>

    {#if app.motion.picking}
      <div
        class="rounded-md border border-brand-pink/60 bg-brand-pink/5 p-2.5 space-y-1.5 text-center"
      >
        <p class="text-[11.5px] text-ink-900 dark:text-night-text">
          {app.motion.picking === "end"
            ? "Click what it opens into."
            : "Click the element to animate."}
        </p>
        <p class="text-[10.5px] text-ink-400 dark:text-night-mute">Esc cancels.</p>
        <button
          class="text-[11px] underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
          onclick={() => void app.cancelMotionPick()}>Cancel</button
        >
      </div>
    {:else if picked}
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
          onclick={() => app.clearMotionTarget("start")}>✕</button
        >
      </div>
    {:else}
      <button
        class="w-full rounded-md border border-dashed border-brand-pink text-brand-pink dark:text-brand-pink-light py-2 text-[11.5px] font-semibold hover:bg-brand-pink/5"
        onclick={() => pick("start")}>Pick on page</button
      >
    {/if}
  </div>

  <!-- 2 · Pattern ---------------------------------------------------------- -->
  {#snippet patternRow(p: MotionPattern)}
    <button
      class="w-full text-left flex items-start gap-2 rounded-md border px-2 py-1.5 transition-colors"
      class:border-brand-pink={app.motion.patternId === p.id}
      class:bg-brand-pink5={app.motion.patternId === p.id}
      class:border-ink-200={app.motion.patternId !== p.id}
      class:dark:border-night-line={app.motion.patternId !== p.id}
      aria-pressed={app.motion.patternId === p.id}
      onclick={() => choose(p)}
    >
      <span class="flex-1 min-w-0">
        <span class="block text-[11.5px] font-semibold text-ink-900 dark:text-night-text">
          {p.name}
        </span>
        <span class="block text-[10.5px] text-ink-500 dark:text-night-mute leading-snug">
          {p.blurb}
        </span>
        <span class="block mt-0.5 text-[9.5px] font-mono text-ink-400 dark:text-night-mute">
          {p.targets === 2 ? "Needs a destination · " : ""}{app.motion.system.durations[p.duration] ??
            "?"} ms · {p.easing}{p.rehearsable ? "" : " · preview coming"}
        </span>
      </span>
    </button>
  {/snippet}

  <div class="space-y-1.5">
    <p class="text-[10px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
      {picked ? "Suggested for this element" : "Patterns"}
    </p>

    {#if !picked}
      <EmptyState
        title="Nothing picked yet"
        hint="Pick an element and this list re-orders to what it can actually do — a figure suggests Count up, a grid suggests Stagger."
        compact
      />
    {/if}

    {#if ranked.suggested.length}
      <div class="space-y-1">
        {#each ranked.suggested as p (p.id)}{@render patternRow(p)}{/each}
      </div>
    {/if}

    {#if ranked.rest.length}
      {#if ranked.suggested.length}
        <button
          class="text-[11px] underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
          onclick={() => (app.motion.showAll = !app.motion.showAll)}
        >
          {app.motion.showAll ? "Hide" : "Show all"} patterns ({ranked.rest.length})
        </button>
      {/if}
      {#if app.motion.showAll || !ranked.suggested.length}
        <div class="space-y-1">
          {#each ranked.rest as p (p.id)}{@render patternRow(p)}{/each}
        </div>
      {/if}
    {/if}
  </div>

  <!-- 3 · Destination (only the two patterns that take one) ---------------- -->
  {#if pattern?.targets === 2}
    <div class="space-y-1.5">
      <p class="text-[10px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
        Destination
      </p>
      {#if app.motion.destTarget}
        <div
          class="flex items-center gap-2 rounded-md border border-ink-200 dark:border-night-line px-2 py-1.5"
        >
          <span
            class="flex-1 min-w-0 truncate text-[11px] text-ink-700 dark:text-night-dim"
            title={app.motion.destTarget.selector}>{chipLabel(app.motion.destTarget)}</span
          >
          <button
            class="shrink-0 text-[10.5px] underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text"
            onclick={() => pick("end")}>re-pick</button
          >
          <button
            class="shrink-0 text-ink-400 hover:text-ink-700 dark:hover:text-night-text leading-none px-1"
            aria-label="Clear destination"
            onclick={() => app.clearMotionTarget("end")}>✕</button
          >
        </div>
      {:else}
        <button
          class="w-full rounded-md border border-dashed border-ink-300 dark:border-night-line text-ink-600 dark:text-night-dim py-1.5 text-[11px] hover:border-brand-pink hover:text-brand-pink"
          onclick={() => pick("end")}>Click what it opens into</button
        >
      {/if}
      <p class="text-[10px] text-ink-400 dark:text-night-mute leading-snug">
        Used when the agent applies it.
      </p>
    </div>
  {/if}

  <!-- 4 · Trigger ---------------------------------------------------------- -->
  {#if showTriggers && pattern}
    <div class="space-y-1.5">
      <p class="text-[10px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
        Trigger
      </p>
      <div class="flex flex-wrap gap-1">
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
    </div>
  {/if}

  <!-- 5 · Rehearsal -------------------------------------------------------- -->
  {#if pattern}
    <div class="space-y-2 rounded-md border border-ink-200 dark:border-night-line p-2.5">
      <div class="flex items-center justify-between gap-2">
        <p
          class="text-[10px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium"
        >
          Rehearse
        </p>
        <span class="text-[10px] font-mono text-ink-400 dark:text-night-mute tabular-nums">
          {Math.round(app.motion.position)} / {app.motion.total || timing?.duration || 0} ms
        </span>
      </div>

      {#if blocked}
        <p class="text-[11px] text-amber-700 dark:text-amber-400 leading-snug">{blocked}</p>
      {:else}
        <div class="flex items-center gap-1.5">
          <button
            class="px-3 py-1 rounded-md text-[11.5px] font-semibold bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-50"
            disabled={app.motion.playing}
            onclick={() => void app.playMotion()}
          >
            {primaryLabel}
          </button>
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
        </div>

        <div class="flex items-center gap-1" role="group" aria-label="Playback speed">
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
          <span class="ml-auto text-[9.5px] text-ink-400 dark:text-night-mute">
            Playback speed — doesn't change the duration
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

        {#if showStagger}
          <div class="space-y-1">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[10px] text-ink-500 dark:text-night-mute">
                Stagger step · {app.motion.staggerStep}ms
              </span>
              <span class="text-[9.5px] font-mono text-ink-400 dark:text-night-mute">
                {app.motion.childCount} children
              </span>
            </div>
            <input
              type="range"
              class="w-full accent-brand-pink dark:[color-scheme:dark]"
              min="10"
              max="160"
              step="10"
              value={app.motion.staggerStep}
              aria-label="Stagger step"
              oninput={(e) =>
                app.setMotionStaggerStep(Number((e.currentTarget as HTMLInputElement).value))}
            />
            {#if app.motion.staggerClamped}
              <p class="text-[10.5px] text-amber-700 dark:text-amber-400 leading-snug">
                Step compressed so the whole sequence stays under
                {app.motion.system.stagger.maxTotal}ms — ran at {app.motion.effectiveStep}ms.
              </p>
            {/if}
          </div>
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
      {/if}
    </div>

    <!-- 6 · Tokens --------------------------------------------------------- -->
    <div class="space-y-1.5">
      <p class="text-[10px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
        Tokens
      </p>
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
    </div>

    <!-- 7 · Note + apply --------------------------------------------------- -->
    <div class="space-y-1.5">
      <input
        class="w-full rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-2 py-1 text-[11.5px] text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute"
        placeholder="What you noticed at quarter speed (optional)"
        aria-label="Note for the agent"
        bind:value={app.motion.note}
      />
      <button
        class="w-full px-4 py-1.5 rounded-md text-[12px] font-semibold bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-50"
        disabled
        title="Applying to source is coming soon"
      >
        Apply with agent
      </button>
      <p class="text-[10px] text-ink-400 dark:text-night-mute leading-snug text-center">
        Rehearsal runs with no agent. Writing it into source arrives next —
        reduced motion will always be required.
      </p>
    </div>
  {/if}
</section>
