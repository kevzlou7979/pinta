// Phase 25 — Motion module. Pure helpers only: the built-in catalog, the
// element-first ranking, timing resolution against a motion system, the
// stagger clamp, the count-up number parser/formatter, and the plan
// builder that both the side panel and the in-page runner share.
//
// Pattern: audit-flow.ts / design-variants.ts — no chrome.*, no Svelte
// runtime, so every rule here unit-tests on its own.
//
// The plan is the contract between the panel and the content script: it
// must stay plain JSON (no functions, no Element refs) because it rides
// chrome.tabs.sendMessage.

import type { AnnotationTarget } from "@pinta/shared";

// ---------------------------------------------------------------------------
// Types

export type MotionGroup = "transition" | "effect";

/** When an effect runs. Transitions fire on navigation and use "nav". */
export type MotionTrigger = "mount" | "view" | "change" | "hover" | "nav";

/** How the runner drives it: WAAPI keyframes, or text interpolation. */
export type MotionKind = "waapi" | "countup";

export type MotionSystem = {
  name: string;
  /** Token name → milliseconds. */
  durations: Record<string, number>;
  /** Token name → CSS timing function. */
  easings: Record<string, string>;
  stagger: { tight: number; base: number; loose: number; maxTotal: number };
  source: { kind: "builtin" | "file" | "url"; path?: string };
  /** How applied code must gate itself. Carried into the apply payload. */
  reducedMotion?: { guard?: string; import?: string };
};

export type MotionPattern = {
  id: string;
  group: MotionGroup;
  name: string;
  blurb: string;
  kind: MotionKind;
  /** Page elements the pattern binds. 2 = needs a destination pick. */
  targets: 1 | 2;
  /** True when the pattern animates the target's CHILDREN, not the target. */
  children?: boolean;
  triggers: MotionTrigger[];
  defaultTrigger: MotionTrigger;
  /** Token names into MotionSystem.durations / .easings. */
  duration: string;
  easing: string;
  /** False while the in-page rehearsal for this pattern isn't built yet
   *  (the two-target transitions — they need the destination overlay). */
  rehearsable: boolean;
  /** Shown instead of the control strip when rehearsable is false. */
  rehearseNote?: string;
};

/** One animation inside a plan. `node` says what it binds to. */
export type MotionStep = {
  node: "target" | "child";
  /** WAAPI object-form keyframes — arrays per property, plus `offset`. */
  keyframes: Record<string, Array<string | number>>;
  delay: number;
  duration: number;
  easing: string;
};

export type MotionPlan = {
  patternId: string;
  kind: MotionKind;
  /** Timeline length the scrub bar maps onto. */
  total: number;
  steps: MotionStep[];
  /** countup only — the runner interpolates text instead of style. */
  count?: { duration: number; easing: string };
  /** Present when the pattern staggers children. */
  stagger?: { step: number; requested: number; clamped: boolean };
  /** True when the plan was built for reduced motion (fade substitute). */
  reduced: boolean;
};

/** Everything the ranker can learn from a picked element. */
export type TargetFacts = {
  tag: string;
  classes: string[];
  role: string | null;
  text: string;
  /** Opening tags under the root — coarse, used only as a "has children" hint. */
  descendants: number;
  display: string;
};

// ---------------------------------------------------------------------------
// Default motion system
//
// Mirrors insclix-design-system/app/src/lib/motion.ts, plus the two
// additions effects need: a long `count` duration (digits are read, not
// tracked, so 500ms feels snatched) and a STAGGER block, whose `step` is
// not a duration at all.

export const DEFAULT_MOTION_SYSTEM: MotionSystem = {
  name: "Material 3 (built-in)",
  durations: {
    fast: 120,
    base: 150,
    slow: 250,
    enter: 300,
    shift: 400,
    morph: 500,
    count: 1100,
  },
  easings: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    decelerate: "cubic-bezier(0.05, 0.7, 0.1, 1)",
    accelerate: "cubic-bezier(0.3, 0, 0.8, 0.15)",
    linear: "linear",
  },
  stagger: { tight: 40, base: 60, loose: 90, maxTotal: 900 },
  source: { kind: "builtin" },
};

