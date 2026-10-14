import { describe, expect, it } from "vitest";
import type { AnnotationTarget } from "@pinta/shared";
import {
  DEFAULT_MOTION_SYSTEM,
  MOTION_PATTERNS,
  buildApplyPayload,
  buildPlan,
  clampStagger,
  firstRehearsable,
  formatNumeric,
  getPattern,
  nextPatternAfterRepick,
  parseNumeric,
  rankPatterns,
  readTarget,
  resolveTiming,
  scorePattern,
  staggerChoices,
  type MotionSystem,
} from "./motion.js";

function target(html: string, styles: Record<string, string> = {}): AnnotationTarget {
  return {
    selector: "x",
    outerHTML: html,
    computedStyles: styles,
    nearbyText: [],
    boundingRect: { x: 0, y: 0, width: 10, height: 10 },
  };
}

describe("catalog", () => {
  it("has both groups and unique ids", () => {
    const ids = MOTION_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(MOTION_PATTERNS.some((p) => p.group === "transition")).toBe(true);
    expect(MOTION_PATTERNS.some((p) => p.group === "effect")).toBe(true);
  });

  it("only the two-target transitions are not rehearsable yet", () => {
    const notYet = MOTION_PATTERNS.filter((p) => !p.rehearsable).map((p) => p.id);
    expect(notYet.sort()).toEqual(["container-transform", "forward-backward"]);
  });

  it("every pattern's default trigger is one it offers", () => {
    for (const p of MOTION_PATTERNS) expect(p.triggers).toContain(p.defaultTrigger);
  });

  it("every pattern's tokens exist in the default system", () => {
    for (const p of MOTION_PATTERNS) {
      expect(DEFAULT_MOTION_SYSTEM.durations[p.duration]).toBeTypeOf("number");
      expect(DEFAULT_MOTION_SYSTEM.easings[p.easing]).toBeTypeOf("string");
    }
  });

  it("getPattern finds and misses cleanly", () => {
    expect(getPattern("count-up")?.name).toBe("Count up");
    expect(getPattern("nope")).toBeNull();
  });
});

describe("resolveTiming", () => {
  it("resolves token names to numbers and curves", () => {
    const t = resolveTiming(getPattern("count-up")!, DEFAULT_MOTION_SYSTEM);
    expect(t.duration).toBe(1100);
    expect(t.durationToken).toBe("count");
    expect(t.easing).toContain("cubic-bezier");
    expect(t.fallback).toBe(false);
  });

  it("falls back, and says so, when a token is missing", () => {
    const thin: MotionSystem = { ...DEFAULT_MOTION_SYSTEM, durations: {}, easings: {} };
    const t = resolveTiming(getPattern("fade")!, thin);
    expect(t.duration).toBe(300);
    expect(t.fallback).toBe(true);
  });

  it("honours overrides", () => {
    const t = resolveTiming(getPattern("fade")!, DEFAULT_MOTION_SYSTEM, {
      duration: "morph",
      easing: "accelerate",
    });
    expect(t.duration).toBe(500);
    expect(t.easingToken).toBe("accelerate");
  });
});

describe("clampStagger", () => {
  it("leaves a short sequence alone", () => {
    const r = clampStagger({ step: 60, count: 8, childDuration: 260, maxTotal: 900 });
    expect(r.clamped).toBe(false);
    expect(r.step).toBe(60);
    expect(r.total).toBe(680);
  });

  it("compresses the step when the total would run long", () => {
    const r = clampStagger({ step: 140, count: 8, childDuration: 260, maxTotal: 900 });
    expect(r.clamped).toBe(true);
    expect(r.total).toBeLessThanOrEqual(900);
    expect(r.step).toBeLessThan(140);
    expect(r.requested).toBe(140);
  });

  it("stays usable at sixty children", () => {
    const r = clampStagger({ step: 60, count: 60, childDuration: 300, maxTotal: 900 });
    expect(r.total).toBeLessThanOrEqual(900);
    expect(r.step).toBeGreaterThanOrEqual(4);
  });

  it("a single child has no sequence to stagger", () => {
    const r = clampStagger({ step: 60, count: 1, childDuration: 300, maxTotal: 900 });
    expect(r.clamped).toBe(false);
    expect(r.total).toBe(300);
  });
});

