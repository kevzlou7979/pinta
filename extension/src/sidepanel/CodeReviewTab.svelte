<script lang="ts">
  // Phase 23 — Code Review module. The agent deals the current change
  // set as a deck of plain-words cards; this tab plays them one at a
  // time — Pass (P) / Fail (F) / Learn (L), ←/→ to navigate, a streak,
  // and a grade at the end. Failed cards get a one-click agent fix.

  import { app } from "../lib/state.svelte.js";
  import ChatSheet from "./ChatSheet.svelte";
  import MicButton from "../lib/voice/MicButton.svelte";
  import {
    gradeBlurb,
    gradeFor,
    scoreRun,
    splitDiffLines,
    type ReviewCard,
  } from "../lib/code-review.js";

  const connected = $derived(app.connectionStatus === "connected");
  const run = $derived(app.review.currentRun);
  const pending = $derived(app.review.pending);

  const score = $derived(
    run ? scoreRun(run.cards, app.review.verdicts) : null,
  );
  const deckDone = $derived(
    !!run && run.cards.length > 0 && run.cards.every((c) => app.review.verdicts[c.id]),
  );
  const currentCard = $derived.by<ReviewCard | null>(() => {
    if (!run || deckDone) return null;
    return run.cards[Math.min(app.review.deckIndex, run.cards.length - 1)] ?? null;
  });
  const grade = $derived(score && deckDone ? gradeFor(score.pct) : null);

  const learnCard = $derived(
    run?.cards.find((c) => c.id === app.review.learnCardId) ?? null,
  );

  // Fail-note editor state (per current card, session-local).
  let noteOpen = $state(false);
  let noteText = $state("");
  let noteEl = $state<HTMLInputElement | null>(null);

  // Optional focus prompt — with a topic the agent deals the RELEVANT
  // CODE for it (e.g. "MFA authentication") instead of the git diff.
  let topicText = $state("");
  let topicEl = $state<HTMLInputElement | null>(null);

  function deal(): void {
    void app.gatherReview(topicText);
  }

  function startFail(): void {
    noteOpen = true;
    noteText = "";
  }

  function confirmFail(cardId: string): void {
    app.failCard(cardId, noteText);
    noteOpen = false;
    noteText = "";
  }

  function navigate(delta: number): void {
    if (!run) return;
    noteOpen = false;
    app.setDeckIndex(app.review.deckIndex + delta);
  }

  // Keyboard play — the component only exists while its tab is active,
  // so a window listener is safely scoped. Ignore typing surfaces, the
  // Learn sheet, the note editor (except Esc), and modifier combos.
  function onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ae = document.activeElement as HTMLElement | null;
    const typing =
      ae?.tagName === "INPUT" || ae?.tagName === "TEXTAREA" || ae?.isContentEditable;
    if (app.review.learnCardId) return; // ChatSheet owns the keyboard
    if (noteOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        noteOpen = false;
      } else if (e.key === "Enter" && !e.shiftKey && currentCard) {
        e.preventDefault();
        confirmFail(currentCard.id);
      }
      return;
    }
    if (typing) return;
    if (!currentCard) return;
    const k = e.key.toLowerCase();
    if (k === "p") {
      e.preventDefault();
      app.passCard(currentCard.id);
    } else if (k === "f") {
      e.preventDefault();
      startFail();
    } else if (k === "l") {
      e.preventDefault();
      app.openReviewLearn(currentCard.id);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      navigate(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      navigate(-1);
    }
  }

  function riskClasses(risk?: string): string {
    if (risk === "high")
      return "border-red-300 bg-red-50 text-red-700 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-300";
    if (risk === "medium")
      return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-300";
    return "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300";
  }
</script>

<svelte:window onkeydown={onKey} />

