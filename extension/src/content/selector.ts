// Builds a short, stable-ish CSS selector for an element.
// Goal: human-readable, sufficient for grep + verification — not a guarantee
// of uniqueness. The agent always confirms before editing.

const MAX_DEPTH = 4;
const SAFE_CLASS = /^[a-zA-Z_-][\w-]*$/;

export function buildSelector(el: Element): string {
  const path: string[] = [];
  let current: Element | null = el;
  let depth = 0;

  while (current && depth < MAX_DEPTH && current !== document.documentElement) {
    const segment = segmentFor(current);
    path.unshift(segment);
    if (segment.startsWith("#")) break;
    current = current.parentElement;
    depth++;
  }

  return path.join(" > ");
}

function segmentFor(el: Element): string {
  if (el.id) {
    const safeId = escape(el.id);
    if (document.querySelectorAll(`#${safeId}`).length === 1) {
      return `#${safeId}`;
    }
  }

  const tag = el.tagName.toLowerCase();
  const classes = [...el.classList].filter(
    (c) => SAFE_CLASS.test(c) && !c.startsWith("svelte-"),
  );

  if (classes.length > 0) {
    return `${tag}.${classes.slice(0, 3).map(escape).join(".")}`;
  }

  if (el.parentElement) {
    const idx = [...el.parentElement.children].indexOf(el) + 1;
    return `${tag}:nth-child(${idx})`;
  }
  return tag;
}

function escape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/[^\w-]/g, (c) => `\\${c}`);
}
