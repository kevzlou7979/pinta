<script lang="ts">
  // Pinta's one loader — paint swatches fanning out from a shared pivot
  // (the brand's "paint" identity, so the sunset palette is deliberate
  // here even though the rest of the UI accents in brand pink only).
  //
  // Sizes are the swatch fan's HEIGHT: xs (14px) sits inside buttons,
  // chips and tab icons; sm (20px) is an inline row loader; md (40px)
  // and lg (72px) headline a content area (see LoadingState.svelte).
  // xs drops to three wider swatches — five 3px slivers stop reading as
  // a fan at 14px, three 5px ones still do.
  //
  // Live region: md/lg default to a status region labelled by `label`;
  // xs/sm default to DECORATIVE because they sit inside a button, chip
  // or line that already carries the wait (its title / aria-label / text),
  // and a nested status would announce twice ("Fixing Fixing…"). Pass
  // `decorative={false}` to opt a small fan back in when nothing else
  // owns the status, or `decorative` to silence a big one (LoadingState).
  //
  // tone="mono" paints every swatch in currentColor at stepped opacity —
  // for fans on filled surfaces (pink / amber buttons, chips, bars) where
  // the fixed hex palette sits at ~1.2:1 against the fill.
  type Props = {
    size?: "xs" | "sm" | "md" | "lg";
    tone?: "paint" | "mono";
    label?: string;
    class?: string;
    title?: string;
    decorative?: boolean;
  };

  let {
    size = "sm",
    tone = "paint",
    label = "Loading",
    class: cls = "",
    title,
    decorative,
  }: Props = $props();

  // Pivot at (70, 92); the ±44° sweep plus the easing's ~11% overshoot
  // reaches x≈7..129, y≈22..109 — the viewBox covers that with a hair of
  // slack and the svg is overflow:visible so no held pose is ever clipped.
  const VIEW = "4 20 132 90";
  const RATIO = 132 / 90;
  const HEIGHT = { xs: 14, sm: 20, md: 40, lg: 72 } as const;

  type Swatch = { fill: string; mono: number; angle: number; rest: number; delay: number };
  const FIVE: Swatch[] = [
    { fill: "#C2378F", mono: 0.35, angle: -44, rest: 0, delay: 0 },
    { fill: "#F2456E", mono: 0.5, angle: -24, rest: 0, delay: 0.04 },
    { fill: "#FF6B3D", mono: 0.65, angle: -4, rest: 0, delay: 0.08 },
    { fill: "#FF9A2B", mono: 0.82, angle: 16, rest: 0, delay: 0.12 },
    { fill: "#FFC93C", mono: 1, angle: 36, rest: 0, delay: 0.16 },
  ];
  // xs rests at ±6° (not stacked flat) so a frozen frame still reads as a
  // fan rather than a single yellow pill.
  const THREE: Swatch[] = [
    { fill: "#C2378F", mono: 0.45, angle: -34, rest: -6, delay: 0 },
    { fill: "#FF6B3D", mono: 0.7, angle: 0, rest: 0, delay: 0.06 },
    { fill: "#FFC93C", mono: 1, angle: 34, rest: 6, delay: 0.12 },
  ];

  const h = $derived(HEIGHT[size]);
  const w = $derived(Math.round(h * RATIO));
  const swatches = $derived(size === "xs" ? THREE : FIVE);
  const rect = $derived(
    size === "xs"
      ? { x: 50, width: 40, rx: 10 }
      : { x: 54, width: 32, rx: 8 },
  );
  const isDecorative = $derived(decorative ?? (size === "xs" || size === "sm"));
</script>

<span
  class="pinta-paint-loader inline-flex align-middle shrink-0 leading-none {cls}"
  role={isDecorative ? undefined : "status"}
  aria-label={isDecorative ? undefined : label}
  aria-hidden={isDecorative ? "true" : undefined}
  {title}
  data-size={size}
  data-tone={tone}
>
  <svg width={w} height={h} viewBox={VIEW} class="overflow-visible" aria-hidden="true" focusable="false">
    {#each swatches as s (s.fill)}
      <rect
        class="sw"
        x={rect.x}
        y="22"
        width={rect.width}
        height="76"
        rx={rect.rx}
        fill={tone === "mono" ? "currentColor" : s.fill}
        opacity={tone === "mono" ? s.mono : undefined}
        style="--a:{s.angle}deg; --r:{s.rest}deg; animation-delay:{s.delay}s"
      />
    {/each}
  </svg>
</span>

<style>
  .sw {
    transform-box: fill-box;
    transform-origin: 50% 92%;
    transform: rotate(var(--r, 0deg));
    animation: fan 2.2s cubic-bezier(0.5, 1.6, 0.4, 1) infinite;
  }
  @keyframes fan {
    0%,
    10% {
      transform: rotate(var(--r, 0deg));
    }
    40%,
    70% {
      transform: rotate(var(--a));
    }
    100% {
      transform: rotate(var(--r, 0deg));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sw {
      animation: none;
      transform: rotate(var(--a));
    }
  }
</style>
