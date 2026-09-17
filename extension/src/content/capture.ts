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
  //
  // The lookaheads are BOUNDED on purpose. Unbounded ({0,} / *) they make
  // this quadratic: "+ / = - _" are non-word characters, so nearly every
  // position in a long run of the charset is a , and each one rescanned
  // the whole run looking for an uppercase or a digit. A planted
  // "a/"-repeated text node (100 KB, no uppercase) took 18 SECONDS on the
  // page's main thread. A bound makes each position O(256) instead of
  // O(n) — real credentials carry an uppercase and a digit long before
  // then, so nothing that matters stops matching.
  {
    kind: "high-entropy",
    re: /\b(?=[A-Za-z0-9+/=_-]{0,256}[A-Z])(?=[A-Za-z0-9+/=_-]{0,256}\d)[A-Za-z0-9+/=_-]{40,}\b/g,
  },
];

/**
 * Strip inline secret patterns from a freeform text string. Used on
 * the serialized outerHTML AND on every nearbyText entry. Returns just
 * the scrubbed text — counts/categories are deliberately not surfaced
 * here yet (Phase D's UI will need them; this phase keeps the AnnotationTarget
 * shape unchanged).
 */
/** Belt to the bounded-lookahead braces: skip the unbranded high-entropy
 *  sweep on input this large. Every caller is capped well below it
 *  (outerHTML is sliced before scrubbing, nearbyText at 200 chars/level,
 *  URLs are short), so crossing this line means a new unbounded caller
 *  appeared — and the branded patterns, which are cheap, still run. */
const HIGH_ENTROPY_MAX = 32 * 1024;

export function scrubInlineSecrets(s: string): string {
  if (!s) return s;
  let out = s;
  for (const { kind, re } of INLINE_SECRET_PATTERNS) {
    if (kind === "high-entropy" && s.length > HIGH_ENTROPY_MAX) continue;
    out = out.replace(re, `[REDACTED:${kind}]`);
  }
  return out;
}

/**
 * The same sweep for a URL query / fragment VALUE, minus `high-entropy`.
 * That pattern's charset includes `/`, `-` and `_`, so a long
 * percent-decoded redirect target ("?redirect_uri=https://app.dev/Settings1/
 * TeamMembers/BillingPlan") matches it and the agent gets a page URL it
 * can't navigate to. In freeform HTML an opaque 40-char blob really is
 * suspicious; in a URL value it is usually just a path, and the branded
 * patterns still catch every actual credential shape.
 */
