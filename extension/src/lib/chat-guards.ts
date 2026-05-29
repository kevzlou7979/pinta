// Defensive helpers for the chat module — Phase 14.5 (chat hardening).
//
// `scrubInlineSecrets` (in content/capture.ts) handles secret patterns
// at capture time. This file covers what the EXTENSION SIDE adds on
// top before a chat queryComment goes over the WS:
//
//  - `detectInjectionMarkers` — pattern-scans captured outerHTML +
//    nearbyText for known prompt-injection openings ("ignore previous
//    instructions", role-prefix injections, persona overrides). Returns
//    a deduped list of marker kinds found. Callers add the result to
//    the queryComment's `context` so the skill can decide how cautious
//    to be, and (Phase D) the UI can show a "page tried to instruct
//    the agent" banner.
//  - `scanCapturedContextForInjection` — convenience wrapper that walks
//    a list of annotation context entries (outerHTML + nearbyText[])
//    and returns the union of marker kinds across all entries.
//
// The detector intentionally errs toward false-positives — the
// downstream consequence is "agent is more cautious" + a UI badge,
// which costs nothing if the page wasn't actually hostile. Real
// adversaries will craft around any pattern list, so this is a
// usability + defense-in-depth feature, not a security guarantee.

const INJECTION_MARKERS: { kind: string; re: RegExp }[] = [
  // "Ignore the previous instructions" + chained-modifier variants
  // ("Ignore all prior rules now"). Allow up to 3 filler words between
  // `ignore` and the target noun so multi-word qualifiers like
  // "all prior" / "the previous above" still match.
  { kind: "ignore-instructions", re: /ignore(?:\s+\w+){0,3}\s+(?:instructions?|prompt|context|rules?|system)/i },
  // "Disregard the system prompt" + chained-modifier variants.
  { kind: "disregard-instructions", re: /disregard(?:\s+\w+){0,3}\s+(?:instructions?|prompt|context|rules?|system)/i },
  // "system:" / "user:" / "assistant:" as a line opener — chat-role
  // injection. Multiline so it matches mid-string. Requires a leading
  // newline or start-of-string to avoid matching legitimate prose like
  // "the user: clicked the button".
  { kind: "role-injection", re: /(?:^|\n)\s*(?:system|user|assistant)\s*:\s*\S/im },
  // Claude / Llama instruction-template markers.
  { kind: "inst-marker", re: /\[\/?(?:INST|SYS|s|inst|system|prompt|admin|sudo)\]/i },
  // Persona override openings — "You are now an evil pirate". Case-
  // insensitive (`i` flag) so the dropped initial "You" cap still
  // catches lowercased adversarial copy. Trailing `\b` keeps the
  // match anchored to a complete word boundary rather than running
  // into the next noun.
  { kind: "persona-override", re: /(?:^|\n)\s*you\s+are\s+(?:now|actually|going\s+to\s+(?:be|act\s+as))\b/im },
  // HTML-ish injection tags pretending to be a system message.
  { kind: "tag-injection", re: /<\s*\/?\s*(?:system|prompt|sudo|admin|instructions?)\s*>/i },
];

/**
 * Scan a single text blob (outerHTML or nearbyText entry) for
 * known prompt-injection openings. Returns the matching marker
 * kinds (deduped). Empty array when nothing matched.
 */
export function detectInjectionMarkers(s: string): string[] {
  if (!s) return [];
  const hits = new Set<string>();
  for (const { kind, re } of INJECTION_MARKERS) {
    if (re.test(s)) hits.add(kind);
  }
  return [...hits];
}

/**
 * Convenience wrapper for chat send paths: walks a list of annotation
 * contexts (each carrying optional outerHTML + nearbyText[]) and
 * returns the union of marker kinds found across all entries. Used
 * by `sendAnnotateChatMessage*` to populate `context.injectionMarkers`
 * in the queryComment without each call site re-implementing the walk.
 */