/** Fallback when a token name isn't in the active system. */
export const FALLBACK_DURATION = 300;
export const FALLBACK_EASING = "cubic-bezier(0.2, 0, 0, 1)";

// ---------------------------------------------------------------------------
// Catalog

export const MOTION_PATTERNS: MotionPattern[] = [
  // --- transitions -------------------------------------------------------
  {
    id: "container-transform",
    group: "transition",
    name: "Container transform",
    blurb: "An element grows into the view it opens. The strongest relationship of the six.",
    kind: "waapi",
    targets: 2,
    triggers: ["nav"],
    defaultTrigger: "nav",
    duration: "morph",
    easing: "standard",
    rehearsable: false,
    rehearseNote:
      "Preview for this pattern is coming soon — you can still pick the destination and add a note.",
  },
  {
    id: "forward-backward",
    group: "transition",
    name: "Forward and backward",
    blurb: "Consecutive levels of hierarchy — list to detail. Slides horizontally with a fade.",
    kind: "waapi",
    targets: 2,
    triggers: ["nav"],
    defaultTrigger: "nav",
    duration: "shift",
    easing: "standard",
    rehearsable: false,
    rehearseNote:
      "Preview for this pattern is coming soon — you can still pick the destination and add a note.",
  },
  {
    id: "lateral",
    group: "transition",
    name: "Lateral",
    blurb: "Peers at the same level — tabs, carousels, galleries. Slides in unison, no fade.",
    kind: "waapi",
    targets: 1,
    triggers: ["nav", "mount"],
    defaultTrigger: "nav",
    duration: "shift",
    easing: "standard",
    rehearsable: true,
  },
  {
    id: "top-level",
    group: "transition",
    name: "Top level",
    blurb: "Unrelated destinations from a nav bar. Out fades, then in fades, with no shared element.",
    kind: "waapi",
    targets: 1,
    triggers: ["nav"],
    defaultTrigger: "nav",
    duration: "slow",
    easing: "standard",
    rehearsable: true,
  },
  {
    id: "enter-exit",
    group: "transition",
    name: "Enter and exit",
    blurb: "A component arriving or leaving — dialog, menu, snackbar, sheet, drawer.",
    kind: "waapi",
    targets: 1,
    triggers: ["mount", "hover", "nav"],
    defaultTrigger: "mount",
    duration: "enter",
    easing: "decelerate",
    rehearsable: true,
  },
  {
    id: "skeleton",
    group: "transition",
    name: "Skeleton loaders",
    blurb: "Loading state to loaded UI. Pulses while indeterminate, content fades in over the top.",
    kind: "waapi",
    targets: 1,
    children: true,
    triggers: ["mount"],
    defaultTrigger: "mount",
    duration: "shift",
    easing: "standard",
    rehearsable: true,
  },

  // --- effects -----------------------------------------------------------
  {
    id: "count-up",
    group: "effect",
    name: "Count up",
    blurb: "A figure rolls from zero, or its previous value, to the real one.",
    kind: "countup",
    targets: 1,
    triggers: ["view", "mount", "change"],
    defaultTrigger: "view",
    duration: "count",
    easing: "decelerate",
    rehearsable: true,
  },
  {
    id: "stagger",
    group: "effect",
    name: "Stagger",
    blurb: "Children of a grid or list arrive in sequence rather than all at once.",
    kind: "waapi",
    targets: 1,
    children: true,
    triggers: ["view", "mount"],
    defaultTrigger: "view",
    duration: "enter",
    easing: "decelerate",
    rehearsable: true,
  },
  {
    id: "rise-in",
    group: "effect",
    name: "Rise in",
    blurb: "Fade plus a short upward translate. The default per-child effect, and the usual scroll reveal.",
    kind: "waapi",
    targets: 1,
    triggers: ["view", "mount"],
    defaultTrigger: "view",
    duration: "enter",
    easing: "decelerate",
    rehearsable: true,
  },
  {
    id: "fade",
    group: "effect",
    name: "Fade in / out",
    blurb: "The plain one. Also what every other pattern falls back to under reduced motion.",
    kind: "waapi",
    targets: 1,
    triggers: ["view", "mount", "hover", "change"],
    defaultTrigger: "view",
    duration: "base",
    easing: "standard",
    rehearsable: true,
  },
];

