// Pure helpers for the Report module (Phase 16). Extracted from
// state.svelte.ts so the deterministic parts — range windows, the
// weekend-fold rule, the clean-markdown export, and agent-payload
// validation — can be unit-tested without booting the chrome.* API
// surface or Svelte's $state runtime.
//
// Data flow: the /pinta agent gathers "what we shipped" from git +
// gh/glab + Pinta session history over a date window and returns a
// ReportRun whose `days` are TRUE-dated (weekend days included). The
// extension stores that faithfully and applies `foldWeekends` only at
// render time, so the fold is a reversible presentation transform.

export type ReportRange = "daily" | "weekly" | "sprint" | "custom";

/** Buckets an item lands in. Drives the category chip + optional
 *  group-by-category export. The agent picks one per item (usually from
 *  a conventional-commit prefix or the Pinta activity kind). */
export type ReportCategory =
  | "bug-fix"
  | "feature"
  | "polish"
  | "test"
  | "annotate"
  | "merge"
  | "deps"
  | "docs"
  | "chore";

/** Where an item came from — drives the small source glyph. "manual" is a
 *  hand-typed custom entry (see ReportCustomItem). */
export type ReportSource =
  | "git"
  | "pr"
  | "issue"
  | "pinta-annotate"
  | "pinta-audit"
  | "pinta-test"
  | "manual";

export type ReportItem = {
  /** Stable id for keying + dedupe. Synthesized from ref/title if the
   *  agent omits it. */
  id: string;
  /** Short reference shown as a chip — "#290", "!57", a commit short
   *  sha. Optional (a bare merge/integration line has none). */
  ref?: string;
  /** Link to the PR/issue/commit, if the agent resolved one. */
  url?: string;
  /** One-line description. The load-bearing field. */
  title: string;
  /** Optional longer note (rarely set in v1). */
  detail?: string;
  category: ReportCategory;
  source: ReportSource;
  /** Which project/repo this item came from — the repo folder name
   *  (e.g. "insclix-awp-2.0"). Set by the agent when a report spans
   *  multiple projects so the cards + export can group by project.
   *  Single-project reports may leave it unset. */
  project?: string;
  /** True when the user typed this entry by hand (a merged custom-cache
   *  item) rather than the agent gathering it — drives the "Manual" badge
   *  and the inline delete control in the cards. Never set on agent
   *  payloads. */
  userAdded?: boolean;
  /** Top changed-file paths for this item (commits mostly), repo-relative
   *  and capped for the compact view — the agent sends the first few, not
   *  every file. Drives the small file line under the title. */
  files?: string[];
  /** Total number of files the item changed, when it's more than `files`
   *  carries (drives the "+N more" suffix). Omit when it equals
   *  `files.length`. */
  fileCount?: number;
  /** Nested sub-entries for a roll-up item — e.g. a "Pinta annotations"
   *  parent whose children are each annotation's comment. The card renders
   *  them behind a collapsible disclosure and the markdown export indents
   *  them under the parent bullet. Omit (or empty) for a plain item. */
  children?: ReportItemChild[];
};

/** One nested entry under a roll-up ReportItem (e.g. a single Pinta
 *  annotation's comment). Deliberately minimal — a one-line title, plus an
 *  optional ref/url so an expanded child can still link out. */
export type ReportItemChild = {
  /** One-line label (humanized at render/export time like a parent title). */
  title: string;
  /** Optional short ref shown before the title (e.g. a page path). */
  ref?: string;
  /** Optional link for the child. */
  url?: string;
};

/**
 * A report entry the user typed by hand. Stored in its OWN persisted cache
 * (never inside a ReportRun) so regenerating the report can't drop it — it's
 * re-merged into the day cards at render/export time via `mergeCustomItems`.
 * Minimal by design: a dated title + category.
 */
export type ReportCustomItem = {
  /** Stable id for keying + delete. */
  id: string;
  /** ISO `yyyy-mm-dd` the entry belongs to. */
  date: string;
  title: string;
  category: ReportCategory;
};

/**
 * A captured "proof" screenshot for one report entry (Phase 16f). The
 * /pinta agent opens the entry's page, frames the specific element the
 * change touched (e.g. the now-red button), and writes a PNG to
 * `.pinta/report-shots/<shotKey>.png` on disk. The extension can't read
 * disk, so the companion serves that file over HTTP and the side panel
 * points an <img> at it — this record is just the metadata, kept in its
 * OWN persisted cache keyed by item id (like ReportCustomItem) so a
 * Refresh never drops it.
 */
export type ReportShot = {
  /** The ReportItem.id this shot belongs to. */
  itemId: string;
  /** Filesystem-safe stem for the on-disk PNG + the companion lookup key.
   *  Derived deterministically from itemId via `shotKeyForItem`, so a
   *  re-capture overwrites the same file. */
  shotKey: string;
  /** When the agent captured it (ms epoch) — drives cache-busting the
   *  <img> URL and a "captured X ago" hint. */
  capturedAt: number;
  /** The agent's one-line description of what it framed (e.g. "the
   *  primary submit button, now red"). Optional. */
  note?: string;
};

