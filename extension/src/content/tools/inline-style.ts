// Shared inline-style layering for the live-preview tools (Select, Text,
// Paint, Resize, Scale). These tools all work the same way: reset the
// element to a KNOWN base, then re-apply their own changes on top. Doing
// the reset makes each keystroke idempotent (a value the user clears is
// actually removed).
//
// The bug this module fixes: every tool used to reset to the element's
// TRUE original inline style and re-apply only ITS changes — so painting
// an element that had already been resized + text-formatted wiped the
// resize and text. The base must instead be the element's inline style as
// captured when THIS tool started, which already carries every earlier
// tool's edits. `applyPreview` layers a tool's changes onto that base;
// `rebuildInline` re-derives an element's style from the true original
// plus a set of still-active changes (used when one of several
// annotations on the same element is removed).

/** Minimal shape we need — lets the pure logic be unit-tested against a
 *  jsdom element or any object exposing a CSSStyleDeclaration. */
export type Styleable = { style: CSSStyleDeclaration };

/**
 * Re-apply a tool's live-preview `changes` on top of `base` (the element's
 * inline `cssText` captured BEFORE this tool started — so it already
 * includes every earlier tool's edits). Resetting to `base` first keeps
 * the apply idempotent as the user tweaks values, WITHOUT discarding other
 * tools' work. An empty / whitespace value skips that property (a cleared
 * field contributes nothing rather than an invalid declaration).
 */
export function applyPreview(
  el: Styleable,
  base: string,
  changes: Record<string, string>,
): void {
  el.style.cssText = base;
  for (const [prop, value] of Object.entries(changes)) {
    if (!value || !value.trim()) continue;
    try {
      el.style.setProperty(prop, value);
    } catch {
      // ignore invalid property / value — one bad pair shouldn't wipe the
      // rest of the preview
    }
  }
}

/**
 * The inline-style delta a tool applied: every property whose value in
 * `appliedCssText` differs from `baseCssText`, plus properties the tool
 * REMOVED (present in base, gone in applied) recorded as "". Parsing is
 * delegated to the browser via throwaway probe elements, so complex values
 * (`url(...)`, gradients, quoted content) can't corrupt the diff. Returns
 * the delta as a prop→value map — this is what gets stored per annotation
 * and replayed by {@link rebuildInline} when a sibling is removed.
 *
 * `makeProbe` defaults to `document.createElement`; tests can inject one.
 */
export function diffAppliedProps(
  baseCssText: string,
  appliedCssText: string,
  makeProbe: () => Styleable = () => document.createElement("div"),
): Record<string, string> {
  const base = makeProbe();
  base.style.cssText = baseCssText;
  const applied = makeProbe();
  applied.style.cssText = appliedCssText;
  const out: Record<string, string> = {};
  for (let i = 0; i < applied.style.length; i++) {
    const prop = applied.style[i]!;
    const value = applied.style.getPropertyValue(prop);
    if (base.style.getPropertyValue(prop) !== value) out[prop] = value;
  }
  for (let i = 0; i < base.style.length; i++) {
    const prop = base.style[i]!;
    if (!applied.style.getPropertyValue(prop)) out[prop] = "";
  }
  return out;
}

/**
 * Re-derive an element's inline style from its TRUE original plus the
 * ordered `changeSets` of the annotations that still apply to it. Used
 * when one of several annotations on the same element is removed: instead
 * of snapping back to the true original (which would drop the siblings),
 * we replay the survivors. Later change sets win over earlier ones for the
 * same property (last-writer), matching how the previews stacked live. A
 * "" value in a change set removes that property (mirrors a tool that
 * cleared it).
 */
export function rebuildInline(
  el: Styleable,
  trueOriginalCssText: string,
  changeSets: Record<string, string>[],
): void {
  el.style.cssText = trueOriginalCssText;
  for (const changes of changeSets) {
    for (const [prop, value] of Object.entries(changes)) {
      try {
        if (value && value.trim()) el.style.setProperty(prop, value);
        else el.style.removeProperty(prop); // "" = the annotation cleared it
      } catch {
        // ignore invalid property / value
      }
    }
  }
}