export function getPattern(id: string): MotionPattern | null {
  return MOTION_PATTERNS.find((p) => p.id === id) ?? null;
}

export const TRIGGER_LABELS: Record<MotionTrigger, string> = {
  mount: "On mount",
  view: "On enter viewport",
  change: "On value change",
  hover: "On hover",
  nav: "On navigation",
};

// ---------------------------------------------------------------------------
// Timing

export type ResolvedTiming = {
  duration: number;
  easing: string;
  durationToken: string;
  easingToken: string;
  /** True when a token name was missing from the system and we fell back. */
  fallback: boolean;
};

export function resolveTiming(
  pattern: MotionPattern,
  system: MotionSystem,
  overrides?: { duration?: string; easing?: string },
): ResolvedTiming {
  const durationToken = overrides?.duration ?? pattern.duration;
  const easingToken = overrides?.easing ?? pattern.easing;
  const duration = system.durations[durationToken];
  const easing = system.easings[easingToken];
  return {
    duration: typeof duration === "number" ? duration : FALLBACK_DURATION,
    easing: typeof easing === "string" ? easing : FALLBACK_EASING,
    durationToken,
    easingToken,
    fallback: typeof duration !== "number" || typeof easing !== "string",
  };
}

// ---------------------------------------------------------------------------
// Stagger
//
// A fixed per-child step is unusable past a dozen children — sixty cards
// at 60ms is a 3.8s entrance. The step compresses so the whole sequence
// stays under maxTotal; that clamp is the difference between this and a
// jQuery plugin, so the UI always shows when it fired.

export type StaggerResult = {
  step: number;
  total: number;
  clamped: boolean;
  requested: number;
};

export function clampStagger(input: {
  step: number;
  count: number;
  childDuration: number;
  maxTotal: number;
}): StaggerResult {
  const requested = Math.max(0, input.step);
  const n = Math.max(1, Math.floor(input.count));
  const child = Math.max(0, input.childDuration);
  const max = Math.max(child, input.maxTotal);
  if (n < 2) return { step: requested, total: child, clamped: false, requested };

  let step = requested;
  let total = step * (n - 1) + child;
  let clamped = false;
  if (total > max) {
    step = Math.max(4, (max - child) / (n - 1));
    total = step * (n - 1) + child;
    clamped = true;
  }
  return { step, total, clamped, requested };
}

// ---------------------------------------------------------------------------
// Count-up number parsing
//
// The format has to survive the animation: £128,460 counts through
// £71,204, never 71204.38. Read the rendered text once, keep the prefix,
// grouping and decimals, re-apply them every frame.

export type NumericText = {
  /** Everything before the first digit (currency symbol, label). */
  prefix: string;
  /** Everything after the last digit (%, unit, word). */
  suffix: string;
  value: number;
  decimals: number;
  grouped: boolean;
  /** The separator used for thousands, when grouped. */
  groupSep: string;
  decimalSep: string;
};

const NUM_RE = /-?\d[\d.,   ]*\d|-?\d/;

/** Pull a formatted number out of rendered text. Null when there isn't one. */
export function parseNumeric(text: string): NumericText | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const m = NUM_RE.exec(trimmed);
  if (!m) return null;

  const raw = m[0];
  const prefix = trimmed.slice(0, m.index);
  const suffix = trimmed.slice(m.index + raw.length);

  // Decide which separator is decimal: the LAST of . or , wins, and only
  // when it is followed by 1-2 digits (3 digits reads as grouping).
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  let decimalSep = "";
  let decimals = 0;
  const cand = lastDot > lastComma ? lastDot : lastComma;
  if (cand > -1) {
    const tail = raw.slice(cand + 1);
    if (/^\d{1,2}$/.test(tail)) {
      decimalSep = raw[cand] ?? "";
      decimals = tail.length;
    }
  }

  const intPart = decimalSep ? raw.slice(0, raw.lastIndexOf(decimalSep)) : raw;
  const groupMatch = /[.,   ]/.exec(intPart);
  const grouped = !!groupMatch;
  const groupSep = grouped ? (groupMatch[0] ?? ",") : ",";

  const fracPart = decimalSep ? raw.slice(raw.lastIndexOf(decimalSep) + 1) : "";
  const digitsOnly = intPart.replace(/[^\d-]/g, "");
  const numeric = Number(fracPart ? `${digitsOnly}.${fracPart}` : digitsOnly);
  if (!Number.isFinite(numeric) || digitsOnly === "" || digitsOnly === "-") return null;

  return { prefix, suffix, value: numeric, decimals, grouped, groupSep, decimalSep: decimalSep || "." };
}