/**
 * A generated "How to test" guide for one report entry (Phase 16g). The
 * /pinta agent turns the shipped item into manual QA verification steps
 * (same step-markdown the Test Pilot detail view renders). Cached in its
 * OWN persisted store keyed by item id (like ReportShot / ReportCustomItem)
 * so a Refresh never drops it.
 */
export type ReportHowToTest = {
  /** The ReportItem.id this guide belongs to. */
  itemId: string;
  /** Ordered steps; each is step-markdown (parsed via `parseStep`). */
  steps: string[];
  /** When the agent generated it (ms epoch). */
  askedAt: number;
};

export type ReportDay = {
  /** ISO `yyyy-mm-dd`. */
  date: string;
  items: ReportItem[];
  /** Weekend dates whose items were folded into this weekday (display
   *  transparency). Only set after `foldWeekends`. */
  foldedFrom?: string[];
};

export type ReportRun = {
  runId: string;
  range: ReportRange;
  /** ISO `yyyy-mm-dd` the range is anchored on (usually "today"). */
  anchorDate: string;
  /** Inclusive calendar window the report actually covers. Always set at
   *  generate time (computed from the range, or the picker for "custom"),
   *  so the title label is correct without recomputing — required for the
   *  "custom" range where there's no rangeWindow formula. Optional only
   *  for back-compat with runs stored before this field existed. */
  since?: string;
  until?: string;
  generatedAt: number;
  /** git user / Pinta author the report was scoped to, if any. */
  author?: string;
  /** TRUE-dated buckets as returned by the agent (weekend days NOT yet
   *  folded). Render through `foldWeekends` for display. */
  days: ReportDay[];
};

const REPORT_CATEGORIES = new Set<ReportCategory>([
  "bug-fix",
  "feature",
  "polish",
  "test",
  "annotate",
  "merge",
  "deps",
  "docs",
  "chore",
]);

const REPORT_SOURCES = new Set<ReportSource>([
  "git",
  "pr",
  "issue",
  "pinta-annotate",
  "pinta-audit",
  "pinta-test",
  "manual",
]);

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// ─── Date helpers (UTC-based to avoid timezone off-by-one) ──────────
// All dates are ISO `yyyy-mm-dd` strings; parsing pins them to UTC
// midnight so day arithmetic never drifts across a DST boundary or a
// negative-offset locale.

function parseISO(d: string): Date {
  return new Date(`${d}T00:00:00Z`);
}

