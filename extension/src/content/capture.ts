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
//
// Phase 14.5 (chat hardening) — extended the denylist beyond the
// original V1 set to cover patterns we've seen in real customer
// dashboards: session ids, GitHub/GitLab PATs in data-* slots,
// password values, raw API-key dataset names, x-api-key /
// x-auth-token in arbitrary attr names.
const STRIP_ATTR_RE =
  /^(on\w+|integrity|nonce|csp-nonce|password|x-csrf-token|x-api-key|x-auth-token|data-(token|secret|key|auth|jwt|bearer|csrf|session|pat|api-key|tk|password))$/i;

// Inline secret patterns scrubbed from the SERIALIZED HTML string and
// from each nearbyText entry. The element-level attr/script stripping
// above can't catch a token sitting in body text like
// `<span>Authorization: Bearer eyJhbG…</span>` — these patterns plug
// that gap. Replacements use `[REDACTED:<kind>]` so the agent knows
// something was there without seeing it.
//
// Patterns ordered most-specific-first so e.g. `bearer` doesn't eat a
// raw JWT before the JWT regex sees it.
const INLINE_SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "bearer", re: /Bearer\s+[A-Za-z0-9\-_.]+/gi },
  // JWT — three base64url segments separated by `.`. Leading `eyJ`
  // narrows to header-typed (`{"alg":...}`) tokens and avoids matching
  // random three-segment dotted strings.
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // GitHub fine-grained / classic PAT (gho_/ghp_/ghs_/ghu_)
  { kind: "gh-pat", re: /\bgh[opsu]_[A-Za-z0-9]{30,}\b/g },
  // GitLab personal access token
  { kind: "gl-pat", re: /\bglpat-[A-Za-z0-9_-]{15,}\b/g },
  // Anthropic API key (`sk-ant-…`) — match before generic `sk-` so the
  // narrower kind label sticks.
  { kind: "ant-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // OpenAI-style key
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  // Slack token (xoxa/xoxb/xoxp/xoxr/xoxs)
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  // AWS access key id
  { kind: "aws-akia", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Google API key
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // High-entropy base64-ish blob — 40+ chars of base64 alphabet that
  // contains at least one uppercase + one digit. The lookaheads keep
  // ordinary prose (all-lowercase paragraphs) from being scrubbed.
  // Catches long random tokens that don't match any branded pattern.
  {
    kind: "high-entropy",
    re: /\b(?=[A-Za-z0-9+/=_-]*[A-Z])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{40,}\b/g,
  },
];

/**
 * Strip inline secret patterns from a freeform text string. Used on
 * the serialized outerHTML AND on every nearbyText entry. Returns just
 * the scrubbed text — counts/categories are deliberately not surfaced
 * here yet (Phase D's UI will need them; this phase keeps the AnnotationTarget
 * shape unchanged).
 */
export function scrubInlineSecrets(s: string): string {
  if (!s) return s;
  let out = s;
  for (const { kind, re } of INLINE_SECRET_PATTERNS) {
    out = out.replace(re, `[REDACTED:${kind}]`);
  }
  return out;
}

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
  // Element-level scrub handles attributes + script/style/meta bodies.
  // Text-level scrub catches tokens that sit in visible body text
  // (e.g. an Auth-header debug panel that shows `Bearer eyJ…` to the
  // user). Both layers are needed — attribute stripping can't reach
  // text nodes, and pattern stripping can't reach onclick handlers.
  return scrubInlineSecrets(clone.outerHTML);
}

function scrub(node: Element): void {
  // Inline scripts can carry tokens in template literals or assignments.
  if (node.tagName === "SCRIPT") {
    node.textContent = "";
  }
  // Inline <style> blocks can carry `background: url(https://exfil/…?token=…)`
  // payloads OR raw secrets in :pseudo-elements. Drop the body wholesale —
  // the agent gets enough visual context from computedStyles already.
  if (node.tagName === "STYLE") {
    node.textContent = "";
  }
  // <meta> tags carry CSRF / OAuth state / app session ids in real
  // dashboards (`<meta name="csrf-token" content="…">`). Pinta never
  // needs meta context from the captured fragment — drop entirely.
  if (node.tagName === "META") {
    node.remove();
    return;
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
    const raw = (
      (current as HTMLElement).innerText ??
      current.textContent ??
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NEARBY_TEXT_MAX);
    // Run the inline-secret scrub before the dedupe lookup so two
    // sibling tokens don't both pass through just because the chars
    // around them differ.
    const text = scrubInlineSecrets(raw);
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