describe("parseNumeric / formatNumeric", () => {
  it("keeps a currency prefix and thousands grouping", () => {
    const m = parseNumeric("£128,460")!;
    expect(m.value).toBe(128460);
    expect(m.prefix).toBe("£");
    expect(m.grouped).toBe(true);
    expect(m.decimals).toBe(0);
    expect(formatNumeric(71204, m)).toBe("£71,204");
  });

  it("keeps decimals and a suffix", () => {
    const m = parseNumeric("42.8%")!;
    expect(m.value).toBeCloseTo(42.8);
    expect(m.decimals).toBe(1);
    expect(m.suffix).toBe("%");
    expect(formatNumeric(10.25, m)).toBe("10.3%");
  });

  it("treats a trailing group of three as grouping, not decimals", () => {
    const m = parseNumeric("1,234")!;
    expect(m.value).toBe(1234);
    expect(m.decimals).toBe(0);
  });

  it("handles a word suffix", () => {
    const m = parseNumeric("1,234 claims")!;
    expect(m.value).toBe(1234);
    expect(m.suffix).toBe(" claims");
    expect(formatNumeric(600, m)).toBe("600 claims");
  });

  it("round-trips the original value", () => {
    for (const s of ["£128,460", "42.8%", "7", "-15", "1,234 claims"]) {
      const m = parseNumeric(s)!;
      expect(formatNumeric(m.value, m)).toBe(s);
    }
  });

  it("returns null when there is no number", () => {
    expect(parseNumeric("Settled this quarter")).toBeNull();
    expect(parseNumeric("")).toBeNull();
  });
});

describe("readTarget", () => {
  it("reads tag, classes, role and display", () => {
    const f = readTarget(
      target('<a class="claim-card Big" role="link"><span>Hi</span></a>', { display: "flex" }),
    )!;
    expect(f.tag).toBe("a");
    expect(f.classes).toContain("claim-card");
    expect(f.classes).toContain("big");
    expect(f.role).toBe("link");
    expect(f.display).toBe("flex");
    expect(f.descendants).toBe(1);
  });

  it("is null without a target", () => {
    expect(readTarget(null)).toBeNull();
  });
});

describe("rankPatterns", () => {
  it("puts count up first for a figure", () => {
    const f = readTarget(target("<div>£128,460</div>"));
    expect(rankPatterns(f).suggested[0]?.id).toBe("count-up");
  });

  it("puts stagger first for a grid with children", () => {
    const f = readTarget(
      target("<ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>", { display: "grid" }),
    );
    expect(rankPatterns(f).suggested[0]?.id).toBe("stagger");
  });

  it("puts lateral first for a tablist", () => {
    const f = readTarget(target('<div role="tablist"><button>A</button></div>'));
    expect(rankPatterns(f).suggested[0]?.id).toBe("lateral");
  });

  it("puts enter and exit first for a dialog", () => {
    const f = readTarget(target('<div role="dialog"><p>hi</p></div>'));
    expect(rankPatterns(f).suggested[0]?.id).toBe("enter-exit");
  });

  it("puts container transform first for a card link", () => {
    const f = readTarget(target('<a class="claim-card">Claim</a>'));
    expect(rankPatterns(f).suggested[0]?.id).toBe("container-transform");
  });

  it("puts top level first for a flex nav, above the stagger its links earn", () => {
    const f = readTarget(
      target("<nav><a>Home</a><a>Claims</a><a>Reports</a></nav>", { display: "flex" }),
    );
    expect(rankPatterns(f).suggested[0]?.id).toBe("top-level");
  });

  it("a list of short digits is a list, not a figure", () => {
    const f = readTarget(target("<ul><li>1</li><li>2</li><li>3</li></ul>", { display: "grid" }));
    const r = rankPatterns(f);
    expect(r.suggested[0]?.id).toBe("stagger");
    expect(r.suggested.some((p) => p.id === "count-up")).toBe(false);
  });

  it("count up wants a leaf — a figure wrapped in markup is not a candidate", () => {
    const f = readTarget(target("<p><span>£</span><strong>128,460</strong></p>"));
    expect(scorePattern(getPattern("count-up")!, f)).toBe(0);
  });

  it("never loses a pattern — suggested plus rest is the whole catalog", () => {
    const f = readTarget(target('<a class="card">x</a>'));
    const r = rankPatterns(f);
    expect(r.suggested.length + r.rest.length).toBe(MOTION_PATTERNS.length);
    expect(new Set([...r.suggested, ...r.rest].map((p) => p.id)).size).toBe(
      MOTION_PATTERNS.length,
    );
  });

  it("with nothing picked, shows the catalog unranked", () => {
    const r = rankPatterns(null);
    expect(r.suggested).toEqual([]);
    expect(r.rest).toHaveLength(MOTION_PATTERNS.length);
  });

  it("rise in and fade are always available as fallbacks", () => {
    const f = readTarget(target("<section>Some prose here</section>"))!;
    expect(scorePattern(getPattern("rise-in")!, f)).toBeGreaterThan(0);
    expect(scorePattern(getPattern("fade")!, f)).toBeGreaterThan(0);
  });
});

