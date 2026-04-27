<script lang="ts">
  type Props = {
    anchor: { top: number; left: number; width: number; height: number };
    title?: string;
    value: string;
    onsubmit: () => void;
    oncancel: () => void;
  };
  let {
    anchor,
    title = "",
    value = $bindable(""),
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
  style:top="{top}px"
  style:left="{left}px"
  style:width="{POPUP_W}px"
>
  {#if title}
    <div class="popup__head">{title}</div>
  {/if}
  <textarea
    bind:value
    onkeydown={onKey}
    placeholder="What do you want changed?"
    rows="3"
    autofocus
  ></textarea>
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
