// Pure helpers for Code Review (Phase 23). Extracted from
// state.svelte.ts (pattern: audit-flow.ts / design-variants.ts) so they
// unit-test without the chrome.* surface or Svelte's $state runtime.
//
// The module plays the current change set as a gamified deck: the agent
// gathers cards (one per LOGICAL change) with a plain-words title +
// description and a bounded unified diff; the extension owns all the
// scoring — pass/fail verdicts, streak, grade — via the pure functions
// here so they're testable and never drift from the UI.

// ---------------------------------------------------------------------------
// Types

export type ReviewRisk = "low" | "medium" | "high";

export type ReviewCard = {
  id: string;
  /** ≤ TITLE_MAX chars, imperative ("Debounce the search input"). */
  title: string;
  /** ≤ 2 plain-words sentences — what the change does, not the diff. */
  description: string;
  /** Repo-relative path of the (primary) changed file. */
  file: string;
  language?: string;
  /** Unified diff, ≤ CARD_DIFF_MAX chars (truncated with a marker). */
  diff: string;
  risk?: ReviewRisk;
};

export type ReviewSource = "working-tree" | "last-commit" | "topic";

export type ReviewRun = {
  runId: string;
  createdAt: number;
  source: ReviewSource;
  commitRef?: string;
  /** Topic-mode runs: the user's focus prompt (e.g. "MFA authentication").
   *  The cards are relevant CODE SECTIONS, not diff hunks. */
  topic?: string;
  cards: ReviewCard[];
  /** Hunk-groups the agent had to drop over the card cap. */
  dropped: number;
};

export type ReviewVerdict = "pass" | "fail";

export type ReviewFixResult = {
  cardId?: string;
  summary: string;
  files: { path: string; note?: string }[];
};

export type DiffLine = {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
};

// ---------------------------------------------------------------------------
// Caps (re-enforced extension-side; the SKILL asks the agent to respect
// them, but a lenient parser is the real defense against skew).

export const MAX_REVIEW_CARDS = 25;
export const CARD_DIFF_MAX = 4096;
export const TITLE_MAX = 60;
export const DIFF_TRUNCATED_MARKER = "\n… [diff truncated]";
/** Cap on the topic prompt (token economy — a steer, not a spec). */
export const MAX_TOPIC_CHARS = 120;

/** Normalize the topic prompt: collapse whitespace, trim, cap. */
export function normalizeTopic(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC_CHARS);
}

// ---------------------------------------------------------------------------
// Alias-tolerant parsing (mirrors handleAuditSync / design-variants —
// the main defense against SKILL.md / extension version skew).

const RUN_TYPE_ALIASES = new Set([
  "code-review-run",
  "review-run",
  "code-review",
]);

const LEARN_TYPE_ALIASES = new Set(["code-review-learn", "review-learn"]);

const FIXED_TYPE_ALIASES = new Set(["code-review-fixed", "review-fixed"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tryParse(summary: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(summary));
  } catch {
    return null;
  }
}

function firstString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/** Clamp a diff at the cap, appending the truncation marker. */
export function clampDiff(diff: string): string {
  if (diff.length <= CARD_DIFF_MAX) return diff;
  return diff.slice(0, CARD_DIFF_MAX) + DIFF_TRUNCATED_MARKER;
}

/**
 * Parse + validate a review-gather result. `expectedRunId` guards
 * against a stale run's late completion (compared only when the payload
 * carries a runId at all — leniency over strictness for older agents).
 * Returns null when the summary isn't recognizably a review run.
 */
export function parseReviewRun(
  summary: string,
  expectedRunId: string,
): Omit<ReviewRun, "createdAt"> | null {
  const obj = tryParse(summary);
  if (!obj) return null;
  const rawCards = obj.cards ?? obj.items ?? obj.hunks;
  const typeOk =
    typeof obj.type === "string"
      ? RUN_TYPE_ALIASES.has(obj.type)
      : Array.isArray(rawCards); // duck-type
  if (!typeOk || !Array.isArray(rawCards)) return null;
  if (typeof obj.runId === "string" && obj.runId && obj.runId !== expectedRunId) {
    return null;
  }
  const cards: ReviewCard[] = [];
  for (const raw of rawCards) {
    const c = asRecord(raw);
    if (!c) continue;
    const diff = firstString(c, ["diff", "patch", "hunk"]);
    const file = firstString(c, ["file", "path", "filePath"]);
    if (!diff || !file) continue; // a card with nothing to review is useless
    const title =
      firstString(c, ["title", "label", "name"]) ?? `Change ${cards.length + 1}`;
    const riskRaw = firstString(c, ["risk", "severity"])?.toLowerCase();
    cards.push({
      id:
        typeof c.id === "string" && c.id ? c.id : `card-${cards.length + 1}`,
      title: title.length > TITLE_MAX ? title.slice(0, TITLE_MAX) : title,
      description: firstString(c, ["description", "desc", "summary"]) ?? "",
      file,
      language: typeof c.language === "string" ? c.language : undefined,
      diff: clampDiff(diff),
      risk:
        riskRaw === "low" || riskRaw === "medium" || riskRaw === "high"
          ? riskRaw
          : undefined,
    });
    if (cards.length >= MAX_REVIEW_CARDS) break;
  }
  if (cards.length === 0) return null;
  const source: ReviewSource =
    obj.source === "last-commit"
      ? "last-commit"
      : obj.source === "topic"
        ? "topic"
        : "working-tree";
  return {
    runId: typeof obj.runId === "string" && obj.runId ? obj.runId : expectedRunId,
    source,
    topic:
      typeof obj.topic === "string" && obj.topic.trim() !== ""
        ? obj.topic.trim()
        : undefined,
    commitRef:
      typeof obj.commitRef === "string" && obj.commitRef
        ? obj.commitRef
        : undefined,
    cards,
    dropped:
      typeof obj.dropped === "number" && obj.dropped > 0
        ? Math.round(obj.dropped)
        : 0,
  };
}