describe("nextPatternAfterRepick", () => {
  const grid = rankPatterns(
    readTarget(target("<ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>", { display: "grid" })),
  );
  const dialog = rankPatterns(
    readTarget(target('<div role="dialog"><h2>t</h2><p>a</p><button>ok</button></div>')),
  );
  const section = rankPatterns(readTarget(target("<section>Some prose here</section>")));
  const figure = rankPatterns(readTarget(target("<div>£128,460</div>")));

  it("a merely suggested pattern follows the new element: grid → dialog goes to enter-exit", () => {
    expect(grid.suggested[0]?.id).toBe("stagger");
    expect(nextPatternAfterRepick("stagger", dialog, grid)).toBe("enter-exit");
  });

  it("a suggested Count up on a figure gives way to Stagger on a grid", () => {
    expect(nextPatternAfterRepick("count-up", grid, figure)).toBe("stagger");
  });

  it("a Show-all choice survives a re-pick of the same element", () => {
    expect(section.suggested.some((p) => p.id === "lateral")).toBe(false);
    expect(nextPatternAfterRepick("lateral", section, section)).toBe("lateral");
  });

  it("with no current pattern, the top suggestion wins", () => {
    expect(nextPatternAfterRepick(null, dialog, grid)).toBe("enter-exit");
    expect(nextPatternAfterRepick(null, rankPatterns(null), null)).toBeNull();
  });
});

describe("firstRehearsable", () => {
  it("skips a two-target top suggestion: a card link auto-plays Rise in, not Container transform", () => {
    const ranked = rankPatterns(readTarget(target('<a class="card">Claim</a>')));
    expect(ranked.suggested[0]?.id).toBe("container-transform");
    expect(ranked.suggested[1]?.id).toBe("forward-backward");
    expect(firstRehearsable(ranked)?.id).toBe("rise-in");
  });

  it("takes the top suggestion when it can play", () => {
    const ranked = rankPatterns(readTarget(target("<span>£128,460</span>")));
    expect(firstRehearsable(ranked)?.id).toBe("count-up");
  });

  it("falls through to the rest when nothing is suggested", () => {
    const ranked = rankPatterns(null);
    expect(ranked.suggested).toEqual([]);
    expect(firstRehearsable(ranked)?.id).toBe("lateral");
  });

  it("is null only when the whole catalog is un-rehearsable", () => {
    const none = rankPatterns(null, MOTION_PATTERNS.filter((p) => !p.rehearsable));
    expect(firstRehearsable(none)).toBeNull();
  });

  it("is null for an empty ranking (nothing suggested, nothing else)", () => {
    expect(firstRehearsable({ suggested: [], rest: [] })).toBeNull();
  });
});

describe("staggerChoices", () => {
  it("names the three system steps in order", () => {
    expect(staggerChoices(DEFAULT_MOTION_SYSTEM)).toEqual([
      { key: "tight", ms: 40 },
      { key: "base", ms: 60 },
      { key: "loose", ms: 90 },
    ]);
  });

  it("follows an imported system, not the built-in numbers", () => {
    const custom: MotionSystem = {
      ...DEFAULT_MOTION_SYSTEM,
      stagger: { tight: 20, base: 50, loose: 120, maxTotal: 600 },
    };
    expect(staggerChoices(custom).map((c) => c.ms)).toEqual([20, 50, 120]);
  });

  it("drops a zero (or negative) step — no chip for a stagger that does nothing", () => {
    const custom: MotionSystem = {
      ...DEFAULT_MOTION_SYSTEM,
      stagger: { tight: 0, base: 50, loose: -5, maxTotal: 600 },
    };
    expect(staggerChoices(custom)).toEqual([{ key: "base", ms: 50 }]);
  });
});