/** Re-apply a parsed number's formatting to a new value. */
export function formatNumeric(value: number, meta: NumericText): string {
  const neg = value < 0;
  const abs = Math.abs(value);
  const fixed = abs.toFixed(meta.decimals);
  const [intRaw, fracRaw] = fixed.split(".");
  let int = intRaw ?? "0";
  if (meta.grouped) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, meta.groupSep);
  const frac = meta.decimals > 0 && fracRaw ? meta.decimalSep + fracRaw : "";
  return `${meta.prefix}${neg ? "-" : ""}${int}${frac}${meta.suffix}`;
}

// ---------------------------------------------------------------------------
// Ranking
//
// Element-first picking only pays off if the catalog narrows. Score each
// pattern against what was clicked; anything scoring zero drops under
// "Show all patterns" rather than disappearing.

const TAG_RE = /^<\s*([a-z][a-z0-9-]*)/i;
const CLASS_RE = /\sclass\s*=\s*"([^"]*)"/i;
const ROLE_RE = /\srole\s*=\s*"([^"]*)"/i;
const TAG_COUNT_RE = /<\s*[a-z][a-z0-9-]*/gi;

export function readTarget(target: AnnotationTarget | null | undefined): TargetFacts | null {
  if (!target?.outerHTML) return null;
  const html = target.outerHTML;
  const tag = (TAG_RE.exec(html)?.[1] ?? "div").toLowerCase();
  const classes = (CLASS_RE.exec(html)?.[1] ?? "")
    .split(/\s+/)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const role = ROLE_RE.exec(html)?.[1]?.toLowerCase() ?? null;
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const descendants = Math.max(0, (html.match(TAG_COUNT_RE)?.length ?? 1) - 1);
  const display = (target.computedStyles?.display ?? "").toLowerCase();
  return { tag, classes, role, text, descendants, display };
}

function hasClassLike(facts: TargetFacts, needles: string[]): boolean {
  return facts.classes.some((c) => needles.some((n) => c.includes(n)));
}

/** Score one pattern against a picked element. 0 = not suggested. */
export function scorePattern(pattern: MotionPattern, facts: TargetFacts | null): number {
  if (!facts) return 0;
  const { tag, role, text, descendants, display } = facts;
  const isGridish = display.includes("grid") || display.includes("flex");
  // A figure is a LEAF: a list whose items happen to be short digits is a
  // list. Length first — parseNumeric on a paragraph is wasted work.
  const looksNumeric = descendants === 0 && text.length <= 24 && !!parseNumeric(text);
  const listish = tag === "ul" || tag === "ol" || tag === "tbody" || isGridish;
  const manyChildren = descendants >= 3;

  switch (pattern.id) {
    case "count-up":
      return looksNumeric ? 100 : 0;
    case "stagger":
      return listish && manyChildren ? 90 : manyChildren ? 35 : 0;
    case "container-transform":
      return tag === "a" || tag === "article" || hasClassLike(facts, ["card", "tile", "item"])
        ? 85
        : tag === "li" || tag === "button"
          ? 45
          : 0;
    case "forward-backward":
      return tag === "a" || tag === "li" || tag === "button" ? 70 : 0;
    case "lateral":
      return role === "tablist" || role === "tab" || hasClassLike(facts, ["tab", "carousel", "slider"])
        ? 95
        : 0;
    case "top-level":
      // A real nav outranks the stagger a flex nav with 3+ links also earns.
      return tag === "nav" || role === "navigation"
        ? 95
        : hasClassLike(facts, ["nav", "sidebar", "rail"])
          ? 85
          : 0;
    case "enter-exit":
      return role === "dialog" || role === "alertdialog" || role === "menu" || tag === "dialog"
        ? 95
        : hasClassLike(facts, ["modal", "dialog", "sheet", "drawer", "popover", "toast", "snackbar"])
          ? 80
          : 0;
    case "skeleton":
      return hasClassLike(facts, ["skeleton", "placeholder", "shimmer", "loading"]) ? 90 : 0;
    case "rise-in":
      // Always a reasonable answer, just never the best one.
      return 20;
    case "fade":
      return 15;
    default:
      return 0;
  }
}