export function parseLearnReply(summary: string): string | null {
  const obj = tryParse(summary);
  if (!obj) {
    // Older agents may return plain markdown instead of the JSON
    // envelope — accept it verbatim rather than erroring the sheet.
    return summary.trim() !== "" ? summary : null;
  }
  if (typeof obj.type === "string" && !LEARN_TYPE_ALIASES.has(obj.type)) {
    return null;
  }
  return firstString(obj, ["reply", "answer", "text", "message"]) ?? null;
}

export function parseFixResult(summary: string): ReviewFixResult | null {
  const obj = tryParse(summary);
  if (!obj) return null;
  const typeOk =
    typeof obj.type === "string"
      ? FIXED_TYPE_ALIASES.has(obj.type)
      : typeof obj.summary === "string"; // duck-type
  if (!typeOk) return null;
  const files: { path: string; note?: string }[] = [];
  const rawFiles = obj.files ?? obj.changedFiles;
  if (Array.isArray(rawFiles)) {
    for (const raw of rawFiles) {
      const f = asRecord(raw);
      if (f && typeof f.path === "string" && f.path) {
        files.push({
          path: f.path,
          note: typeof f.note === "string" ? f.note : undefined,
        });
      }
    }
  }
  return {
    cardId: typeof obj.cardId === "string" ? obj.cardId : undefined,
    summary: firstString(obj, ["summary", "result", "message"]) ?? "",
    files,
  };
}

// ---------------------------------------------------------------------------
// Scoring / gamification (pure — the deck UI renders these verbatim)

export function scoreRun(
  cards: ReviewCard[],
  verdicts: Record<string, ReviewVerdict>,
): { passed: number; failed: number; reviewed: number; total: number; pct: number } {
  let passed = 0;
  let failed = 0;
  for (const c of cards) {
    const v = verdicts[c.id];
    if (v === "pass") passed++;
    else if (v === "fail") failed++;
  }
  const reviewed = passed + failed;
  const pct = reviewed === 0 ? 0 : Math.round((passed / reviewed) * 100);
  return { passed, failed, reviewed, total: cards.length, pct };
}

export type ReviewGrade = "S" | "A" | "B" | "C" | "D";

/** Thresholds locked in SPEC.md Phase 23 — S is a perfect deck. */
export function gradeFor(pct: number): ReviewGrade {
  if (pct >= 100) return "S";
  if (pct >= 90) return "A";
  if (pct >= 75) return "B";
  if (pct >= 60) return "C";
  return "D";
}

export function gradeBlurb(grade: ReviewGrade): string {
  switch (grade) {
    case "S":
      return "Flawless deck — every change passed.";
    case "A":
      return "Sharp work. A couple of cards need love.";
    case "B":
      return "Solid, with a few fixes queued up.";
    case "C":
      return "Some rough edges — worth a fix pass before shipping.";
    default:
      return "Lots of fails — run the fixes, then deal again.";
  }
}

/** Consecutive-pass streak reducer. */
export function nextStreak(current: number, verdict: ReviewVerdict): number {
  return verdict === "pass" ? current + 1 : 0;
}

// ---------------------------------------------------------------------------
// Diff rendering input

/**
 * Classify a unified diff into renderable lines. `+++`/`---` file
 * headers are context (not add/del), `@@` hunk headers get their own
 * kind. CRLF-safe.
 */
export function splitDiffLines(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const raw of diff.split("\n")) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    let kind: DiffLine["kind"];
    if (text.startsWith("@@")) kind = "hunk";
    else if (text.startsWith("+++") || text.startsWith("---")) kind = "ctx";
    else if (text.startsWith("+")) kind = "add";
    else if (text.startsWith("-")) kind = "del";
    else kind = "ctx";
    out.push({ kind, text });
  }
  return out;
}
