import type { AnnotationTarget } from "@pinta/shared";
import { buildSelector } from "./selector.js";

const STYLE_PROPS = [
  "color",
  "background-color",
  "background-image",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "padding",
  "margin",
  "border",
  "border-radius",
  "box-shadow",
  "display",
  "width",
  "height",
];

const HTML_TRUNCATE = 2_000;
const NEARBY_LEVELS = 3;
const NEARBY_TEXT_MAX = 200;

// Attribute names to drop wholesale before serializing outerHTML for
// the agent. Inline event handlers (`onclick`, `onerror`, ...) plus
// known token / nonce / auth carriers. Class / id / role / aria-* are
// kept — they're structural and helpful for selector verification.
const STRIP_ATTR_RE =
  /^(on\w+|integrity|nonce|csp-nonce|x-csrf-token|data-(token|secret|key|auth|jwt|bearer|csrf))$/i;

/**
 * Returns the element's outerHTML with attributes / inline scripts that
 * commonly leak credentials removed. Operates on a clone so the live
 * DOM is untouched. The agent gets enough structural detail to verify
 * a selector match without seeing CSRF tokens, bearer auth, or password
 * input values that happened to sit inside the captured fragment.
 */
function sanitizeOuterHtml(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  scrub(clone);
  return clone.outerHTML;
}

function scrub(node: Element): void {
  // Inline scripts can carry tokens in template literals or assignments.
  if (node.tagName === "SCRIPT") {
    node.textContent = "";
  }
  // Password input values are obviously sensitive.
  if (
    node.tagName === "INPUT" &&
    (node as HTMLInputElement).type === "password"
  ) {
    node.removeAttribute("value");
  }
  // Drop suspicious-named attributes.
  for (const attr of [...node.attributes]) {
    if (STRIP_ATTR_RE.test(attr.name)) {
      node.removeAttribute(attr.name);
    }
  }
  for (const child of [...node.children]) scrub(child);
}

export function captureTarget(el: Element): AnnotationTarget {
  const cs = window.getComputedStyle(el);
  const computedStyles: Record<string, string> = {};
  for (const prop of STYLE_PROPS) {
    const value = cs.getPropertyValue(prop);
    if (value) computedStyles[prop] = value.trim();
  }

  let html = sanitizeOuterHtml(el);
  if (html.length > HTML_TRUNCATE) {
    html = html.slice(0, HTML_TRUNCATE) + "…";
  }

  const rect = el.getBoundingClientRect();
  const sourceFile = readDataAttr(el, "data-source-file");
  const sourceLineRaw = readDataAttr(el, "data-source-line");
  const sourceLine = sourceLineRaw ? Number(sourceLineRaw) : undefined;

  return {
    selector: buildSelector(el),
    outerHTML: html,
    computedStyles,
    nearbyText: collectNearbyText(el),
    boundingRect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    sourceFile,
    sourceLine: Number.isFinite(sourceLine) ? sourceLine : undefined,
  };
}

function collectNearbyText(el: Element): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: Element | null = el;
  let depth = 0;

  while (current && depth <= NEARBY_LEVELS) {
    const text = (
      (current as HTMLElement).innerText ??
      current.textContent ??
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NEARBY_TEXT_MAX);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
    current = current.parentElement;
    depth++;
  }
  return out;
}

function readDataAttr(el: Element, attr: string): string | undefined {
  // Walk up — vite-plugin-pinta tags root elements of components only.
  let current: Element | null = el;
  while (current) {
    const v = current.getAttribute(attr);
    if (v) return v;
    current = current.parentElement;
  }
  return undefined;
}
