<script lang="ts">
  // Mic affordance for the Voice Command module. Drop it next to any
  // free-text field with the field element bound via `el`:
  //
  //   <textarea bind:this={commentEl} bind:value={comment}></textarea>
  //   {#if voiceReady}<MicButton el={commentEl} lang={voiceLang} />{/if}
  //
  // This component is used in TWO contexts: the side panel (normal DOM)
  // and the on-page overlay (an isolated shadow DOM styled only by an
  // injected stylesheet). Svelte's scoped <style> and Tailwind utilities
  // don't reach inside that shadow root — so we inject our own CSS into
  // whatever root node we mount in (`getRootNode()`), once per root.
  import { onMount } from "svelte";
  import { voice, type VoiceTarget } from "./controller";

  let {
    el,
    lang = "en-US",
    title = "Dictate with your voice",
  }: {
    el?: VoiceTarget | null;
    lang?: string;
    title?: string;
  } = $props();

  let wrap: HTMLElement | undefined = $state();

  // The controller isn't a rune source; bump a counter on each of its
  // notifications so the deriveds below recompute.
  let tick = $state(0);
  let mine = $state(false);

  $effect(() => voice.subscribe(() => tick++));

  onMount(() => {
    const root = wrap?.getRootNode() as Document | ShadowRoot | undefined;
    if (!root) return;
    const host = root instanceof Document ? root.head : root;
    if (host && !host.querySelector("#pinta-mic-styles")) {
      const style = document.createElement("style");
      style.id = "pinta-mic-styles";
      style.textContent = MIC_CSS;
      host.appendChild(style);
    }
  });

  const listening = $derived.by(() => {
    void tick;
    return el != null && voice.activeEl === el;
  });
  const errorText = $derived.by(() => {
    void tick;
    return mine ? voice.error : null;
  });

  function onClick(): void {
    if (!el) return;
    if (voice.activeEl === el) {
      voice.stop();
      mine = false;
    } else {
      mine = true;
      voice.clearError();
      voice.start(el, lang);
    }
  }

  function dismiss(): void {
    voice.clearError();
    mine = false;
  }

  const MIC_CSS = `
.pinta-mic-wrap { position: relative; display: inline-flex; }
.pinta-mic {
  position: relative; display: inline-flex; align-items: center;
  justify-content: center; width: 26px; height: 26px; border: 0;
  border-radius: 999px; background: transparent; color: #94a3b8;
  cursor: pointer; transition: color .15s, background .15s; padding: 0;
}
.pinta-mic:hover { color: #ec4899; background: rgba(236,72,153,.1); }
.pinta-mic.is-listening { color: #fff; background: #ec4899; }
.pinta-mic-pulse {
  position: absolute; inset: -3px; border-radius: 999px;
  border: 2px solid rgba(236,72,153,.6);
  animation: pinta-mic-pulse 1.2s ease-out infinite;
}
@keyframes pinta-mic-pulse {
  0% { transform: scale(.85); opacity: .8; }
  100% { transform: scale(1.5); opacity: 0; }
}
.pinta-mic-error {
  position: absolute; top: calc(100% + 4px); right: 0; z-index: 50;
  display: inline-flex; align-items: center; gap: 6px; max-width: 220px;
  padding: 4px 6px 4px 8px; border-radius: 6px; background: #7f1d1d;
  color: #fee2e2; font-size: 11px; line-height: 1.3; white-space: normal;
  box-shadow: 0 4px 12px rgba(0,0,0,.25);
}
.pinta-mic-error-x {
  border: 0; background: transparent; color: inherit; font-size: 14px;
  line-height: 1; cursor: pointer; padding: 0 2px;
}
`;
</script>

<span class="pinta-mic-wrap" bind:this={wrap}>
  <button
    type="button"
    class="pinta-mic"
    class:is-listening={listening}
    {title}
    aria-label={listening ? "Stop dictation" : title}
    aria-pressed={listening}
    onclick={onClick}
  >
    {#if listening}
      <span class="pinta-mic-pulse" aria-hidden="true"></span>
    {/if}
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  </button>

  {#if errorText}
    <span class="pinta-mic-error" role="alert">
      {errorText}
      <button type="button" class="pinta-mic-error-x" onclick={dismiss} aria-label="Dismiss">×</button>
    </span>
  {/if}
</span>