describe("buildPlan", () => {
  it("builds a single-step plan for a simple effect", () => {
    const plan = buildPlan(getPattern("fade")!, DEFAULT_MOTION_SYSTEM);
    expect(plan.kind).toBe("waapi");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.node).toBe("target");
    expect(plan.total).toBe(150);
  });

  it("builds a child-scoped plan with a clamp report for stagger", () => {
    const plan = buildPlan(getPattern("stagger")!, DEFAULT_MOTION_SYSTEM, {
      childCount: 40,
      staggerStep: 140,
    });
    expect(plan.steps[0]!.node).toBe("child");
    expect(plan.stagger?.clamped).toBe(true);
    expect(plan.total).toBeLessThanOrEqual(DEFAULT_MOTION_SYSTEM.stagger.maxTotal);
  });

  it("marks count up as a text interpolation, not keyframes", () => {
    const plan = buildPlan(getPattern("count-up")!, DEFAULT_MOTION_SYSTEM);
    expect(plan.kind).toBe("countup");
    expect(plan.steps).toHaveLength(0);
    expect(plan.count?.duration).toBe(1100);
  });

  it("reduced motion collapses every pattern to a short crossfade", () => {
    for (const p of MOTION_PATTERNS) {
      const plan = buildPlan(p, DEFAULT_MOTION_SYSTEM, { reduced: true, childCount: 8 });
      expect(plan.reduced).toBe(true);
      if (p.kind === "countup") {
        expect(plan.total).toBe(0);
      } else {
        expect(plan.total).toBe(DEFAULT_MOTION_SYSTEM.durations.fast);
        expect(plan.steps[0]!.keyframes.opacity).toEqual([0, 1]);
        expect(plan.steps[0]!.keyframes.transform).toBeUndefined();
      }
    }
  });

  it("stays plain JSON so it can cross chrome.tabs.sendMessage", () => {
    const plan = buildPlan(getPattern("stagger")!, DEFAULT_MOTION_SYSTEM, { childCount: 6 });
    expect(() => structuredClone(plan)).not.toThrow();
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it("every rehearsable pattern produces a runnable plan", () => {
    for (const p of MOTION_PATTERNS.filter((x) => x.rehearsable)) {
      const plan = buildPlan(p, DEFAULT_MOTION_SYSTEM, { childCount: 5 });
      expect(plan.total).toBeGreaterThan(0);
      if (plan.kind === "waapi") expect(plan.steps.length).toBeGreaterThan(0);
    }
  });
});

describe("buildApplyPayload", () => {
  const base = {
    pattern: getPattern("container-transform")!,
    system: DEFAULT_MOTION_SYSTEM,
    timing: resolveTiming(getPattern("container-transform")!, DEFAULT_MOTION_SYSTEM),
    start: { ...target("<a class='card'>x</a>"), selector: "a.card", nearbyText: ["Claim INS-4821"] },
    end: { ...target("<main>y</main>"), selector: "main.claim-detail" },
    trigger: "nav" as const,
    url: "http://localhost:5173/claims",
  };

  it("carries token NAMES, never resolved numbers", () => {
    const p = buildApplyPayload(base);
    expect(p.tokens.duration).toBe("morph");
    expect(p.tokens.easing).toBe("standard");
    expect(JSON.stringify(p)).not.toContain("cubic-bezier");
    expect(JSON.stringify(p)).not.toContain("500");
  });

  it("always requires reduced motion", () => {
    expect(buildApplyPayload(base).reducedMotion.required).toBe(true);
  });

  it("omits the destination for one-target patterns", () => {
    const p = buildApplyPayload({ ...base, pattern: getPattern("fade")!, end: null });
    expect(p.targets.end).toBeUndefined();
  });

  it("only carries a stagger step for child-scoped patterns", () => {
    const withStep = buildApplyPayload({
      ...base,
      pattern: getPattern("stagger")!,
      staggerStep: 60,
    });
    expect(withStep.tokens.staggerStep).toBe(60);
    const without = buildApplyPayload({ ...base, pattern: getPattern("fade")!, staggerStep: 60 });
    expect(without.tokens.staggerStep).toBeUndefined();
  });

  it("trims an over-long note", () => {
    const p = buildApplyPayload({ ...base, note: "x".repeat(900) });
    expect(p.note!.length).toBe(400);
  });

  it("stays small — the whole payload is well under a kilobyte", () => {
    expect(JSON.stringify(buildApplyPayload(base)).length).toBeLessThan(1024);
  });
});
