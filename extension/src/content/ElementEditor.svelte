<script lang="ts">
  import { onMount } from "svelte";

  type LiveStyles = {
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    color: string;
    lineHeight: string;
    width: string;
    height: string;
    padding: string;
    margin: string;
    backgroundColor: string;
    borderRadius: string;
    boxShadow: string;
    display: string;
  };

  type Props = {
    anchor: { top: number; left: number; width: number; height: number };
    title: string;
    liveText: string;
    liveStyles: LiveStyles;
    comment: string;
    customCss: string;
    cssChanges: Record<string, string>;
    contentAfter: string;
    onsubmit: () => void;
    oncancel: () => void;
  };
  let {
    anchor,
    title,
    liveText,
    liveStyles,
    comment = $bindable(""),
    customCss = $bindable(""),
    cssChanges = $bindable<Record<string, string>>({}),
    contentAfter = $bindable<string>(""),
    onsubmit,
    oncancel,
  }: Props = $props();

  type Tab = "comment" | "content" | "font" | "sizing" | "spacing" | "css";
  let activeTab = $state<Tab>("comment");

  const POPUP_W = 360;
  const POPUP_H = 320;

  let top = $derived(
    anchor.top + anchor.height + 8 + POPUP_H < window.innerHeight
      ? anchor.top + anchor.height + 8
      : Math.max(8, anchor.top - POPUP_H - 8),
  );
  let left = $derived(
    Math.max(8, Math.min(window.innerWidth - POPUP_W - 8, anchor.left)),
  );

  // Per-field locals — bound to inputs. Track separately from cssChanges
  // so we can compute the diff against `liveStyles` on every keystroke.
  let fontSize = $state(simplifyLength(liveStyles.fontSize));
  let fontWeight = $state(liveStyles.fontWeight);
  let color = $state(toHex(liveStyles.color));
  let lineHeight = $state(simplifyLength(liveStyles.lineHeight));
  let width = $state(simplifyLength(liveStyles.width));
  let height = $state(simplifyLength(liveStyles.height));
  let padding = $state(simplifyShorthand(liveStyles.padding));
  let margin = $state(simplifyShorthand(liveStyles.margin));
  let backgroundColor = $state(toHex(liveStyles.backgroundColor));
  let borderRadius = $state(simplifyLength(liveStyles.borderRadius));
  let boxShadow = $state(liveStyles.boxShadow === "none" ? "" : liveStyles.boxShadow);

  // Initial snapshot for diffing.
  const initial = {
    fontSize,
    fontWeight,
    color,
    lineHeight,
    width,
    height,
    padding,
    margin,
    backgroundColor,
    borderRadius,
    boxShadow,
  };

  // Initialize the editable text.
  onMount(() => {
    if (!contentAfter) contentAfter = liveText;
  });

  // Recompute the structured cssChanges whenever any picker changes.
  $effect(() => {
    const next: Record<string, string> = {};
    if (fontSize.trim() && fontSize !== initial.fontSize)
      next["font-size"] = fontSize.trim();
    if (fontWeight.trim() && fontWeight !== initial.fontWeight)
      next["font-weight"] = fontWeight.trim();
    if (color.trim() && color.toLowerCase() !== initial.color.toLowerCase())
      next["color"] = color.trim();
    if (lineHeight.trim() && lineHeight !== initial.lineHeight)
      next["line-height"] = lineHeight.trim();
    if (width.trim() && width !== initial.width) next["width"] = width.trim();
    if (height.trim() && height !== initial.height)
      next["height"] = height.trim();
    if (padding.trim() && padding !== initial.padding)
      next["padding"] = padding.trim();
    if (margin.trim() && margin !== initial.margin)
      next["margin"] = margin.trim();
    if (
      backgroundColor.trim() &&
      backgroundColor.toLowerCase() !== initial.backgroundColor.toLowerCase()
    )
      next["background-color"] = backgroundColor.trim();
    if (borderRadius.trim() && borderRadius !== initial.borderRadius)
      next["border-radius"] = borderRadius.trim();
    if (boxShadow.trim() && boxShadow !== initial.boxShadow)
      next["box-shadow"] = boxShadow.trim();

    cssChanges = next;
  });

  let cssChangeCount = $derived(Object.keys(cssChanges).length);
  let contentDirty = $derived(contentAfter.trim() !== liveText.trim());

  let canSubmit = $derived(
    comment.trim().length > 0 ||
      customCss.trim().length > 0 ||
      cssChangeCount > 0 ||
      contentDirty,
  );

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSubmit) onsubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
    }
  }

  // Helpers — collapse computed values into the simplest form a developer
  // would actually type.
  function simplifyLength(s: string): string {
    if (!s) return "";
    if (s === "0px" || s === "0") return "0";
    if (s === "auto" || s === "normal" || s === "none") return s;
    return s;
  }

  function simplifyShorthand(s: string): string {
    if (!s) return "";
    // "10px 10px 10px 10px" -> "10px"
    const parts = s.split(/\s+/);
    if (parts.length === 4 && new Set(parts).size === 1) return parts[0]!;
    if (
      parts.length === 4 &&
      parts[0] === parts[2] &&
      parts[1] === parts[3]
    )
      return `${parts[0]} ${parts[1]}`;
    return s;
  }

  // Convert "rgb(255, 61, 110)" to "#FF3D6E" for the color input. Falls
  // back to the original string if parsing fails.
  function toHex(rgb: string): string {
    if (!rgb) return "";
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(rgb);
    if (!m) return rgb;
    const r = parseInt(m[1]!, 10);
    const g = parseInt(m[2]!, 10);
    const b = parseInt(m[3]!, 10);
    return (
      "#" +
      [r, g, b]
        .map((n) => n.toString(16).padStart(2, "0").toUpperCase())
        .join("")
    );
  }

  type TabSpec = { id: Tab; label: string; dot: boolean };
  let tabs = $derived<TabSpec[]>([
    { id: "comment", label: "Comment", dot: comment.trim().length > 0 },
    { id: "content", label: "Content", dot: contentDirty },
    { id: "font", label: "Font", dot: hasAny(["font-size", "font-weight", "color", "line-height"]) },
    { id: "sizing", label: "Sizing", dot: hasAny(["width", "height"]) },
    { id: "spacing", label: "Spacing", dot: hasAny(["padding", "margin"]) },
    { id: "css", label: "CSS", dot: customCss.trim().length > 0 },
  ]);

  function hasAny(props: string[]): boolean {
    return props.some((p) => p in cssChanges);
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
    {#each tabs as t (t.id)}
      <button
        type="button"
        class="tab"
        class:tab--active={activeTab === t.id}
        onclick={() => (activeTab = t.id)}
      >
        {t.label}
        {#if t.dot}
          <span class="tab__dot" aria-hidden="true"></span>
        {/if}
      </button>
    {/each}
  </div>

  {#if activeTab === "comment"}
    <textarea
      bind:value={comment}
      onkeydown={onKey}
      placeholder="What do you want changed?"
      rows="4"
    ></textarea>
  {:else if activeTab === "content"}
    <textarea
      bind:value={contentAfter}
      onkeydown={onKey}
      placeholder="Edit the element's text content"
      rows="3"
    ></textarea>
    <p class="popup__hint">
      {#if contentDirty}
        Text will be replaced from <em>"{liveText.slice(0, 40)}{liveText.length > 40 ? '…' : ''}"</em>
      {:else}
        Live text content. Edit to capture the change.
      {/if}
    </p>
  {:else if activeTab === "font"}
    <div class="grid">
      <label>Size <input type="text" bind:value={fontSize} onkeydown={onKey} /></label>
      <label>Weight
        <select bind:value={fontWeight}>
          <option value="300">300</option>
          <option value="400">400</option>
          <option value="500">500</option>
          <option value="600">600</option>
          <option value="700">700</option>
          <option value="800">800</option>
        </select>
      </label>
      <label>Color <input type="color" bind:value={color} /></label>
      <label>Line height <input type="text" bind:value={lineHeight} onkeydown={onKey} /></label>
    </div>
  {:else if activeTab === "sizing"}
    <div class="grid">
      <label>Width <input type="text" bind:value={width} onkeydown={onKey} placeholder="e.g. 50%, 320px, auto" /></label>
      <label>Height <input type="text" bind:value={height} onkeydown={onKey} placeholder="e.g. 100vh, 240px" /></label>
    </div>
  {:else if activeTab === "spacing"}
    <div class="grid">
      <label>Padding <input type="text" bind:value={padding} onkeydown={onKey} placeholder="e.g. 1rem 2rem" /></label>
      <label>Margin <input type="text" bind:value={margin} onkeydown={onKey} placeholder="e.g. 0 auto" /></label>
      <label>Border radius <input type="text" bind:value={borderRadius} onkeydown={onKey} placeholder="e.g. 8px, 50%" /></label>
      <label>Background <input type="color" bind:value={backgroundColor} /></label>
    </div>
    <label class="full">Box shadow
      <input type="text" bind:value={boxShadow} onkeydown={onKey} placeholder="e.g. 0 4px 12px rgba(0,0,0,0.1)" />
    </label>
  {:else if activeTab === "css"}
    <textarea
      class="popup__css"
      bind:value={customCss}
      onkeydown={onKey}
      placeholder={`/* CSS for ${title} */\ncolor: #ff3d6e;\npadding: 1rem;`}
      rows="6"
      spellcheck="false"
    ></textarea>
    <p class="popup__hint">
      Free-form CSS. Combined with Font / Sizing / Spacing values into one
      annotation.
    </p>
  {/if}

  {#if activeTab !== "comment" && (cssChangeCount > 0 || contentDirty)}
    <p class="popup__hint">
      {#if cssChangeCount > 0}
        {cssChangeCount} CSS change{cssChangeCount === 1 ? "" : "s"} captured
      {/if}{#if cssChangeCount > 0 && contentDirty}, {/if}{#if contentDirty}content edited{/if}.
    </p>
  {/if}

  <div class="popup__actions">
    <button class="btn btn--ghost" onclick={oncancel}>Cancel</button>
    <button class="btn btn--primary" onclick={onsubmit} disabled={!canSubmit}>
      Add annotation
    </button>
  </div>
</div>