export type RankedPatterns = { suggested: MotionPattern[]; rest: MotionPattern[] };

/** Element-first ordering. With no target, returns the catalog unchanged. */
export function rankPatterns(
  facts: TargetFacts | null,
  patterns: MotionPattern[] = MOTION_PATTERNS,
): RankedPatterns {
  if (!facts) return { suggested: [], rest: [...patterns] };
  const scored = patterns.map((p) => ({ p, score: scorePattern(p, facts) }));
  const suggested = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .map((s) => s.p);
  const rest = patterns.filter((p) => !suggested.includes(p));
  return { suggested, rest };
}

/**
 * First previewable wins: whatever auto-selects or auto-plays after a pick
 * must be a pattern the page can actually rehearse. Suggested first, then
 * the rest, skipping the two-target transitions — those are offered in
 * the list, never silently chosen.
 */
export function firstRehearsable(ranked: RankedPatterns): MotionPattern | null {
  return (
    ranked.suggested.find((p) => p.rehearsable) ??
    ranked.rest.find((p) => p.rehearsable) ??
    null
  );
}

/** The three named stagger steps, in order, from the active system. A
 *  step of 0ms (or less) is no stagger at all — an imported system that
 *  sets one gets no chip for it rather than a chip that does nothing. */
export function staggerChoices(
  system: MotionSystem,
): Array<{ key: "tight" | "base" | "loose"; ms: number }> {
  return (
    [
      { key: "tight", ms: system.stagger.tight },
      { key: "base", ms: system.stagger.base },
      { key: "loose", ms: system.stagger.loose },
    ] as Array<{ key: "tight" | "base" | "loose"; ms: number }>
  ).filter((c) => Number.isFinite(c.ms) && c.ms > 0);
}

/**
 * Which pattern to keep after the target is re-picked. A pattern the OLD
 * element merely suggested follows the new element (grid → dialog goes
 * Stagger → Enter and exit); a choice made off-list ("Show all") was
 * deliberate and survives as long as the catalog still has it.
 */
export function nextPatternAfterRepick(
  currentId: string | null,
  ranked: RankedPatterns,
  previous?: RankedPatterns | null,
): string | null {
  const top = ranked.suggested[0]?.id ?? null;
  if (!currentId) return top;
  const wasSuggested = !previous || previous.suggested.some((p) => p.id === currentId);
  if (wasSuggested) return top;
  const stillExists = [...ranked.suggested, ...ranked.rest].some((p) => p.id === currentId);
  return stillExists ? currentId : top;
}

// ---------------------------------------------------------------------------
// Plan building

export type PlanContext = {
  /** Resolved children count on the page (stagger / skeleton). */
  childCount?: number;
  /** Stagger step in ms before clamping. */
  staggerStep?: number;
  /** Build the reduced-motion substitute instead of the real thing. */
  reduced?: boolean;
};

const RISE = {
  opacity: [0, 1],
  transform: ["translateY(12px)", "translateY(0px)"],
} as Record<string, Array<string | number>>;

