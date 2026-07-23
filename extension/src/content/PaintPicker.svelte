<script lang="ts">
  // Paint tool picker. Recolors the selected element from the palette the
  // PAGE already uses (harvested via tools/palette.ts), so a user can say
  // "make this the navy blue from the primary button" by clicking that
  // navy swatch — no hex hunting. Also offers a screen eyedropper (Chrome's
  // EyeDropper API, when available) and a free-form color input.

  import type { Swatch } from "./tools/palette.js";

  type PaintProp = "background-color" | "color" | "border-color";

  type Props = {
    anchor: { top: number; left: number; width: number; height: number };
    title: string;
    /** Colors harvested from the page, most-used first. */
    swatches: Swatch[];
    /** The selected element's current computed colors as #RRGGBB, or ""
     *  when it has none (transparent background / no border) — in which
     *  case any pick counts as a change. */
    initial: Record<PaintProp, string>;
    /** Apply one property live. Empty value = reset to the original. */
    onpaint: (prop: PaintProp, value: string) => void;
    /** True while the user is sampling a color by pointing at the page. */
    eyedropping: boolean;
    /** Start the point-at-an-element sampler (falls back from EyeDropper). */
    onEyedropStart: () => void;
    onsubmit: () => void;
    oncancel: () => void;
  };
  let {
    anchor,
    title,
    swatches,
    initial,
    onpaint,
    eyedropping,
    onEyedropStart,
    onsubmit,
    oncancel,
  }: Props = $props();

  const PW = 320;
  const PH = 300;
  let top = $derived(
    anchor.top + anchor.height + 8 + PH < window.innerHeight
      ? anchor.top + anchor.height + 8
      : Math.max(8, anchor.top - PH - 8),
  );
  let left = $derived(
    Math.max(8, Math.min(window.innerWidth - PW - 8, anchor.left)),
  );

  const PROPS: { id: PaintProp; label: string; hint: string }[] = [
    { id: "background-color", label: "Fill", hint: "Background color" },
    { id: "color", label: "Text", hint: "Text color" },
    { id: "border-color", label: "Border", hint: "Border color" },
  ];

  /** Sentinel for "no color at all" — knocks out a background or border. */
  const TRANSPARENT = "transparent";

  let activeProp = $state<PaintProp>("background-color");
  // Per-property current value. Starts at the element's computed color;
  // picking a swatch overwrites it and paints live.
  let picked = $state<Record<PaintProp, string>>({ ...initial });

  export function applySampled(hex: string): void {
    pick(hex);
  }

  /** True when `value` is what the element already had. An element with no
   *  color reads as "" in `initial`, so picking Transparent on it is a
   *  no-op too — without this it'd emit a redundant `transparent`. */
  function isOriginal(prop: PaintProp, value: string): boolean {
    const was = (initial[prop] ?? "").toLowerCase();
    const now = value.toLowerCase();
    if (was === "" && now === TRANSPARENT) return true;
    return was === now;
  }

  function pick(hex: string): void {
    picked = { ...picked, [activeProp]: hex };
    // Painting back to the element's own starting color is a no-op, so
    // emit a reset instead of a redundant cssChange.
    onpaint(activeProp, isOriginal(activeProp, hex) ? "" : hex);
  }

  let isTransparent = $derived(picked[activeProp] === TRANSPARENT);
  // Display fallback only — an unset ("") property still compares as
  // empty for dirty-tracking, it just needs *something* to render. The
  // native color input can't represent `transparent`, so it falls back too.
  let currentHex = $derived(
    isTransparent ? "#000000" : picked[activeProp] || "#000000",
  );
  let currentLabel = $derived(
    isTransparent ? TRANSPARENT : picked[activeProp] || "none",
  );
  let dirtyCount = $derived(
    (Object.keys(picked) as PaintProp[]).filter(
      (p) => !isOriginal(p, picked[p] ?? ""),
    ).length,
  );

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (dirtyCount > 0) onsubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
    }
  }
</script>

<div
  class="popup paint"
  style:top="{top}px"
  style:left="{left}px"
  style:width="{PW}px"
  onkeydown={onKey}
  role="dialog"
  tabindex="-1"
  aria-label="Paint {title}"
>
  <div class="popup__head"><span>Paint {title}</span></div>

  <div class="paint__props" role="group" aria-label="Property to paint">
    {#each PROPS as p (p.id)}
      <button
        type="button"
        class="paint__prop"
        class:paint__prop--on={activeProp === p.id}
        title={p.hint}
        aria-pressed={activeProp === p.id}
        onclick={() => (activeProp = p.id)}
      >
        <span
          class="paint__prop-dot"
          class:paint__swatch--none={!picked[p.id] || picked[p.id] === TRANSPARENT}
          style:background={picked[p.id] && picked[p.id] !== TRANSPARENT
            ? picked[p.id]
            : "transparent"}
        ></span>
        {p.label}
      </button>
    {/each}
  </div>

  <p class="paint__label">
    {#if swatches.length > 0}
      Colors used on this page — click one to apply
    {:else}
      No page colors found — pick one below
    {/if}
  </p>

  <div class="paint__swatches">
    <!-- Transparent always leads the grid — knocking out a background or
         border is as common as picking a color. -->
    <button
      type="button"
      class="paint__swatch paint__swatch--none"
      class:paint__swatch--on={isTransparent}
      title="Transparent — remove this color"
      aria-label="Apply transparent"
      onclick={() => pick(TRANSPARENT)}
    ></button>
    {#each swatches as s (s.color)}
      <button
        type="button"
        class="paint__swatch"
        class:paint__swatch--on={!isTransparent &&
          currentHex.toLowerCase() === s.color.toLowerCase()}
        style:background={s.color}
        title="{s.color} · used on {s.count} element{s.count === 1 ? '' : 's'}"
        aria-label="Apply {s.color}"
        onclick={() => pick(s.color)}
      ></button>
    {/each}
  </div>

  <div class="paint__row">
    <label class="paint__custom" title="Custom color">
      <span
        class="paint__swatch-preview"
        class:paint__swatch--none={isTransparent}
        style:background={isTransparent ? "transparent" : currentHex}
      ></span>
      <input
        type="color"
        value={currentHex}
        aria-label="Custom color"
        oninput={(e) => pick((e.currentTarget as HTMLInputElement).value.toUpperCase())}
      />
    </label>
    <code class="paint__hex">{currentLabel}</code>
    <button
      type="button"
      class="paint__eyedrop"
      class:paint__eyedrop--on={eyedropping}
      onclick={onEyedropStart}
      title="Pick a color by pointing at anything on the page"
    >
      {eyedropping ? "Pointing…" : "Pick from page"}
    </button>
  </div>

  <div class="popup__actions">
    <button class="btn btn--ghost" onclick={oncancel}>Cancel</button>
    <button class="btn btn--primary" onclick={onsubmit} disabled={dirtyCount === 0}>
      Add annotation
    </button>
  </div>
</div>