function scrubUrlValue(v: string): string {
  if (!v) return v;
  let out = v;
  for (const { kind, re } of INLINE_SECRET_PATTERNS) {
    if (kind === "high-entropy") continue;
    out = out.replace(re, `[REDACTED:${kind}]`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// URL scrubbing. Page URLs ride to the companion / agent (annotation.url,
// session url, module queries). OAuth callbacks, magic links and signed
// URLs carry credentials in the query or fragment — redact them.

/** Key WORDS that mark a query / fragment parameter as a credential.
 *  Matched per word (`access_token`, `accessToken`, `X-Amz-Signature`
 *  → access/token, x/amz/signature) so `design` or `monkey` don't hit. */
const SENSITIVE_KEY_WORDS = new Set([
  "token", "tokens", "code", "secret", "key", "apikey", "auth", "authorization",
  "session", "sessionid", "sid", "password", "passwd", "pwd", "sig",
  "signature", "access", "refresh", "jwt", "bearer", "credential",
  "credentials", "otp", "nonce", "ticket", "saml", "samlresponse",
]);
export const REDACTED = "REDACTED";

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveParamKey(key: string): boolean {
  const words = keyWords(key);
  const whole = words.join("");
  return words.some((w) => SENSITIVE_KEY_WORDS.has(w)) || SENSITIVE_KEY_WORDS.has(whole);
}

/** Whether this key=value pair must be redacted. One rule for the query
 *  string and the fragment, so both stay consistent (and idempotent — an
 *  already-redacted value is left alone). */
export function shouldRedactParam(key: string, value: string): boolean {
  return value !== REDACTED && isSensitiveParamKey(key);
}

/**
 * Redact INSIDE a fragment rather than dropping it. Hash-routed SPAs keep
 * the route there ("#/board/42?tab=open"), and a URL stripped back to
 * "https://app/" tells the agent nothing about which screen the annotation
 * belongs to — and makes two different routes compare equal, which breaks
 * pin replay. Returns the fragment without its leading "#".
 */
/** decodeURIComponent throws on a lone "%" — and Chrome leaves one in the
 *  fragment verbatim ("#q=100%"). scrubUrl runs on every annotation
 *  capture, so a throw here would take the whole path down. */
function decodeParam(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function scrubFragment(frag: string): string {
  const qi = frag.indexOf("?");
  const route = qi === -1 ? "" : frag.slice(0, qi);
  const rest = qi === -1 ? frag : frag.slice(qi + 1);
  // Only treat the tail as parameters when it really looks like pairs —
  // "#/board/42" is a route, not a query. OAuth implicit-flow fragments
  // ("#access_token=…&token_type=bearer") have no "?" and hit this too.
  const looksLikePairs = /^[^?#&=]+=[^&]*(?:&[^?#&=]+=[^&]*)*$/.test(rest);
  if (!looksLikePairs) return scrubInlineSecrets(frag);
  const out: string[] = [];
  for (const pair of rest.split("&")) {
    const eq = pair.indexOf("=");
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    // Key-matching alone is not enough: "#u=alice&t=<JWT>" has no
    // sensitive-looking key, so the value gets the pattern sweep too —
    // on the DECODED form, so percent-encoding can't hide a token.
    const dec = decodeParam(v);
    if (shouldRedactParam(k, dec)) {
      out.push(`${k}=${REDACTED}`);
      continue;
    }
    const swept = scrubUrlValue(dec);
    out.push(`${k}=${swept === dec ? v : encodeURIComponent(swept)}`);
  }
  const query = out.join("&");
  return qi === -1 ? query : `${scrubInlineSecrets(route)}?${query}`;
}

/**
 * Redact credential-like parts of a URL before it leaves the page:
 *  - query values whose KEY looks sensitive become `REDACTED`;
 *  - the same treatment inside the fragment, which is kept so hash routes
 *    survive (see scrubFragment).
 * Idempotent and stable (same input → same output), so scrubbed URLs
 * still compare equal. Non-URL input is returned scrubbed of inline
 * secrets only; empty stays empty.
 */
export function scrubUrl(url: string): string {
  if (typeof url !== "string" || url === "") return "";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return scrubInlineSecrets(url);
  }
  // file:, chrome-extension:, custom schemes: we don't reason about their
  // query shape, but an inline secret in one still must not travel.
  if (!/^https?:$/.test(u.protocol)) return scrubInlineSecrets(url);
  let changed = false;
  if (u.username || u.password) {
    u.username = "";
    u.password = "";
    changed = true;
  }
  if (u.search) {
    const params = new URLSearchParams();
    let redacted = false;
    // Rebuilt in order so a scrubbed URL keeps its parameter layout.
    for (const [k, v] of new URLSearchParams(u.search)) {
      const hide = shouldRedactParam(k, v);
      const safe = hide ? REDACTED : scrubUrlValue(v);
      if (safe !== v) redacted = true;
      params.append(k, safe);
    }
    if (redacted) {
      u.search = params.toString();
      changed = true;
    }
  }
  if (u.hash) {
    const frag = u.hash.slice(1);
    const next = scrubFragment(frag);
    if (next !== frag) {
      u.hash = next ? `#${next}` : "";
      changed = true;
    }
  }
  if (!changed) return url;
  // URL serializes an emptied fragment without the "#".
  return u.toString();
}

/**
 * An agent-supplied link is only rendered / stored as a link when it is
 * https:, or http: on a loopback host. Returns the normalized URL or
 * undefined.
 */
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (u.username || u.password) return undefined;
  if (u.protocol === "https:") return u.toString();
  if (
    u.protocol === "http:" &&
    (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")
  ) {
    return u.toString();
  }
  return undefined;
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
  // Slice BEFORE scrubbing. The caller truncates to HTML_TRUNCATE anyway,
  // so scrubbing megabytes of a large container is pure cost — and a token
  // severed mid-string is not a usable credential. The headroom leaves room
  // for the scrub's own "[REDACTED:…]" expansions to fit inside the cap.
  const raw = clone.outerHTML;
  const bounded = raw.length > HTML_TRUNCATE * 4 ? raw.slice(0, HTML_TRUNCATE * 4) : raw;
  return scrubInlineSecrets(bounded);
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
