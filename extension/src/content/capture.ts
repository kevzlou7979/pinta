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

export function captureTarget(el: Element): AnnotationTarget {
  const cs = window.getComputedStyle(el);
  const computedStyles: Record<string, string> = {};
  for (const prop of STYLE_PROPS) {
    const value = cs.getPropertyValue(prop);
    if (value) computedStyles[prop] = value.trim();
  }

  let html = el.outerHTML;
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