function toISO(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

/** Add `n` days (may be negative) to an ISO date, returning ISO. */
export function addDays(d: string, n: number): string {
  const dt = parseISO(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return toISO(dt);
}

/** 0 = Sunday … 6 = Saturday. */
function dayOfWeek(d: string): number {
  return parseISO(d).getUTCDay();
}

export function isWeekend(d: string): boolean {
  const w = dayOfWeek(d);
  return w === 0 || w === 6;
}

/** "2026-06-05" → "June 05 2026" (zero-padded day, matches the export
 *  format the user asked for). */
export function formatDayHeading(d: string): string {
  const dt = parseISO(d);
  return `${MONTHS[dt.getUTCMonth()]} ${String(dt.getUTCDate()).padStart(2, "0")} ${dt.getUTCFullYear()}`;
}

/** Short stamp for the fold badge — "Sat Jun 06". */
export function formatShortDay(d: string): string {
  const dt = parseISO(d);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()];
  return `${wd} ${MONTHS_SHORT[dt.getUTCMonth()]} ${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Compact range label for the report title — "June 01–05 2026" within
 *  one month, "June 28 – July 02 2026" across months. */
export function formatRangeLabel(since: string, until: string): string {
  if (since === until) return formatDayHeading(since);
  const a = parseISO(since);
  const b = parseISO(until);
  const aDay = String(a.getUTCDate()).padStart(2, "0");
  const bDay = String(b.getUTCDate()).padStart(2, "0");
  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) {
    return `${MONTHS[a.getUTCMonth()]} ${aDay}–${bDay} ${a.getUTCFullYear()}`;
  }
  if (a.getUTCFullYear() === b.getUTCFullYear()) {
    return `${MONTHS[a.getUTCMonth()]} ${aDay} – ${MONTHS[b.getUTCMonth()]} ${bDay} ${a.getUTCFullYear()}`;
  }
  return `${formatDayHeading(since)} – ${formatDayHeading(until)}`;
}

/** Human label for a category chip. */
export function categoryLabel(c: ReportCategory): string {
  switch (c) {
    case "bug-fix":
      return "Bug fix";
    case "feature":
      return "Feature";
    case "polish":
      return "Polish";
    case "test":
      return "Test";
    case "annotate":
      return "Annotate";
    case "merge":
      return "Merge";
    case "deps":
      return "Deps";
    case "docs":
      return "Docs";
    case "chore":
      return "Chore";
  }
}

/** Inclusive calendar window for an agent gather, plus a title label.
 *
 * - daily  — just the anchor day.
 * - weekly — Monday of the anchor's week through the anchor (so a
 *   mid-week report doesn't list future empty days).
 * - sprint — the 10 most recent WORKING days ending at the anchor
 *   (weekends excluded from the count); `since` is the earliest of
 *   those, `until` is the anchor. Weekend days inside the window still
 *   belong to it — their items fold into adjacent weekdays at render.
 */
export function rangeWindow(
  range: ReportRange,
  anchorDate: string,
): { since: string; until: string; label: string; workingDays: number } {
  if (range === "daily") {
    return {
      since: anchorDate,
      until: anchorDate,
      label: formatDayHeading(anchorDate),
      workingDays: isWeekend(anchorDate) ? 0 : 1,
    };
  }
  if (range === "weekly") {
    // Monday of the anchor's week. dayOfWeek: 0=Sun..6=Sat → days back
    // to Monday = (dow + 6) % 7.
    const dow = dayOfWeek(anchorDate);
    const back = (dow + 6) % 7;
    const monday = addDays(anchorDate, -back);
    return {
      since: monday,
      until: anchorDate,
      label: formatRangeLabel(monday, anchorDate),
      workingDays: 5,
    };
  }
  // sprint — walk back from the anchor collecting 10 working days.
  let cursor = anchorDate;
  let collected = 0;
  let earliest = anchorDate;
  // Guard the loop at 30 calendar days (2 weeks of weekdays + weekends).
  for (let i = 0; i < 30 && collected < 10; i++) {
    if (!isWeekend(cursor)) {
      collected++;
      earliest = cursor;
    }
    if (collected >= 10) break;
    cursor = addDays(cursor, -1);
  }
  return {
    since: earliest,
    until: anchorDate,
    label: formatRangeLabel(earliest, anchorDate),
    workingDays: 10,
  };
}

/**
 * Merge the user's hand-entered custom items into a run's TRUE-dated day
 * buckets. Manual items live in their own persisted cache (never inside a
 * ReportRun), so a refresh that replaces the run can't drop them — they're
 * re-merged here at render/export time. Items whose date falls OUTSIDE the
 * supplied inclusive `window` are skipped (hidden, not lost): they reappear
 * the moment a range covering their date is selected. Omit `window` to
 * include every custom item (used for the no-run fallback view).
 *
 * Returns a fresh array (inputs untouched), still true-dated and unsorted —
 * run the result through `foldWeekends` for display.
 */
export function mergeCustomItems(
  days: ReportDay[],
  custom: ReportCustomItem[],
  window?: { since: string; until: string },
): ReportDay[] {
  const byDate = new Map<string, ReportDay>();
  for (const d of days) {
    byDate.set(d.date, {
      date: d.date,
      items: [...d.items],
      ...(d.foldedFrom ? { foldedFrom: [...d.foldedFrom] } : {}),
    });
  }
  for (const c of custom) {
    // ISO yyyy-mm-dd compares lexicographically, so plain string bounds work.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date)) continue;
    if (window && (c.date < window.since || c.date > window.until)) continue;
    const item: ReportItem = {
      id: c.id,
      title: c.title,
      category: c.category,
      source: "manual",
      userAdded: true,
    };
    const bucket = byDate.get(c.date);
    if (bucket) bucket.items.push(item);
    else byDate.set(c.date, { date: c.date, items: [item] });
  }
  return [...byDate.values()];
}

/**
 * Fold weekend (Sat/Sun) work into the lighter adjacent weekday.
 *
 * The locked rule: weekends aren't their own sections in weekly/sprint
 * views; a weekend day's items append to whichever adjacent weekday
 * (preceding Friday or following Monday) currently has FEWER items, tie
 * → preceding Friday. If the chosen neighbour weekday isn't present in
 * the returned set, it's created so nothing is dropped. Daily range is
 * a passthrough (a single day shows as-is, weekend or not).
 *
 * Returns a fresh, newest-first array; inputs are not mutated.
 */
export function foldWeekends(
  days: ReportDay[],
  range: ReportRange,
): ReportDay[] {
  // Clone so callers' stored (true-dated) data stays untouched.
  const byDate = new Map<string, ReportDay>();
  for (const d of days) {
    byDate.set(d.date, {
      date: d.date,
      items: [...d.items],
      ...(d.foldedFrom ? { foldedFrom: [...d.foldedFrom] } : {}),
    });
  }

  // Daily + custom show their exact days (no fold) — a single day, or a
  // window the user picked explicitly. Weekly/sprint fold weekends.
  if (range !== "daily" && range !== "custom") {
    const weekendDates = [...byDate.keys()].filter(isWeekend).sort();
    for (const wDate of weekendDates) {
      const weekend = byDate.get(wDate)!;
      if (weekend.items.length === 0) {
        byDate.delete(wDate);
        continue;
      }
      const dow = dayOfWeek(wDate); // 6=Sat, 0=Sun
      const friday = addDays(wDate, dow === 6 ? -1 : -2);
      const monday = addDays(wDate, dow === 6 ? 2 : 1);
      const friDay = byDate.get(friday);
      const monDay = byDate.get(monday);

      let target: ReportDay;
      if (friDay && monDay) {
        // Fewer items wins; tie → Friday.
        target = monDay.items.length < friDay.items.length ? monDay : friDay;
      } else if (friDay) {
        target = friDay;
      } else if (monDay) {
        target = monDay;
      } else {
        // Neither neighbour present — create the preceding Friday so the
        // weekend work still has a home.
        target = { date: friday, items: [] };
        byDate.set(friday, target);
      }
      target.items.push(...weekend.items);
      target.foldedFrom = [...(target.foldedFrom ?? []), wDate];
      byDate.delete(wDate);
    }
  }

  return [...byDate.values()]
    .filter((d) => d.items.length > 0)
    .map(coalesceAnnotateRollups)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** After a weekend fold, a weekday can end up with more than one annotation
 *  roll-up (its own + the folded weekend's). Collapse them into a single
 *  "Fixes and Additional Features" row, concatenating any children, so the
 *  day shows one roll-up rather than duplicates. Non-annotate items and days
 *  with ≤1 roll-up are returned unchanged (same identity). */
function coalesceAnnotateRollups(day: ReportDay): ReportDay {
  const rollups = day.items.filter(isAnnotateRollup);
  if (rollups.length <= 1) return day;
  const first = rollups[0]!;
  const mergedChildren = rollups.flatMap((r) => r.children ?? []);
  const mergedFirst: ReportItem = {
    ...first,
    ...(mergedChildren.length ? { children: mergedChildren } : {}),
  };
  const extras = new Set(rollups.slice(1));
  const items = day.items
    .filter((it) => !extras.has(it))
    .map((it) => (it === first ? mergedFirst : it));
  return { ...day, items };
}

/**
 * Merge freshly-fetched `incoming` day buckets into the run's existing
 * (true-dated) `days`, deduping items by `id` so re-fetching a day only
 * ADDS commits that weren't already listed — never drops or reorders what
 * was there. New dates create their own bucket. Returns a fresh array plus
 * the count of genuinely-new items (drives the "no new commits" note).
 *
 * Inputs are not mutated. Used by the per-day "fetch more" action; manual
 * cache items live in a separate store and are untouched here.
 */
export function mergeReportDays(
  existing: ReportDay[],
  incoming: ReportDay[],
): { days: ReportDay[]; added: number } {
  const byDate = new Map<string, ReportDay>();
  for (const d of existing) {
    byDate.set(d.date, {
      date: d.date,
      items: [...d.items],
      ...(d.foldedFrom ? { foldedFrom: [...d.foldedFrom] } : {}),
    });
  }
  let added = 0;
  for (const d of incoming) {
    let bucket = byDate.get(d.date);
    if (!bucket) {
      bucket = { date: d.date, items: [] };
      byDate.set(d.date, bucket);
    }
    const seen = new Set(bucket.items.map((it) => it.id));
    for (const it of d.items) {
      if (seen.has(it.id)) continue;
      bucket.items.push(it);
      seen.add(it.id);
      added++;
    }
  }
  return { days: [...byDate.values()], added };
}

/** Distinct non-empty project labels across a run. >1 means the report
 *  spans multiple repos → cards + export tag each item with its project. */
export function reportProjects(run: ReportRun): string[] {
  const set = new Set<string>();
  for (const d of run.days) {
    for (const it of d.items) if (it.project) set.add(it.project);
  }
  return [...set];
}

/** Conventional-commit types we strip from the front of a subject. Limited to
 *  this set so a hand-typed manual entry like `Met John: notes` keeps its colon
 *  prefix — only real commit noise is removed. */
const CC_TYPE =
  /^(?:feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert|merge|wip)(?:\([^)]*\))?!?:\s*/i;

/** The daily-merge gitlink bump, e.g. `bump svelte gitlink` or, with an issue
 *  ref in front, `#368 bump svelte gitlink`. The captured `#ref` is preserved
 *  (traceability), the bump token itself is dropped, and a trailing ` -- ` is
 *  consumed so the real subject after it becomes the title. */
const GITLINK_BUMP = /(#\S+\s+)?\bbump\s+(?:\S+\s+)*?gitlink\b[ \t]*(?:--+[ \t]*)?/i;

/** Words kept lowercase in Title Case unless first/last. */
const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into",
  "nor", "of", "on", "onto", "or", "over", "per", "the", "to", "via", "vs",
  "with",
]);

/** Title-case a single token, but PRESERVE anything that looks technical so a
 *  company-facing report never mangles it: tokens with internal capitals
 *  (`PDF`, `DTO`, `CTA`, `McKay`), anything containing a digit (`#00447c`,
 *  `i18n`, `1.7.2`, `#369`), and pure symbols (`+`, `→`). Plain words get
 *  their first letter capitalised; small words stay lowercase mid-sentence. */
function titleCaseToken(word: string, isEdge: boolean): string {
  if (!word) return word;
  if (/[A-Z]/.test(word.slice(1))) return word; // internal capital → acronym/camel
  if (/\d/.test(word)) return word; // has a digit → ref/hex/version/i18n
  if (!/[a-z]/i.test(word)) return word; // no letters → symbol/punctuation
  const lower = word.toLowerCase();
  if (!isEdge && SMALL_WORDS.has(lower.replace(/[^a-z]/g, ""))) return lower;
  return lower.replace(/[a-z]/i, (c) => c.toUpperCase()); // cap first letter
}

/** Apply Title Case across a cleaned subject. First and last words are always
 *  capitalised; everything else honours the small-word list. */
function toTitleCase(s: string): string {
  const words = s.split(/\s+/);
  return words
    .map((w, i) => titleCaseToken(w, i === 0 || i === words.length - 1))
    .join(" ");
}

/** Strip conventional-commit + gitlink-bump noise from a commit subject and
 *  tidy separators, leaving just the human-meaningful message. Returns null
 *  when nothing meaningful survives (so callers keep the original). */
function cleanCommitSubject(raw: string): string | null {
  let s = raw.replace(CC_TYPE, "").trim();
  const m = GITLINK_BUMP.exec(s);
  if (m) {
    const ref = m[1] ? m[1].trim() + " " : "";
    let rest = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();
    // When the real message was wrapped wholly in parens (no ` -- ` form),
    // unwrap the single outer pair so it reads as a sentence.
    const wrapped = /^\(([^()]*)\)$/.exec(rest);
    if (wrapped) rest = (wrapped[1] ?? "").trim();
    s = (ref + rest).trim();
  }
  // Prettify separators/arrows for a report audience.
  s = s.replace(/\s+--+\s+/g, " — ").replace(/->/g, "→").replace(/<-/g, "←");
  return s.length > 0 ? s : null;
}

/**
 * Make an item title human-friendly for a company-facing report. Idempotent,
 * so it's safe at render AND export time:
 *  1. Pinta module sessions (AuditFlow, Test Pilot, …) record their result as a
 *     JSON `appliedSummary`; render a plain one-line summary instead of braces.
 *  2. Everything else is treated as a commit subject: strip the conventional
 *     `type(scope):` prefix and the `bump … gitlink --` daily-merge boilerplate,
 *     then Title Case the remainder while preserving refs/acronyms/hex/versions.
 */
export function humanizeReportTitle(title: string): string {
  const t = (title ?? "").trim();
  if (!t.startsWith("{")) {
    const cleaned = cleanCommitSubject(t);
    return cleaned ? toTitleCase(cleaned) : title;
  }
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  } catch {
    obj = null;
  }
  if (obj && typeof obj.type === "string") return friendlyModuleLine(obj.type, obj);
  // Looks like JSON but unparseable (truncated) or has no `type` — pull a
  // `type` marker if one's there, else a generic line. Never show raw braces.
  const m = /"type"\s*:\s*"([^"]+)"/.exec(t);
  if (m && m[1]) return friendlyModuleLine(m[1], {});
  return obj ? title : "Pinta activity";
}

