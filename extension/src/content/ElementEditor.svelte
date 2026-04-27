<script lang="ts">
  type Props = {
    anchor: { top: number; left: number; width: number; height: number };
    title: string;
    comment: string;
    customCss: string;
    onsubmit: () => void;
    oncancel: () => void;
  };
  let {
    anchor,
    title,
    comment = $bindable(""),
    customCss = $bindable(""),
    onsubmit,
    oncancel,
  }: Props = $props();

  type Tab = "comment" | "css";
  let activeTab = $state<Tab>("comment");

  const POPUP_W = 340;
  const POPUP_H = 220;

  let top = $derived(
    anchor.top + anchor.height + 8 + POPUP_H < window.innerHeight
      ? anchor.top + anchor.height + 8
      : Math.max(8, anchor.top - POPUP_H - 8),
  );
  let left = $derived(
    Math.max(8, Math.min(window.innerWidth - POPUP_W - 8, anchor.left)),
  );

  let canSubmit = $derived(comment.trim().length > 0 || customCss.trim().length > 0);

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSubmit) onsubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
    }
  }
</script>

<div
  class="popup popup--editor"
  style:top="{top}px"
  style:left="{left}px"
  style:width="{POPUP_W}px"
>
  <div class="popup__head">{title}</div>

  <div class="tabs">
    <button
      type="button"
      class="tab"
      class:tab--active={activeTab === "comment"}
      onclick={() => (activeTab = "comment")}
    >
      Comment
    </button>
    <button
      type="button"
      class="tab"
      class:tab--active={activeTab === "css"}
      onclick={() => (activeTab = "css")}
    >
      CSS
      {#if customCss.trim().length > 0}
        <span class="tab__dot" aria-hidden="true"></span>
      {/if}
    </button>
  </div>

  {#if activeTab === "comment"}
    <textarea
      bind:value={comment}
      onkeydown={onKey}
      placeholder="What do you want changed?"
      rows="4"
      autofocus
    ></textarea>
  {:else}
    <textarea
      class="popup__css"
      bind:value={customCss}
      onkeydown={onKey}
      placeholder={`/* CSS for ${title} */\ncolor: #ff3d6e;\npadding: 1rem;`}
      rows="6"
      spellcheck="false"
      autofocus
    ></textarea>
    <p class="popup__hint">
      Agent will apply these as CSS additions or property overrides on the
      matching source element.
    </p>
  {/if}

  <div class="popup__actions">
    <button class="btn btn--ghost" onclick={oncancel}>Cancel</button>
    <button
      class="btn btn--primary"
      onclick={onsubmit}
      disabled={!canSubmit}
    >
      Add annotation
    </button>
  </div>
</div>
