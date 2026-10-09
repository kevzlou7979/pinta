<script lang="ts">
  // Pinta's one loader — a ring of the five brand paints, rotating (the
  // brand's "paint" identity, so the sunset palette is deliberate here
  // even though the rest of the UI accents in brand pink only).
  //
  // Sizes are the ring's diameter: xs (14px) sits inside buttons, chips
  // and tab icons; sm (20px) is an inline row loader; md (40px) and lg
  // (72px) headline a content area (see LoadingState.svelte). Small
  // rings get a thicker stroke so the five segments still read at 14px.
  //
  // Live region: md/lg default to a status region labelled by `label`;
  // xs/sm default to DECORATIVE because they sit inside a button, chip
  // or line that already carries the wait (its title / aria-label / text),
  // and a nested status would announce twice ("Fixing Fixing…"). Pass
  // `decorative={false}` to opt a small ring back in when nothing else
  // owns the status, or `decorative` to silence a big one (LoadingState).
  //
  // tone="mono" paints every segment in currentColor at stepped opacity —
  // for rings on filled surfaces (pink / amber buttons, chips, bars) where
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

  const PX = { xs: 14, sm: 20, md: 40, lg: 72 } as const;
  // Stroke in viewBox units (box is 48): thicker when small so the
  // segments don't thin into a hairline.
  const STROKE = { xs: 8, sm: 7, md: 6, lg: 5 } as const;
  const PAINTS = [
    { fill: "#C2378F", mono: 0.35 },
    { fill: "#F2456E", mono: 0.5 },
    { fill: "#FF6B3D", mono: 0.65 },
    { fill: "#FF9A2B", mono: 0.82 },
    { fill: "#FFC93C", mono: 1 },
  ];

  const px = $derived(PX[size]);
  const stroke = $derived(STROKE[size]);
  const r = $derived(24 - stroke / 2 - 1);
  const circ = $derived(2 * Math.PI * r);
  const seg = $derived(circ / PAINTS.length);
  // Gap between segments, a fixed share of the segment so it scales.
  const gap = $derived(seg * 0.14);
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
  <svg class="pl-ring shrink-0" width={px} height={px} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    {#each PAINTS as p, i (p.fill)}
      <circle
        class="seg"
        cx="24"
        cy="24"
        {r}
        fill="none"
        stroke={tone === "mono" ? "currentColor" : p.fill}
        stroke-opacity={tone === "mono" ? p.mono : undefined}
        stroke-width={stroke}
        stroke-dasharray="{seg - gap} {circ - seg + gap}"
        stroke-dashoffset={-i * seg}
        transform="rotate(-90 24 24)"
      />
    {/each}
  </svg>
</span>

<style>
  .pl-ring {
    transform-origin: center;
    animation: ring-spin 1.1s linear infinite;
  }
  @keyframes ring-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pl-ring {
      animation: none;
    }
  }
</style>