/** Fixed, human-friendly label shown for a Pinta annotation roll-up in a
 *  company-facing report — the raw "N Pinta annotations" count reads as
 *  internal jargon, so the parent row is titled by what the work actually is. */
export const ANNOTATION_ROLLUP_LABEL = "Fixes and Additional Features";

/** True when an item is the per-day Pinta annotation roll-up (the collapsible
 *  parent whose children are individual annotations). */
export function isAnnotateRollup(item: ReportItem): boolean {
  return item.source === "pinta-annotate" || item.category === "annotate";
}

/** Display title for a report item's parent row — the fixed annotation
 *  roll-up label for annotate items, otherwise the humanized commit subject.
 *  Shared by the cards and the markdown export so both read the same. */
export function reportItemDisplayTitle(item: ReportItem): string {
  return isAnnotateRollup(item)
    ? ANNOTATION_ROLLUP_LABEL
    : humanizeReportTitle(item.title);
}

/** Plain-English one-liner for a Pinta module session result, keyed by its
 *  `type` marker. Unknown types fall back to a title-cased version of the
 *  marker so we never leak JSON. */
function friendlyModuleLine(type: string, o: Record<string, unknown>): string {
  const num = (k: string): number | null =>
    typeof o[k] === "number" ? (o[k] as number) : null;
  const str = (k: string): string | null =>
    typeof o[k] === "string" && (o[k] as string).trim()
      ? (o[k] as string).trim()
      : null;
  switch (type) {
    case "audit-flow-run": {
      const overall = num("overall");
      const rating = str("rating");
      const bits = [overall != null ? `scored ${overall}/100` : null, rating]
        .filter(Boolean)
        .join(" · ");
      return bits ? `Ran an AuditFlow audit — ${bits}` : "Ran an AuditFlow audit";
    }
    case "test-pilot-catalog": {
      const file = str("filename");
      const sections = Array.isArray(o.sections) ? (o.sections as unknown[]) : [];
      const tests = sections.reduce<number>((n, s) => {
        const ts = (s as { tests?: unknown })?.tests;
        return n + (Array.isArray(ts) ? ts.length : 0);
      }, 0);
      let line = "Generated a Test Pilot catalog";
      if (file) line += ` from ${file}`;
      if (tests) line += ` — ${tests} test${tests === 1 ? "" : "s"}`;
      else if (sections.length)
        line += ` — ${sections.length} section${sections.length === 1 ? "" : "s"}`;
      return line;
    }
    case "audit-issue-filed":
      return str("target") === "gitlab"
        ? "Filed an AuditFlow finding as a GitLab issue"
        : "Logged an AuditFlow finding to tasks";
    case "audit-fix-applied": {
      const s = str("summary");
      return s ? `Fixed an AuditFlow finding — ${s}` : "Fixed an AuditFlow finding";
    }
    case "audit-discussion":
      return "Discussed an AuditFlow finding";
    default: {
      const words = type.replace(/[-_]+/g, " ").trim();
      return words
        ? words.charAt(0).toUpperCase() + words.slice(1)
        : "Pinta activity";
    }
  }
}