export function buildPlan(
  pattern: MotionPattern,
  system: MotionSystem,
  ctx: PlanContext = {},
  overrides?: { duration?: string; easing?: string },
): MotionPlan {
  const timing = resolveTiming(pattern, system, overrides);
  const reduced = !!ctx.reduced;

  // Reduced motion collapses every pattern to the same short crossfade.
  // That is the substitute the applied code must ship, so rehearsing it
  // has to show exactly this and nothing cleverer.
  if (reduced) {
    const d = system.durations.fast ?? 120;
    if (pattern.kind === "countup") {
      return {
        patternId: pattern.id,
        kind: "countup",
        total: 0,
        steps: [],
        count: { duration: 0, easing: "linear" },
        reduced: true,
      };
    }
    return {
      patternId: pattern.id,
      kind: "waapi",
      total: d,
      steps: [
        {
          node: pattern.children ? "child" : "target",
          keyframes: { opacity: [0, 1] },
          delay: 0,
          duration: d,
          easing: "linear",
        },
      ],
      reduced: true,
    };
  }

  if (pattern.kind === "countup") {
    return {
      patternId: pattern.id,
      kind: "countup",
      total: timing.duration,
      steps: [],
      count: { duration: timing.duration, easing: timing.easing },
      reduced: false,
    };
  }

  // Child-scoped patterns stagger; everything else is one animation.
  if (pattern.children) {
    const count = Math.max(1, ctx.childCount ?? 1);
    const requested = ctx.staggerStep ?? system.stagger.base;
    const isSkeleton = pattern.id === "skeleton";
    const childDuration = isSkeleton ? timing.duration : timing.duration;
    const s = clampStagger({
      step: requested,
      count,
      childDuration,
      maxTotal: system.stagger.maxTotal,
    });
    const keyframes: Record<string, Array<string | number>> = isSkeleton
      ? { opacity: [0.3, 0.75, 0.3] }
      : RISE;
    return {
      patternId: pattern.id,
      kind: "waapi",
      total: s.total,
      steps: [
        {
          node: "child",
          keyframes,
          delay: 0, // per-child delay is applied by the runner: index * step
          duration: childDuration,
          easing: isSkeleton ? "ease-in-out" : timing.easing,
        },
      ],
      stagger: { step: s.step, requested: s.requested, clamped: s.clamped },
      reduced: false,
    };
  }

  let keyframes: Record<string, Array<string | number>>;
  switch (pattern.id) {
    case "lateral":
      keyframes = { transform: ["translateX(28px)", "translateX(0px)"], opacity: [0.25, 1] };
      break;
    case "top-level":
      keyframes = { opacity: [1, 0, 0, 1], offset: [0, 0.35, 0.45, 1] };
      break;
    case "enter-exit":
      keyframes = { opacity: [0, 1], transform: ["translateY(16px) scale(0.97)", "none"] };
      break;
    case "rise-in":
      keyframes = RISE;
      break;
    case "fade":
    default:
      keyframes = { opacity: [0, 1] };
      break;
  }

  return {
    patternId: pattern.id,
    kind: "waapi",
    total: timing.duration,
    steps: [
      {
        node: "target",
        keyframes,
        delay: 0,
        duration: timing.duration,
        easing: timing.easing,
      },
    ],
    reduced: false,
  };
}

// ---------------------------------------------------------------------------
// Apply payload (op:motion-apply)
//
// Named tokens plus the system's import path, never resolved numbers —
// otherwise the agent invents a cubic-bezier and the design system
// quietly gains a curve nobody approved. Flat and small by design.

export type MotionApplyPayload = {
  pattern: string;
  targets: { start: { selector: string; label?: string }; end?: { selector: string; label?: string } };
  tokens: { duration: string; easing: string; staggerStep?: number };
  trigger: MotionTrigger;
  system: { name: string; import?: string; file?: string };
  reducedMotion: { required: true; guard?: string };
  url: string;
  note?: string;
};

export function buildApplyPayload(input: {
  pattern: MotionPattern;
  system: MotionSystem;
  timing: ResolvedTiming;
  start: AnnotationTarget;
  end?: AnnotationTarget | null;
  trigger: MotionTrigger;
  staggerStep?: number;
  url: string;
  note?: string;
}): MotionApplyPayload {
  const label = (t: AnnotationTarget) => t.nearbyText?.[0]?.slice(0, 60) || undefined;
  return {
    pattern: input.pattern.id,
    targets: {
      start: { selector: input.start.selector, label: label(input.start) },
      ...(input.end ? { end: { selector: input.end.selector, label: label(input.end) } } : {}),
    },
    tokens: {
      duration: input.timing.durationToken,
      easing: input.timing.easingToken,
      ...(input.pattern.children && typeof input.staggerStep === "number"
        ? { staggerStep: input.staggerStep }
        : {}),
    },
    trigger: input.trigger,
    system: {
      name: input.system.name,
      import: input.system.reducedMotion?.import,
      file: input.system.source.path,
    },
    reducedMotion: { required: true, guard: input.system.reducedMotion?.guard },
    url: input.url,
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, 400) } : {}),
  };
}
