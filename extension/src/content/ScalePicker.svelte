<script lang="ts">
  // Scale tool picker. The user picks a PERCENTAGE; the annotation carries
  // that as plain intent ("scale this to 125% — grow every dimension
  // proportionally"), NOT computed CSS. The agent decides how to express it
  // in the project's system (Tailwind steps, tokens, raw CSS) — scaling
  // font-size, box, padding, gaps and radius together. The on-page
  // transform is preview-only and never ships in the annotation.

  type Props = {
    anchor: { top: number; left: number; width: number; height: number };
    title: string;
    percent: number;
    note: string;
    onpercent: (p: number) => void;
    onsubmit: () => void;
    oncancel: () => void;
  };
  let {
    anchor,
    title,
    percent,
    note = $bindable(""),
    onpercent,
    onsubmit,
    oncancel,
  }: Props = $props();

  const PW = 300;
  const PH = 260;
  let top = $derived(
    anchor.top + anchor.height + 8 + PH < window.innerHeight
      ? anchor.top + anchor.height + 8
      : Math.max(8, anchor.top - PH - 8),
  );
  let left = $derived(
    Math.max(8, Math.min(window.innerWidth - PW - 8, anchor.left)),
  );

  const PRESETS = [50, 75, 90, 110, 125, 150, 200];

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (percent !== 100) onsubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
    }
  }

  let verb = $derived(percent >= 100 ? "Bigger" : "Smaller");
</script>

<div
  class="popup scale"
  style:top="{top}px"
  style:left="{left}px"
  style:width="{PW}px"
  onkeydown={onKey}
  role="dialog"
  tabindex="-1"
  aria-label="Scale {title}"
>
  <div class="popup__head"><span>Scale {title}</span></div>

  <div class="scale__readout">
    <span class="scale__pct">{percent}%</span>
    <span class="scale__verb">{percent === 100 ? "No change" : verb}</span>
  </div>

  <input
    class="scale__range"
    type="range"
    min="25"
    max="300"
    step="5"
    value={percent}
    aria-label="Scale percentage"
    oninput={(e) => onpercent(Number((e.currentTarget as HTMLInputElement).value))}
  />

  <div class="scale__chips">
    {#each PRESETS as p (p)}
      <button
        type="button"
        class="scale__chip"
        class:scale__chip--on={percent === p}
        onclick={() => onpercent(p)}
      >{p}%</button>
    {/each}
    <button
      type="button"
      class="scale__chip scale__chip--reset"
      onclick={() => onpercent(100)}
      title="Back to the original size"
    >Reset</button>
  </div>

  <p class="popup__hint scale__hint">
    Scales <strong>every dimension</strong> — font size, width/height,
    padding, gaps, radius — by {percent}%. The agent applies it as real
    values in your styling system, not a CSS transform.
  </p>

  <textarea
    bind:value={note}
    onkeydown={onKey}
    placeholder="Optional: anything to add? (e.g. keep the icon the same size)"
    rows="2"
  ></textarea>

  <div class="popup__actions">
    <button class="btn btn--ghost" onclick={oncancel}>Cancel</button>
    <button class="btn btn--primary" onclick={onsubmit} disabled={percent === 100}>
      Add annotation
    </button>
  </div>
</div>