/** How many changed-file paths the compact view lists before "+N more". */
const FILE_PREVIEW_MAX = 3;

/** Compact one-line summary of an item's changed files, or null when it
 *  has none. e.g. "3 files · a.ts, b.ts, c.ts" or, when more changed than
 *  are listed, "8 files · a.ts, b.ts, c.ts (+5 more)". Shared by the card
 *  render and the markdown export so they always agree. */
export function formatFileSummary(item: ReportItem): string | null {
  const files = item.files;
  if (!files || files.length === 0) return null;
  const total = Math.max(item.fileCount ?? 0, files.length);
  const shown = files.slice(0, FILE_PREVIEW_MAX);
  const extra = total - shown.length;
  const noun = total === 1 ? "file" : "files";
  const list = shown.join(", ");
  return extra > 0
    ? `${total} ${noun} · ${list} (+${extra} more)`
    : `${total} ${noun} · ${list}`;
}

/** True when a ref is a human-meaningful tracker id worth showing inline (a
 *  PR/issue number like `#290` or `!57`) rather than a raw commit short-sha,
 *  which reads as a code — dropped from the plain export and tucked behind the
 *  card's info disclosure. */
export function isTrackerRef(it: ReportItem): boolean {
  if (!it.ref) return false;
  if (it.source === "pr" || it.source === "issue") return true;
  return /^[#!]/.test(it.ref);
}

/** One markdown line for an item — deliberately PLAIN PROSE for a
 *  company-facing report: no commit short-shas, no changed-file paths, no
 *  DOM/route codes. Keeps only a `#PR`/`!issue` tracker ref (dropped for
 *  bare commits) and, for multi-project runs, the `[project]` tag so you can
 *  tell repos apart. The on-screen cards still show the full detail; this is
 *  the export view only. */
function reportItemLine(it: ReportItem, multiProject: boolean): string {
  const tag = multiProject && it.project ? `[${it.project}] ` : "";
  const title = reportItemDisplayTitle(it);
  const ref = isTrackerRef(it) ? `${it.ref} — ` : "";
  return `- ${tag}${ref}${title}`;
}

/** Markdown for a single day — flat, plain-prose `- title` lines (a `#ref`
 *  kept only for PRs/issues), each prefixed with `[project]` when the report
 *  spans multiple projects. A roll-up item's `children` (e.g. each Pinta
 *  annotation) are indented as nested bullets — plain descriptions, no page
 *  routes. Shared by the whole-report export and the per-day export button. */
export function renderDayMarkdown(day: ReportDay, multiProject: boolean): string {
  const lines = [`## ${formatDayHeading(day.date)}`];
  for (const it of day.items) {
    lines.push(reportItemLine(it, multiProject));
    if (it.children?.length) {
      for (const c of it.children) {
        lines.push(`  - ${humanizeReportTitle(c.title)}`);
      }
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Render a ReportRun as clean markdown. Single-project reports are flat
 * `- #ref — title` lines (matches the requested export format exactly);
 * multi-project reports prefix each line with its `[project]` tag.
 * Weekend folds are applied here so the export reflects what the cards
 * show; the fold badge is deliberately omitted from markdown to keep the
 * export clean (it lives in the card UI only).
 */
export function renderReportMarkdown(run: ReportRun): string {
  const label =
    run.since && run.until
      ? formatRangeLabel(run.since, run.until)
      : rangeWindow(run.range, run.anchorDate).label;
  const multiProject = reportProjects(run).length > 1;
  const days = foldWeekends(run.days, run.range);
  const blocks = days.map((day) => renderDayMarkdown(day, multiProject));
  return [`# Report — ${label}`, "", ...blocks].join("\n").trimEnd() + "\n";
}

/**
 * Validate + coerce a raw agent payload into a ReportRun. Accepts a
 * `type` of "report" / "report-run" / "task-report", or any object with
 * a `days` array (the load-bearing field). `ctx` supplies the values the
 * extension already knows from the pending request so a degraded payload
 * still slots into the right run. Returns null when there's no usable
 * `days` array at all.
 */
export function parseReportPayload(
  raw: unknown,
  ctx: {
    runId: string;
    range: ReportRange;
    anchorDate: string;
    generatedAt: number;
    since?: string;
    until?: string;
  },
): ReportRun | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const rawDays = obj.days;
  if (!Array.isArray(rawDays)) return null;

  const days: ReportDay[] = [];
  for (const d of rawDays) {
    if (!d || typeof d !== "object") continue;
    const dd = d as Record<string, unknown>;
    const date = typeof dd.date === "string" ? dd.date.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const rawItems = Array.isArray(dd.items) ? dd.items : [];
    const items: ReportItem[] = [];
    for (let i = 0; i < rawItems.length; i++) {
      const it = coerceItem(rawItems[i], `${date}:${i}`);
      if (it) items.push(it);
    }
    days.push({ date, items });
  }
  if (days.length === 0) return null;

  return {
    runId:
      typeof obj.runId === "string" && obj.runId ? obj.runId : ctx.runId,
    range: ctx.range,
    anchorDate:
      typeof obj.anchorDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.anchorDate)
        ? obj.anchorDate
        : ctx.anchorDate,
    generatedAt: ctx.generatedAt,
    ...(ctx.since ? { since: ctx.since } : {}),
    ...(ctx.until ? { until: ctx.until } : {}),
    ...(typeof obj.author === "string" && obj.author ? { author: obj.author } : {}),
    days,
  };
}

function coerceItem(raw: unknown, fallbackId: string): ReportItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const ref = typeof o.ref === "string" && o.ref.trim() ? o.ref.trim() : undefined;
  // An item needs at least a title or a ref to be worth listing.
  if (!title && !ref) return null;
  const category =
    typeof o.category === "string" && REPORT_CATEGORIES.has(o.category as ReportCategory)
      ? (o.category as ReportCategory)
      : "chore";
  const source =
    typeof o.source === "string" && REPORT_SOURCES.has(o.source as ReportSource)
      ? (o.source as ReportSource)
      : "git";
  return {
    id: typeof o.id === "string" && o.id ? o.id : ref ?? fallbackId,
    ...(ref ? { ref } : {}),
    ...(typeof o.url === "string" && o.url ? { url: o.url } : {}),
    title: title || ref || "(untitled)",
    ...(typeof o.detail === "string" && o.detail ? { detail: o.detail } : {}),
    category,
    source,
    ...(typeof o.project === "string" && o.project.trim()
      ? { project: o.project.trim() }
      : {}),
    ...coerceFiles(o),
    ...coerceChildren(o),
  };
}

/** Pull a capped list of nested sub-entries from a raw item. Accepts either
 *  bare strings (`["a", "b"]`) or objects (`[{title, ref?, url?}]`) so the
 *  agent can emit whichever is convenient; both normalize to ReportItemChild.
 *  Capped so a runaway annotation batch can't bloat the cached run. */
function coerceChildren(o: Record<string, unknown>): {
  children?: ReportItemChild[];
} {
  const CHILD_STORE_MAX = 100;
  const raw = Array.isArray(o.children) ? o.children : null;
  if (!raw) return {};
  const children: ReportItemChild[] = [];
  for (const c of raw) {
    if (typeof c === "string") {
      const title = c.trim();
      if (title) children.push({ title });
    } else if (c && typeof c === "object") {
      const co = c as Record<string, unknown>;
      const title = typeof co.title === "string" ? co.title.trim() : "";
      if (!title) continue;
      children.push({
        title,
        ...(typeof co.ref === "string" && co.ref.trim()
          ? { ref: co.ref.trim() }
          : {}),
        ...(typeof co.url === "string" && co.url.trim()
          ? { url: co.url.trim() }
          : {}),
      });
    }
    if (children.length >= CHILD_STORE_MAX) break;
  }
  return children.length ? { children } : {};
}

// ─── Annotation-children fallback helpers ───────────────────────────
// Pure helpers the client uses to build annotation children directly from
// companion session data when the agent left a roll-up as a bare count.
// Kept here (not in state) so they're unit-testable.

/** Local-timezone ISO `yyyy-mm-dd` for an epoch-ms timestamp, or null. Local
 *  (not UTC) so it lines up with the day a user perceives an annotation was
 *  submitted — matching the agent's git-derived day buckets. */
export function isoDateLocal(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** True when a session's `appliedSummary` is a module result (AuditFlow /
 *  Test Pilot / Chat emit a JSON object with a string `type`) rather than a
 *  plain annotation batch — so the fallback skips those sessions. */
export function looksLikeModuleSummary(s?: string): boolean {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (!t.startsWith("{")) return false;
  try {
    const o = JSON.parse(t) as unknown;
    return !!o && typeof o === "object" && typeof (o as { type?: unknown }).type === "string";
  } catch {
    // Truncated JSON that still declares a `type` — treat as a module result.
    return /"type"\s*:/.test(t);
  }
}

/** Merge the client-side annotation fallback into a run's days for export:
 *  any annotate roll-up item that has no `children` of its own gets the
 *  fetched children for its day (keyed by `day.date`). Returns new arrays
 *  only where something changed, so untouched days/items keep their identity.
 *  Pure → safe to call at export time and unit-test. */
export function mergeAnnotationChildren(
  days: ReportDay[],
  cache: Record<string, ReportItemChild[]>,
): ReportDay[] {
  return days.map((day) => {
    const fallback = cache[day.date];
    if (!fallback || fallback.length === 0) return day;
    let changed = false;
    const items = day.items.map((it) => {
      const isAnnotate =
        it.source === "pinta-annotate" || it.category === "annotate";
      if (isAnnotate && !(it.children && it.children.length)) {
        changed = true;
        return { ...it, children: fallback };
      }
      return it;
    });
    return changed ? { ...day, items } : day;
  });
}

/** Page path (pathname) from a session URL, for the small ref before a child
 *  title. Undefined for the bare root or an unparseable URL. */
export function pagePathFromUrl(url?: string): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    const p = new URL(url).pathname;
    return p && p !== "/" ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Normalize an annotation comment into a single short line for a child
 *  title: first line, trimmed, capped so a long note can't blow out the row. */
export function oneLineComment(c?: string): string {
  if (typeof c !== "string") return "";
  const first = (c.split(/\r?\n/)[0] ?? "").trim();
  return first.length <= 120 ? first : first.slice(0, 117).trimEnd() + "…";
}

/** Pull a capped, cleaned changed-files list (+ optional total count) from
 *  a raw item. Defensive: filters to non-empty strings, caps the stored
 *  list so a runaway payload can't bloat storage, and only keeps
 *  `fileCount` when it exceeds what `files` carries. */
function coerceFiles(o: Record<string, unknown>): {
  files?: string[];
  fileCount?: number;
} {
  const FILE_STORE_MAX = 6;
  const raw = Array.isArray(o.files) ? o.files : null;
  if (!raw) return {};
  const files = raw
    .filter((f): f is string => typeof f === "string" && f.trim() !== "")
    .map((f) => f.trim())
    .slice(0, FILE_STORE_MAX);
  if (files.length === 0) return {};
  const count =
    typeof o.fileCount === "number" && Number.isFinite(o.fileCount)
      ? Math.max(0, Math.floor(o.fileCount))
      : 0;
  return count > files.length ? { files, fileCount: count } : { files };
}

// ─── Per-entry screenshot (Phase 16f) ───────────────────────────────
// Deterministic agent ↔ companion ↔ extension contract for the "proof"
// screenshot: the extension derives a safe `shotKey` from the item id and
// sends it in the op:"report-screenshot" request; the agent writes the PNG
// to `.pinta/report-shots/<shotKey>.png` and echoes the key back; the
// companion serves that file by key. Computing the key here (pure) keeps
// all three layers in lock-step without cross-layer filename sanitization
// drift.

/** Tiny stable string hash (djb2 → base36). Used only to make `shotKey`
 *  collision-free across distinct item ids — NOT for security. */
function shotHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Filesystem-safe, collision-free stem for an entry's screenshot file.
 *  Deterministic: the same item id always maps to the same key, so a
 *  re-capture overwrites the same PNG. Pure → unit-tested. */
export function shotKeyForItem(itemId: string): string {
  const base = itemId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "entry"}-${shotHash(itemId)}`;
}

/** What the agent returns in `mark_session_done` for op:"report-screenshot". */
export type ShotResult = {
  itemId: string;
  shotKey: string;
  ok: boolean;
  /** One-line description of what was framed (success). */
  note?: string;
  /** Why the capture failed (ok:false) — surfaced as a dismissible error. */
  reason?: string;
};

/** Validate + normalize the agent's screenshot result envelope. Returns
 *  null when it's unrecognizable (missing itemId/shotKey). Pure →
 *  unit-tested. */
export function parseShotResult(raw: unknown): ShotResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const itemId = typeof o.itemId === "string" ? o.itemId.trim() : "";
  const shotKey = typeof o.shotKey === "string" ? o.shotKey.trim() : "";
  if (!itemId || !shotKey) return null;
  return {
    itemId,
    shotKey,
    ok: o.ok === true,
    ...(typeof o.note === "string" && o.note.trim()
      ? { note: o.note.trim() }
      : {}),
    ...(typeof o.reason === "string" && o.reason.trim()
      ? { reason: o.reason.trim() }
      : {}),
  };
}

// ─── Per-entry "How to test" (Phase 16g) ────────────────────────────

/** What the agent returns in `mark_session_done` for op:"report-how-to-test"
 *  — the item id (so the extension routes it) plus ordered step-markdown. */
export type HowToTestResult = {
  itemId: string;
  steps: string[];
};

/** Validate + normalize the agent's how-to-test result. Filters steps to
 *  non-empty strings; caps the count so a runaway payload can't bloat
 *  storage. Returns null when unusable (no itemId or no steps). Pure →
 *  unit-tested. */
export function parseHowToTestResult(raw: unknown): HowToTestResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const itemId = typeof o.itemId === "string" ? o.itemId.trim() : "";
  if (!itemId) return null;
  const rawSteps = Array.isArray(o.steps) ? o.steps : null;
  if (!rawSteps) return null;
  const steps = rawSteps
    .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    .map((s) => s.trim())
    .slice(0, 20);
  if (steps.length === 0) return null;
  return { itemId, steps };
}
