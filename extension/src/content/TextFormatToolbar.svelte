<script lang="ts">
  // Floating text-formatting toolbar shown while the Text tool is editing
  // an element in place. Emits per-property CSS changes (`onformat`) that
  // the overlay applies live and folds into the committed annotation's
  // `cssChanges`. Toggle buttons use `onmousedown preventDefault` so they
  // don't steal focus from the contentEditable element — the caret stays
  // put and the user can keep typing between formatting tweaks.

  type Initial = {
    fontSize: string;
    fontWeight: string;
    fontStyle: string;
    underline: boolean;
    color: string;
    textAlign: string;
    lineHeight: string;
    letterSpacing: string;
    textTransform: string;
  };

  type Props = {
    anchor: { top: number; left: number; width: number; height: number };
    title: string;
    initial: Initial;
    /** Apply one CSS property. Empty string = reset to the element's
     *  original value (the overlay drops the key from cssChanges). */
    onformat: (prop: string, value: string) => void;
    ondone: () => void;
    oncancel: () => void;
  };
  let { anchor, title, initial, onformat, ondone, oncancel }: Props = $props();

  const TB_W = 320;
  const TB_H = 96;
  // Prefer above the element (text usually flows downward, so the toolbar
  // sitting on top keeps the words visible); flip below when there's no room.
  let top = $derived(
    anchor.top - TB_H - 8 >= 8
      ? anchor.top - TB_H - 8
      : Math.min(window.innerHeight - TB_H - 8, anchor.top + anchor.height + 8),
  );
  let left = $derived(
    Math.max(8, Math.min(window.innerWidth - TB_W - 8, anchor.left)),
  );

  function toHex(rgb: string): string {
    if (!rgb) return "#000000";
    if (rgb.startsWith("#")) return rgb;
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(rgb);
    if (!m) return "#000000";
    return (
      "#" +
      [m[1], m[2], m[3]]
        .map((n) => parseInt(n!, 10).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  function parsePx(v: string): number {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n) : 16;
  }

  const initialBold = parseInt(initial.fontWeight, 10) >= 600;
  const initialItalic = initial.fontStyle === "italic";
  const initialAlign =
    initial.textAlign === "start" ? "left" : initial.textAlign || "left";
  const initialSize = parsePx(initial.fontSize);
  const initialHex = toHex(initial.color);
  const initialTransform =
    initial.textTransform === "none" ? "" : initial.textTransform;
  const initialLineHeight =
    initial.lineHeight === "normal" ? "" : initial.lineHeight;
  const initialLetter =
    initial.letterSpacing === "normal" ? "" : initial.letterSpacing;

  let bold = $state(initialBold);
  let italic = $state(initialItalic);
  let underline = $state(initial.underline);
  let size = $state(initialSize);
  let color = $state(initialHex);
  let align = $state(initialAlign);
  let lineHeight = $state(initialLineHeight);
  let letterSpacing = $state(initialLetter);
  let transform = $state(initialTransform);
  let moreOpen = $state(false);

  function toggleBold() {
    bold = !bold;
    onformat("font-weight", bold === initialBold ? "" : bold ? "700" : "400");
  }
  function toggleItalic() {
    italic = !italic;
    onformat(
      "font-style",
      italic === initialItalic ? "" : italic ? "italic" : "normal",
    );
  }
  function toggleUnderline() {
    underline = !underline;
    onformat(
      "text-decoration-line",
      underline === initial.underline ? "" : underline ? "underline" : "none",
    );
  }
  function setSize(n: number) {
    if (!Number.isFinite(n)) return; // cleared / mid-typing — ignore
    size = Math.max(1, Math.min(400, Math.round(n)));
    onformat("font-size", size === initialSize ? "" : `${size}px`);
  }
  function onColor(e: Event) {
    color = (e.currentTarget as HTMLInputElement).value;
    onformat(
      "color",
      color.toLowerCase() === initialHex.toLowerCase() ? "" : color,
    );
  }
  function setAlign(a: string) {
    align = a;
    onformat("text-align", a === initialAlign ? "" : a);
  }
  function onLineHeight(e: Event) {
    lineHeight = (e.currentTarget as HTMLInputElement).value;
    onformat("line-height", lineHeight.trim() === initialLineHeight ? "" : lineHeight.trim());
  }
  function onLetter(e: Event) {
    letterSpacing = (e.currentTarget as HTMLInputElement).value;
    onformat("letter-spacing", letterSpacing.trim() === initialLetter ? "" : letterSpacing.trim());
  }
  function onTransform() {
    onformat(
      "text-transform",
      transform === initialTransform ? "" : transform || "none",
    );
  }

  // Keep the caret in the editable when pressing toolbar toggle buttons.
  function keepCaret(e: MouseEvent) {
    e.preventDefault();
  }

  const ALIGNS: { id: string; label: string; icon: string }[] = [
    { id: "left", label: "Align left", icon: "L" },
    { id: "center", label: "Align center", icon: "C" },
    { id: "right", label: "Align right", icon: "R" },
  ];
</script>

<div
  class="tfmt"
  style:top="{top}px"
  style:left="{left}px"
  style:width="{TB_W}px"
  role="toolbar"
  aria-label="Text formatting for {title}"
>
  <div class="tfmt__row">
    <button
      type="button"
      class="tfmt__btn"
      class:tfmt__btn--on={bold}
      style="font-weight:700"
      title="Bold"
      aria-pressed={bold}
      onmousedown={keepCaret}
      onclick={toggleBold}>B</button>
    <button
      type="button"
      class="tfmt__btn"
      class:tfmt__btn--on={italic}
      style="font-style:italic"
      title="Italic"
      aria-pressed={italic}
      onmousedown={keepCaret}
      onclick={toggleItalic}>I</button>
    <button
      type="button"
      class="tfmt__btn"
      class:tfmt__btn--on={underline}
      style="text-decoration:underline"
      title="Underline"
      aria-pressed={underline}
      onmousedown={keepCaret}
      onclick={toggleUnderline}>U</button>

    <span class="tfmt__sep" aria-hidden="true"></span>

    <div class="tfmt__stepper" title="Font size">
      <button type="button" class="tfmt__btn" aria-label="Decrease font size" onmousedown={keepCaret} onclick={() => setSize(size - 1)}>−</button>
      <input
        class="tfmt__size"
        type="number"
        min="1"
        max="400"
        value={size}
        aria-label="Font size in px"
        oninput={(e) => setSize(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <button type="button" class="tfmt__btn" aria-label="Increase font size" onmousedown={keepCaret} onclick={() => setSize(size + 1)}>+</button>
    </div>

    <label class="tfmt__color" title="Text color">
      <span class="tfmt__swatch" style:background={color}></span>
      <input type="color" value={color} oninput={onColor} aria-label="Text color" />
    </label>

    <span class="tfmt__sep" aria-hidden="true"></span>

    {#each ALIGNS as a (a.id)}
      <button
        type="button"
        class="tfmt__btn tfmt__btn--align tfmt__btn--{a.id}"
        class:tfmt__btn--on={align === a.id}
        title={a.label}
        aria-label={a.label}
        aria-pressed={align === a.id}
        onmousedown={keepCaret}
        onclick={() => setAlign(a.id)}>{a.icon}</button>
    {/each}

    <button
      type="button"
      class="tfmt__btn tfmt__more"
      class:tfmt__btn--on={moreOpen}
      title="More text options"
      aria-label="More text options"
      aria-expanded={moreOpen}
      onmousedown={keepCaret}
      onclick={() => (moreOpen = !moreOpen)}>⋯</button>
  </div>

  {#if moreOpen}
    <div class="tfmt__row tfmt__row--more">
      <label class="tfmt__field" title="Line height">
        <span>Line</span>
        <input type="text" value={lineHeight} placeholder="1.5" oninput={onLineHeight} />
      </label>
      <label class="tfmt__field" title="Letter spacing">
        <span>Letter</span>
        <input type="text" value={letterSpacing} placeholder="0.02em" oninput={onLetter} />
      </label>
      <label class="tfmt__field" title="Text transform">
        <span>Case</span>
        <select bind:value={transform} onchange={onTransform}>
          <option value="">Aa</option>
          <option value="uppercase">AA</option>
          <option value="lowercase">aa</option>
          <option value="capitalize">Aa+</option>
        </select>
      </label>
    </div>
  {/if}

  <div class="tfmt__row tfmt__row--actions">
    <span class="tfmt__hint">Type to edit text · Enter to save</span>
    <button type="button" class="tfmt__action" onclick={oncancel}>Cancel</button>
    <button type="button" class="tfmt__action tfmt__action--primary" onclick={ondone}>Save</button>
  </div>
</div>
