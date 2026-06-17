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

export type ReportRange = "daily" | "weekly" | "sprint";

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

/** Where an item came from — drives the small source glyph. */
export type ReportSource =
  | "git"
  | "pr"
  | "issue"
  | "pinta-annotate"
  | "pinta-audit"
  | "pinta-test";

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

  if (range !== "daily") {
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
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
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

/** One markdown line for an item. When the report spans multiple
 *  projects, prefix the line with its `[project]` tag so you can see
 *  which repo each task came from (e.g. `- [insclix-awp-2.0] #319 —
 *  …`); single-project reports stay clean (`- #ref — title`). */
function reportItemLine(it: ReportItem, multiProject: boolean): string {
  const tag = multiProject && it.project ? `[${it.project}] ` : "";
  return it.ref ? `- ${tag}${it.ref} — ${it.title}` : `- ${tag}${it.title}`;
}

/** Markdown for a single day — flat `- #ref — title` lines, each
 *  prefixed with `[project]` when the report spans multiple projects.
 *  Shared by the whole-report export and the per-day export button. */
export function renderDayMarkdown(day: ReportDay, multiProject: boolean): string {
  const lines = [`## ${formatDayHeading(day.date)}`];
  for (const it of day.items) lines.push(reportItemLine(it, multiProject));
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
  const { label } = rangeWindow(run.range, run.anchorDate);
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
  ctx: { runId: string; range: ReportRange; anchorDate: string; generatedAt: number },
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
  };
}
