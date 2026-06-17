import { describe, expect, it } from "vitest";
import {
  addDays,
  categoryLabel,
  foldWeekends,
  formatDayHeading,
  isWeekend,
  parseReportPayload,
  rangeWindow,
  renderReportMarkdown,
  type ReportDay,
  type ReportRun,
} from "./report.js";

// 2026-06-05 is a Friday. The week: Mon 06-01 … Fri 06-05, Sat 06-06,
// Sun 06-07. Used as the anchor across most cases.
const FRI = "2026-06-05";

function day(date: string, titles: string[]): ReportDay {
  return {
    date,
    items: titles.map((t, i) => ({
      id: `${date}:${i}`,
      title: t,
      category: "chore" as const,
      source: "git" as const,
    })),
  };
}

describe("date helpers", () => {
  it("formats a day heading with a zero-padded day", () => {
    expect(formatDayHeading("2026-06-05")).toBe("June 05 2026");
    expect(formatDayHeading("2026-12-31")).toBe("December 31 2026");
  });

  it("identifies weekends (UTC)", () => {
    expect(isWeekend("2026-06-05")).toBe(false); // Fri
    expect(isWeekend("2026-06-06")).toBe(true); // Sat
    expect(isWeekend("2026-06-07")).toBe(true); // Sun
    expect(isWeekend("2026-06-08")).toBe(false); // Mon
  });

  it("adds days across month boundaries", () => {
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(addDays("2026-06-01", -1)).toBe("2026-05-31");
  });

  it("labels categories", () => {
    expect(categoryLabel("bug-fix")).toBe("Bug fix");
    expect(categoryLabel("deps")).toBe("Deps");
  });
});

describe("rangeWindow", () => {
  it("daily is just the anchor", () => {
    const w = rangeWindow("daily", FRI);
    expect(w.since).toBe(FRI);
    expect(w.until).toBe(FRI);
    expect(w.label).toBe("June 05 2026");
  });

  it("weekly spans Monday-of-week through the anchor", () => {
    const w = rangeWindow("weekly", FRI);
    expect(w.since).toBe("2026-06-01"); // Monday
    expect(w.until).toBe(FRI);
  });

  it("weekly from a mid-week anchor stops at the anchor", () => {
    const wed = "2026-06-03";
    const w = rangeWindow("weekly", wed);
    expect(w.since).toBe("2026-06-01");
    expect(w.until).toBe(wed);
  });

  it("sprint covers 10 working days ending at the anchor", () => {
    // Fri 06-05 back 10 weekdays: 06-05,04,03,02,01 (wk1) then
    // 05-29,28,27,26,25 (wk2, skipping the 05-30/31 weekend).
    const w = rangeWindow("sprint", FRI);
    expect(w.until).toBe(FRI);
    expect(w.since).toBe("2026-05-25"); // Monday two weeks prior
    expect(w.workingDays).toBe(10);
  });
});

describe("foldWeekends", () => {
  it("daily is a passthrough", () => {
    const days = [day("2026-06-06", ["sat work"])]; // a Saturday
    const out = foldWeekends(days, "daily");
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe("2026-06-06");
  });

  it("folds a Saturday into the preceding Friday when Monday is absent", () => {
    const days = [day(FRI, ["a"]), day("2026-06-06", ["sat1", "sat2"])];
    const out = foldWeekends(days, "weekly");
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe(FRI);
    expect(out[0]!.items.map((i) => i.title)).toEqual(["a", "sat1", "sat2"]);
    expect(out[0]!.foldedFrom).toEqual(["2026-06-06"]);
  });

  it("folds a Sunday into the lighter neighbour (empty Monday beats a busy Friday)", () => {
    const days = [
      day(FRI, ["f1", "f2"]), // Friday: 2 items
      day("2026-06-07", ["sun work"]), // Sunday: 1 item
      day("2026-06-08", []), // Monday: empty (0 items)
    ];
    const out = foldWeekends(days, "sprint");
    const mon = out.find((d) => d.date === "2026-06-08");
    expect(mon).toBeDefined(); // empty Monday is kept once it receives the fold
    expect(mon!.items.map((i) => i.title)).toEqual(["sun work"]);
    expect(mon!.foldedFrom).toEqual(["2026-06-07"]);
    expect(out.find((d) => d.date === FRI)!.items).toHaveLength(2); // Friday untouched
  });

  it("ties go to the preceding Friday", () => {
    // Fri 1 item, Mon 1 item → Saturday work ties → Friday wins.
    const days = [
      day(FRI, ["f1"]),
      day("2026-06-06", ["sat work"]), // Saturday
      day("2026-06-08", ["m1"]), // Monday
    ];
    const out = foldWeekends(days, "weekly");
    const fri = out.find((d) => d.date === FRI)!;
    expect(fri.items.map((i) => i.title)).toEqual(["f1", "sat work"]);
  });

  it("creates the preceding Friday if neither neighbour is present", () => {
    const days = [day("2026-06-06", ["orphan sat"])]; // lone Saturday
    const out = foldWeekends(days, "weekly");
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe(FRI); // created Friday 06-05
    expect(out[0]!.items.map((i) => i.title)).toEqual(["orphan sat"]);
  });

  it("returns days newest-first", () => {
    const days = [day("2026-06-01", ["a"]), day("2026-06-03", ["b"]), day(FRI, ["c"])];
    const out = foldWeekends(days, "weekly");
    expect(out.map((d) => d.date)).toEqual([FRI, "2026-06-03", "2026-06-01"]);
  });

  it("does not mutate the input", () => {
    const days = [day(FRI, ["a"]), day("2026-06-06", ["sat"])];
    foldWeekends(days, "weekly");
    expect(days[0]!.items).toHaveLength(1); // Friday untouched
    expect(days[1]!.date).toBe("2026-06-06"); // Saturday still present in input
  });
});