export function scanCapturedContextForInjection(
  entries: Array<{ outerHTML?: string; nearbyText?: readonly string[] }>,
): string[] {
  const hits = new Set<string>();
  for (const e of entries) {
    if (e.outerHTML) {
      for (const k of detectInjectionMarkers(e.outerHTML)) hits.add(k);
    }
    if (e.nearbyText) {
      for (const t of e.nearbyText) {
        for (const k of detectInjectionMarkers(t)) hits.add(k);
      }
    }
  }
  return [...hits];
}

// ─────────────────────────────────────────────────────────────────────
// PII redaction — Phase 14.5
// ─────────────────────────────────────────────────────────────────────
//
// Patterns ordered so the more specific match wins (e.g. credit-card
// before generic "long-id" — both are digit runs, but a Luhn-valid
// card should be labelled as such for the agent's benefit).
//
// Each entry is `{ kind, re, validate? }`. When `validate` is present
// it runs against each match; if it returns false the match is left
// untouched. Used by credit-card to enforce Luhn.

/**
 * Luhn check — used to validate that a 13-19 digit run is plausibly a
 * real card number before redacting. Cuts false-positives on long
 * receipt / barcode / order numbers that happen to share the length.
 */
function passesLuhn(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const PII_PATTERNS: {
  kind: string;
  re: RegExp;
  validate?: (m: string) => boolean;
}[] = [
  // Email — pragmatic, not RFC-perfect. Catches the realistic shapes
  // ("a.b+tag@host.co.uk") without trying to match every legal address.
  { kind: "email", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  // US Social Security number — `nnn-nn-nnnn`. Locale-specific but the
  // shape is distinctive enough to flag globally; non-US users rarely
  // have this exact pattern in legitimate copy.
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit card — 13–19 digits, optional separators (`-` or space)
  // between groups. Validated against Luhn so order numbers and
  // tracking codes that share the shape are spared.
  {
    kind: "card",
    re: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: passesLuhn,
  },
  // International phone numbers — E.164 (`+12025550123`) or common
  // US/EU formatting with separators. Requires at least one separator
  // OR a `+` prefix so we don't catch every long digit run.
  {
    kind: "phone",
    re: /(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?|\d{2,4}[ -])\d{2,4}[ -]?\d{2,4}(?:[ -]?\d{1,4})?/g,
  },
  // Long contiguous digit run — 9+ digits not adjacent to `$` (price)
  // or `%` (percent). Catches customer / order / record IDs without
  // rewriting numeric metrics. Runs LAST so card / SSN / phone get
  // their specific label first.
  { kind: "long-id", re: /(?<![$%\d.])\d{9,}(?![\d.%])/g },
];

/**
 * Scrub PII patterns from a freeform text string. Used on captured
 * outerHTML + each nearbyText entry from the chat send path when the
 * chat module's `redact_pii` setting is on (default). Replaces every
 * match with `[REDACTED:<kind>]` and returns the rewritten string.
 *
 * Each PII pattern is replaced ONCE per match — the regex `g` flag
 * walks the input linearly without re-matching the replacement string
 * (the brackets in `[REDACTED:…]` aren't in any pattern's character
 * class, so re-entry is structurally impossible).
 */
/**
 * Count `[REDACTED:<kind>]` placeholders in a string, grouped by kind.
 * Used after queryComment serialization to surface a "we scrubbed N
 * emails / 1 token / etc." badge in the chat UI — gives the user
 * visibility into the hardening without needing to inspect the wire.
 */
export function countRedactionPlaceholders(s: string): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!s) return counts;
  const re = /\[REDACTED:([a-z-]+)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const kind = m[1]!.toLowerCase();
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

export function redactPii(s: string): string {
  if (!s) return s;
  let out = s;
  for (const { kind, re, validate } of PII_PATTERNS) {
    out = out.replace(re, (match) => {
      if (validate && !validate(match)) return match;
      return `[REDACTED:${kind}]`;
    });
  }
  return out;
}