<section class="space-y-3">
  <div class="flex items-center justify-between gap-2">
    <h2 class="text-sm font-semibold text-ink-900 dark:text-night-text">
      Code Review
    </h2>
    {#if run}
      <button
        type="button"
        class="text-[11px] underline text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text disabled:opacity-50"
        disabled={!connected || !!pending}
        onclick={deal}
        title="Deal a fresh deck (uses the focus prompt when set)"
      >
        Deal again
      </button>
    {/if}
  </div>

  {#if !pending}
    <!-- Optional focus: with a topic the deck reviews the code RELATED
         to it (agent greps the project), instead of the git diff. -->
    <div class="flex items-center gap-1.5">
      <input
        type="text"
        class="flex-1 min-w-0 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-2 py-1 text-[11.5px] text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute"
        placeholder={'Focus (optional) — e.g. "MFA authentication" reviews that code instead of the diff'}
        bind:this={topicEl}
        bind:value={topicText}
        onkeydown={(e) => {
          if (e.key === "Enter" && connected && !pending) deal();
        }}
      />
      {#if app.voiceReady}
        <MicButton el={topicEl} lang={app.voiceLang} />
      {/if}
      {#if topicText.trim() !== ""}
        <button
          type="button"
          class="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-50"
          disabled={!connected}
          onclick={deal}
        >
          Review topic
        </button>
      {/if}
    </div>
  {/if}

  {#if !connected}
    <p class="text-[11.5px] text-amber-700 dark:text-amber-400 leading-snug">
      Connect a companion (run <code>pinta-companion .</code> in your project)
      so the agent can gather your changes.
    </p>
  {/if}

  {#if app.review.error}
    <div
      class="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-950/30 p-2 text-[11.5px] text-red-700 dark:text-red-300 leading-snug"
      role="alert"
    >
      <p class="flex-1 min-w-0 break-words">{app.review.error}</p>
      <button
        type="button"
        class="shrink-0 text-red-500 hover:text-red-700 dark:hover:text-red-200 leading-none px-1"
        onclick={() => (app.review.error = null)}
        aria-label="Dismiss"
        title="Dismiss"
      >✕</button>
    </div>
  {/if}

  {#if pending}
    <div class="rounded-md border border-ink-200 dark:border-night-line p-4 text-center space-y-2">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="animate-spin text-brand-pink dark:text-brand-pink-light mx-auto">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <p class="text-xs text-ink-600 dark:text-night-dim">
        {pending?.topic
          ? `Finding the "${pending.topic}" code to review…`
          : "Dealing the cards from your change set…"}
      </p>
      <button
        type="button"
        class="text-[11px] text-ink-500 dark:text-night-mute underline hover:text-ink-800 dark:hover:text-night-text"
        onclick={() => app.cancelReviewPending()}
      >
        Cancel
      </button>
    </div>
  {:else if !run}
    <div class="rounded-md border border-dashed border-ink-300 dark:border-night-line p-4 text-center space-y-3">
      <p class="text-[11.5px] text-ink-500 dark:text-night-mute leading-snug">
        Play your changes as a review deck — one card per logical change,
        in plain words. Reviews your uncommitted changes (or the last
        commit when the tree is clean) — or type a focus above, like
        "MFA authentication", to review that code instead.
      </p>
      <button
        type="button"
        class="px-4 py-1.5 rounded-md text-[12px] font-semibold bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-50"
        disabled={!connected}
        onclick={deal}
      >
        {topicText.trim() !== "" ? "Review this topic" : "Deal the cards"}
      </button>
      {#if app.review.stats.totalReviewed > 0}
        <p class="text-[10.5px] text-ink-400 dark:text-night-mute">
          {app.review.stats.totalReviewed} cards reviewed all-time · best
          streak {app.review.stats.bestStreak}
        </p>
      {/if}
    </div>
  {:else if deckDone && score}
    <!-- End card — the grade moment. -->
    <div class="rounded-md border border-ink-200 dark:border-night-line p-4 text-center space-y-2">
      <div class="text-5xl font-black text-brand-pink dark:text-brand-pink-light leading-none">
        {grade}
      </div>
      <p class="text-[12px] font-medium text-ink-900 dark:text-night-text">
        {grade ? gradeBlurb(grade) : ""}
      </p>
      <p class="text-[11px] text-ink-500 dark:text-night-mute">
        {score.passed} passed · {score.failed} failed · {score.pct}% ·
        best streak {app.review.stats.bestStreak}
      </p>
      <p class="text-[10.5px] text-ink-400 dark:text-night-mute">
        {app.review.stats.totalReviewed} cards reviewed all-time ·
        {app.review.stats.runsCompleted} decks completed
      </p>
      <button
        type="button"
        class="px-4 py-1.5 rounded-md text-[12px] font-semibold bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-50"
        disabled={!connected || !!pending}
        onclick={deal}
      >
        Review again
      </button>
    </div>
    {#if score.failed > 0}
      <p class="text-[11px] uppercase tracking-wide text-ink-500 dark:text-night-mute font-medium">
        Failed cards
      </p>
      {#each run.cards.filter((c) => app.review.verdicts[c.id] === "fail") as c (c.id)}
        {@const fix = app.review.fixes[c.id]}
        {@const fixing = !!app.review.pendingFix[c.id]}
        <div class="rounded-md border border-ink-200 dark:border-night-line p-2.5 space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <p class="text-[12px] font-semibold text-ink-900 dark:text-night-text truncate">
              {c.title}
            </p>
            <span class="shrink-0 text-[10px] font-mono text-ink-400 dark:text-night-mute truncate max-w-[45%]" title={c.file}>
              {c.file}
            </span>
          </div>
          {#if app.review.failNotes[c.id]}
            <p class="text-[11px] italic text-ink-600 dark:text-night-dim">
              “{app.review.failNotes[c.id]}”
            </p>
          {/if}
          {#if fix}
            <div class="rounded border border-emerald-300 bg-emerald-50 dark:border-emerald-800/50 dark:bg-emerald-950/30 p-2">
              <p class="text-[11px] text-emerald-800 dark:text-emerald-300">{fix.summary}</p>
              {#each fix.files as f (f.path)}
                <p class="text-[10px] font-mono text-emerald-700 dark:text-emerald-400 truncate" title={f.path}>
                  {f.path}{f.note ? ` — ${f.note}` : ""}
                </p>
              {/each}
            </div>
          {:else}
            <button
              type="button"
              class="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-50 inline-flex items-center gap-1.5"
              disabled={!connected || fixing}
              onclick={() => void app.sendReviewFix(c.id)}
            >
              {#if fixing}
                <svg class="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                Fixing…
              {:else}
                Fix with agent
              {/if}
            </button>
          {/if}
        </div>
      {/each}
    {/if}
  {:else if currentCard && score}
    <!-- Deck play -->
    <div class="flex items-center gap-2">
      <div class="flex-1 h-1.5 rounded-full bg-ink-100 dark:bg-night-alt overflow-hidden">
        <div
          class="h-full bg-brand-pink transition-all"
          style="width: {run.cards.length ? Math.round((score.reviewed / run.cards.length) * 100) : 0}%;"
        ></div>
      </div>
      <span class="text-[10.5px] tabular-nums text-ink-500 dark:text-night-mute">
        {score.reviewed}/{run.cards.length}
      </span>
      {#if app.review.streak >= 2}
        <span class="text-[10.5px] font-semibold text-brand-pink dark:text-brand-pink-light" title="Consecutive passes">
          ×{app.review.streak}
        </span>
      {/if}
      <span
        class="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-100 dark:bg-night-alt text-ink-500 dark:text-night-mute max-w-[140px] truncate"
        title={run.source === "topic"
          ? `Reviewing code related to: ${run.topic ?? "topic"}`
          : run.source === "last-commit"
            ? (run.commitRef ?? "last commit")
            : "uncommitted changes"}
      >
        {run.source === "topic"
          ? (run.topic ?? "topic")
          : run.source === "last-commit"
            ? "last commit"
            : "working tree"}
      </span>
    </div>
    {#if run.dropped > 0}
      <p class="text-[10.5px] text-amber-700 dark:text-amber-400">
        {run.dropped} smaller changes didn't fit this deck — commit or
        re-deal after fixing to see them.
      </p>
    {/if}

    {@const verdict = app.review.verdicts[currentCard.id]}
    <div
      class="rounded-md border overflow-hidden"
      class:border-emerald-400={verdict === "pass"}
      class:border-red-400={verdict === "fail"}
      class:border-ink-200={!verdict}
      class:dark:border-night-line={!verdict}
    >
      <div class="px-3 py-2 bg-ink-50 dark:bg-night-alt/50 border-b border-ink-200 dark:border-night-line space-y-1">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-[13px] font-semibold text-ink-900 dark:text-night-text">
            {currentCard.title}
          </h3>
          <div class="flex items-center gap-1.5 shrink-0">
            {#if currentCard.risk}
              <span class="text-[9.5px] uppercase font-semibold px-1.5 py-0.5 rounded-full border {riskClasses(currentCard.risk)}">
                {currentCard.risk}
              </span>
            {/if}
            {#if verdict}
              <span
                class="text-[9.5px] uppercase font-semibold px-1.5 py-0.5 rounded-full text-white"
                class:bg-emerald-500={verdict === "pass"}
                class:bg-red-500={verdict === "fail"}
              >
                {verdict}
              </span>
            {/if}
          </div>
        </div>
        <p class="text-[10.5px] font-mono text-ink-500 dark:text-night-mute truncate" title={currentCard.file}>
          {currentCard.file}
        </p>
        {#if currentCard.description}
          <p class="text-[11.5px] text-ink-700 dark:text-night-dim leading-snug">
            {currentCard.description}
          </p>
        {/if}
      </div>
      <!-- Diff pane — CSS-tinted unified diff, no highlighter dep. -->
      <pre class="m-0 p-2 text-[10.5px] leading-[1.5] font-mono overflow-x-auto bg-white dark:bg-night-card max-h-72 overflow-y-auto"><code>{#each splitDiffLines(currentCard.diff) as line, i (i)}<span
            class="block px-1 rounded-sm whitespace-pre"
            class:bg-emerald-50={line.kind === "add"}
            class:text-emerald-800={line.kind === "add"}
            class:dark:bg-emerald-950={line.kind === "add"}
            class:dark:text-emerald-300={line.kind === "add"}
            class:bg-red-50={line.kind === "del"}
            class:text-red-800={line.kind === "del"}
            class:dark:bg-red-950={line.kind === "del"}
            class:dark:text-red-300={line.kind === "del"}
            class:text-ink-400={line.kind === "hunk"}
            class:dark:text-night-mute={line.kind === "hunk"}
            class:font-semibold={line.kind === "hunk"}
            class:text-ink-700={line.kind === "ctx"}
            class:dark:text-night-dim={line.kind === "ctx"}
          >{line.text || " "}</span>{/each}</code></pre>

      {#if noteOpen}
        <div class="px-3 py-2 border-t border-ink-200 dark:border-night-line space-y-1.5">
          <div class="flex items-center gap-1.5">
            <input
              type="text"
              class="flex-1 min-w-0 rounded-md border border-ink-200 dark:border-night-line bg-white dark:bg-night-card px-2 py-1 text-[11.5px] text-ink-900 dark:text-night-text placeholder:text-ink-400 dark:placeholder:text-night-mute"
              placeholder="Why does it fail? (optional — guides the fix)"
              bind:this={noteEl}
              bind:value={noteText}
              onkeydown={(e) => {
                if (e.key === "Enter" && currentCard) confirmFail(currentCard.id);
                if (e.key === "Escape") noteOpen = false;
              }}
            />
            {#if app.voiceReady}
              <MicButton el={noteEl} lang={app.voiceLang} />
            {/if}
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-red-500 text-white hover:bg-red-600"
              onclick={() => confirmFail(currentCard.id)}
            >
              Fail it
            </button>
            <button
              type="button"
              class="text-[11px] underline text-ink-500 dark:text-night-mute"
              onclick={() => (noteOpen = false)}
            >
              Cancel
            </button>
          </div>
        </div>
      {:else}
        <div class="flex items-center gap-2 px-3 py-2 border-t border-ink-200 dark:border-night-line">
          <button
            type="button"
            class="flex-1 px-2.5 py-1.5 rounded-md text-[11.5px] font-semibold bg-emerald-500 text-white hover:bg-emerald-600"
            onclick={() => app.passCard(currentCard.id)}
          >
            Pass <kbd class="ml-1 text-[9px] opacity-70">P</kbd>
          </button>
          <button
            type="button"
            class="flex-1 px-2.5 py-1.5 rounded-md text-[11.5px] font-semibold bg-red-500 text-white hover:bg-red-600"
            onclick={startFail}
          >
            Fail <kbd class="ml-1 text-[9px] opacity-70">F</kbd>
          </button>
          <button
            type="button"
            class="px-2.5 py-1.5 rounded-md text-[11.5px] font-medium border border-ink-200 dark:border-night-line text-ink-600 dark:text-night-dim hover:text-brand-pink"
            onclick={() => app.openReviewLearn(currentCard.id)}
            title="Ask the agent how this change works"
          >
            Learn <kbd class="ml-1 text-[9px] opacity-70">L</kbd>
          </button>
          {#if verdict === "fail" && !app.review.fixes[currentCard.id]}
            <button
              type="button"
              class="px-2.5 py-1.5 rounded-md text-[11.5px] font-semibold bg-brand-pink text-white hover:bg-brand-pink/90 disabled:opacity-50 inline-flex items-center gap-1.5"
              disabled={!connected || !!app.review.pendingFix[currentCard.id]}
              onclick={() => void app.sendReviewFix(currentCard.id)}
            >
              {#if app.review.pendingFix[currentCard.id]}
                <svg class="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
              {/if}
              Fix
            </button>
          {/if}
        </div>
      {/if}
    </div>

    <div class="flex items-center justify-between">
      <button
        type="button"
        class="text-[11px] text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text disabled:opacity-40"
        disabled={app.review.deckIndex === 0}
        onclick={() => navigate(-1)}
      >
        ← Prev
      </button>
      <span class="text-[10px] text-ink-400 dark:text-night-mute">
        P pass · F fail · L learn · ← → browse
      </span>
      <button
        type="button"
        class="text-[11px] text-ink-500 dark:text-night-mute hover:text-ink-800 dark:hover:text-night-text disabled:opacity-40"
        disabled={app.review.deckIndex >= run.cards.length - 1}
        onclick={() => navigate(1)}
      >
        Next →
      </button>
    </div>
  {/if}
</section>

{#if learnCard}
  <ChatSheet
    open={!!app.review.learnCardId}
    contextHeader="Learning about"
    contextLabel={learnCard.title}
    contextSubLabel={learnCard.file}
    messages={app.review.cardChats[learnCard.id] ?? []}
    pending={!!app.review.pendingLearn[learnCard.id]}
    error={null}
    placeholder="Ask about this change…"
    greeting="I'll explain this change — how it works, where it's used, and a usage example. Ask me anything about it."
    quickPrompts={[
      { label: "Where is this used?", prompt: "Where is this code used?" },
      { label: "Usage example", prompt: "Show me a short usage example." },
      { label: "What could break?", prompt: "What could this change break?" },
    ]}
    onSend={(text) => void app.sendReviewLearn(learnCard.id, text)}
    onClose={() => app.openReviewLearn(null)}
  />
{/if}