describe("renderReportMarkdown", () => {
  const run: ReportRun = {
    runId: "r1",
    range: "daily",
    anchorDate: FRI,
    generatedAt: 0,
    days: [
      {
        date: FRI,
        items: [
          { id: "1", ref: "#290", title: "mid-edit network-error dialog reuse", category: "bug-fix", source: "pr" },
          { id: "2", ref: "#282", title: "npm audit fix (deps security)", category: "deps", source: "pr" },
          { id: "3", title: "Integration merges of the mk daily chain into development", category: "merge", source: "git" },
        ],
      },
    ],
  };

  it("renders the clean flat format the user asked for", () => {
    const md = renderReportMarkdown(run);
    expect(md).toContain("# Report — June 05 2026");
    expect(md).toContain("## June 05 2026");
    expect(md).toContain("- #290 — mid-edit network-error dialog reuse");
    expect(md).toContain("- #282 — npm audit fix (deps security)");
    // Ref-less items render without the "— " separator dangling.
    expect(md).toContain("- Integration merges of the mk daily chain into development");
    expect(md).not.toContain("undefined");
  });

  it("stays flat for a single-project run (no project subheads)", () => {
    const md = renderReportMarkdown(run);
    expect(md).not.toContain("###");
  });

  it("tags each line with its project when the run spans multiple projects", () => {
    const multi: ReportRun = {
      runId: "r2",
      range: "daily",
      anchorDate: FRI,
      generatedAt: 0,
      days: [
        {
          date: FRI,
          items: [
            { id: "1", ref: "#290", title: "claim fix", category: "bug-fix", source: "pr", project: "insclix-claim-forms" },
            { id: "2", ref: "#12", title: "awp polish", category: "polish", source: "pr", project: "insclix-awp-2.0" },
            { id: "3", title: "merge bumps", category: "merge", source: "git", project: "insclix-awp-2.0" },
          ],
        },
      ],
    };
    const md = renderReportMarkdown(multi);
    expect(md).toContain("## June 05 2026");
    expect(md).not.toContain("###"); // inline tags, not sub-sections
    expect(md).toContain("- [insclix-claim-forms] #290 — claim fix");
    expect(md).toContain("- [insclix-awp-2.0] #12 — awp polish");
    expect(md).toContain("- [insclix-awp-2.0] merge bumps"); // ref-less, still tagged
  });
});

describe("parseReportPayload", () => {
  const ctx = { runId: "r1", range: "weekly" as const, anchorDate: FRI, generatedAt: 123 };

  it("parses a well-formed payload", () => {
    const run = parseReportPayload(
      {
        type: "report",
        days: [
          {
            date: "2026-06-05",
            items: [{ ref: "#290", title: "fix dialog", category: "bug-fix", source: "pr", url: "http://x/290" }],
          },
        ],
      },
      ctx,
    );
    expect(run).not.toBeNull();
    expect(run!.days[0]!.items[0]!.ref).toBe("#290");
    expect(run!.days[0]!.items[0]!.category).toBe("bug-fix");
    expect(run!.generatedAt).toBe(123);
    expect(run!.range).toBe("weekly");
  });

  it("coerces an unknown category/source to defaults", () => {
    const run = parseReportPayload(
      { days: [{ date: "2026-06-05", items: [{ title: "x", category: "bogus", source: "nope" }] }] },
      ctx,
    );
    expect(run!.days[0]!.items[0]!.category).toBe("chore");
    expect(run!.days[0]!.items[0]!.source).toBe("git");
  });

  it("keeps a project tag when present and trims it", () => {
    const run = parseReportPayload(
      { days: [{ date: "2026-06-05", items: [{ title: "x", project: "  insclix-awp-2.0 " }] }] },
      ctx,
    );
    expect(run!.days[0]!.items[0]!.project).toBe("insclix-awp-2.0");
  });

  it("drops items with neither title nor ref, and malformed days", () => {
    const run = parseReportPayload(
      {
        days: [
          { date: "bad-date", items: [{ title: "x" }] },
          { date: "2026-06-05", items: [{ detail: "no title or ref" }, { ref: "#1", title: "" }] },
        ],
      },
      ctx,
    );
    expect(run!.days).toHaveLength(1);
    expect(run!.days[0]!.items).toHaveLength(1); // only the #1 item survives
    expect(run!.days[0]!.items[0]!.ref).toBe("#1");
  });

  it("returns null when there's no usable days array", () => {
    expect(parseReportPayload({ type: "report" }, ctx)).toBeNull();
    expect(parseReportPayload({ days: [] }, ctx)).toBeNull();
    expect(parseReportPayload("nope", ctx)).toBeNull();
    expect(parseReportPayload(null, ctx)).toBeNull();
  });
});
