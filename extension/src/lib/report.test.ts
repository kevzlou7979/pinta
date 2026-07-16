import { describe, expect, it } from "vitest";
import {
  addDays,
  categoryLabel,
  foldWeekends,
  formatDayHeading,
  formatFileSummary,
  humanizeReportTitle,
  isAnnotateRollup,
  isoDateLocal,
  isWeekend,
  reportItemDisplayTitle,
  looksLikeModuleSummary,
  mergeAnnotationChildren,
  mergeCustomItems,
  oneLineComment,
  pagePathFromUrl,
  mergeReportDays,
  parseHowToTestResult,
  parseReportPayload,
  parseShotResult,
  rangeWindow,
  renderReportMarkdown,
  shotKeyForItem,
  type ReportCustomItem,
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

describe("per-entry screenshot (Phase 16f)", () => {
  it("derives a filesystem-safe, deterministic shot key", () => {
    const k = shotKeyForItem("audit-flow-custom:abc/123");
    // No path separators, colons, or other unsafe chars.
    expect(k).toMatch(/^[a-z0-9-]+$/);
    expect(k).not.toContain(":");
    expect(k).not.toContain("/");
    // Same input → same key (re-capture overwrites the same file).
    expect(shotKeyForItem("audit-flow-custom:abc/123")).toBe(k);
  });

  it("gives distinct keys to distinct ids that slug the same", () => {
    // "a/b" and "a:b" both slug to "a-b" — the hash suffix disambiguates.
    expect(shotKeyForItem("a/b")).not.toBe(shotKeyForItem("a:b"));
  });

  it("handles an id with no alphanumerics", () => {
    const k = shotKeyForItem("///");
    expect(k.startsWith("entry-")).toBe(true);
  });

  it("parses a successful shot result", () => {
    const r = parseShotResult({
      op: "report-screenshot",
      itemId: "290",
      shotKey: "x290-abc",
      ok: true,
      note: "the submit button, now red",
    });
    expect(r).toEqual({
      itemId: "290",
      shotKey: "x290-abc",
      ok: true,
      note: "the submit button, now red",
    });
  });

  it("parses a failed shot result with a reason", () => {
    const r = parseShotResult({
      itemId: "290",
      shotKey: "x290-abc",
      ok: false,
      reason: "could not reach http://localhost:5173",
    });
    expect(r?.ok).toBe(false);
    expect(r?.reason).toContain("could not reach");
  });

  it("rejects unrecognizable payloads", () => {
    expect(parseShotResult(null)).toBeNull();
    expect(parseShotResult({})).toBeNull();
    expect(parseShotResult({ itemId: "290" })).toBeNull(); // no shotKey
    expect(parseShotResult({ shotKey: "x" })).toBeNull(); // no itemId
  });

  it("treats a missing/non-true ok as failure", () => {
    expect(parseShotResult({ itemId: "1", shotKey: "k" })?.ok).toBe(false);
    expect(
      parseShotResult({ itemId: "1", shotKey: "k", ok: "yes" })?.ok,
    ).toBe(false);
  });
});

describe("how-to-test (Phase 16g)", () => {
  it("parses a steps payload, trimming + dropping empties", () => {
    const r = parseHowToTestResult({
      op: "report-how-to-test",
      itemId: "290",
      steps: ["  Open /checkout  ", "", "   ", "Click Submit"],
    });
    expect(r).toEqual({ itemId: "290", steps: ["Open /checkout", "Click Submit"] });
  });

  it("caps the step count", () => {
    const many = Array.from({ length: 30 }, (_, i) => `step ${i}`);
    const r = parseHowToTestResult({ itemId: "x", steps: many });
    expect(r?.steps).toHaveLength(20);
  });

  it("rejects unusable payloads", () => {
    expect(parseHowToTestResult(null)).toBeNull();
    expect(parseHowToTestResult({})).toBeNull(); // no itemId
    expect(parseHowToTestResult({ itemId: "x" })).toBeNull(); // no steps
    expect(parseHowToTestResult({ itemId: "x", steps: [] })).toBeNull();
    expect(parseHowToTestResult({ itemId: "x", steps: ["", "  "] })).toBeNull();
    expect(parseHowToTestResult({ steps: ["a"] })).toBeNull(); // no itemId
  });
});

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

  it("custom range is a passthrough (exact picked days, no fold)", () => {
    const days = [day(FRI, ["a"]), day("2026-06-06", ["sat"])]; // incl. a Saturday
    const out = foldWeekends(days, "custom");
    expect(out.map((d) => d.date)).toEqual(["2026-06-06", FRI]); // both kept, newest-first
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

  it("coalesces a folded weekend annotate roll-up into the weekday's one", () => {
    const annotate = (id: string, kids: string[]): ReportItem => ({
      id,
      title: `${kids.length} Pinta annotations`,
      category: "annotate",
      source: "pinta-annotate",
      children: kids.map((t) => ({ title: t })),
    });
    const days: ReportDay[] = [
      { date: FRI, items: [{ id: "c", title: "commit", category: "chore", source: "git" }, annotate("fri", ["a"])] },
      { date: "2026-06-06", items: [annotate("sat", ["b"])] }, // Saturday
    ];
    const out = foldWeekends(days, "weekly");
    const fri = out.find((d) => d.date === FRI)!;
    const rollups = fri.items.filter(
      (i) => i.source === "pinta-annotate" || i.category === "annotate",
    );
    expect(rollups).toHaveLength(1); // ONE roll-up, not two
    expect(rollups[0]!.children?.map((c) => c.title)).toEqual(["a", "b"]);
    expect(fri.items.some((i) => i.id === "c")).toBe(true); // commit still there
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
    expect(md).toContain("- #290 — Mid-edit Network-error Dialog Reuse");
    expect(md).toContain("- #282 — Npm Audit Fix (Deps Security)");
    // Ref-less items render without the "— " separator dangling.
    expect(md).toContain("- Integration Merges of the Mk Daily Chain into Development");
    expect(md).not.toContain("undefined");
  });

  it("stays flat for a single-project run (no project subheads)", () => {
    const md = renderReportMarkdown(run);
    expect(md).not.toContain("###");
  });

  it("drops commit short-shas but keeps PR/issue refs", () => {
    const mixed: ReportRun = {
      runId: "r9",
      range: "daily",
      anchorDate: FRI,
      generatedAt: 0,
      days: [
        {
          date: FRI,
          items: [
            { id: "1", ref: "45b1be1", title: "pinta ui polish", category: "chore", source: "git" },
            { id: "2", ref: "#357", title: "restore locale strings", category: "chore", source: "pr" },
            { id: "3", ref: "!57", title: "camera fix", category: "bug-fix", source: "issue" },
          ],
        },
      ],
    };
    const md = renderReportMarkdown(mixed);
    expect(md).toContain("- Pinta Ui Polish"); // sha gone
    expect(md).not.toContain("45b1be1");
    expect(md).toContain("- #357 — Restore Locale Strings"); // PR kept
    expect(md).toContain("- !57 — Camera Fix"); // issue kept
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
    expect(md).toContain("- [insclix-claim-forms] #290 — Claim Fix");
    expect(md).toContain("- [insclix-awp-2.0] #12 — Awp Polish");
    expect(md).toContain("- [insclix-awp-2.0] Merge Bumps"); // ref-less, still tagged
  });

  it("labels the title from since/until for a custom range", () => {
    const custom: ReportRun = {
      runId: "r3",
      range: "custom",
      anchorDate: "2026-06-10",
      since: "2026-06-01",
      until: "2026-06-10",
      generatedAt: 0,
      days: [
        { date: "2026-06-06", items: [{ id: "1", title: "sat work", category: "chore", source: "git" }] },
      ],
    };
    const md = renderReportMarkdown(custom);
    expect(md).toContain("# Report — June 01–10 2026");
    expect(md).toContain("## June 06 2026"); // custom = no fold; Saturday shown as-is
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

describe("humanizeReportTitle", () => {
  it("title-cases a plain subject, keeping small words lowercase", () => {
    expect(humanizeReportTitle("fixed the login dialog overlay")).toBe(
      "Fixed the Login Dialog Overlay",
    );
    expect(humanizeReportTitle("")).toBe("");
  });

  it("preserves refs, acronyms, hex, and versions through Title Case", () => {
    expect(humanizeReportTitle("refresh i18n + signature smoothing")).toBe(
      "Refresh i18n + Signature Smoothing",
    );
    expect(humanizeReportTitle("aggregated PDF per type in Send Documents")).toBe(
      "Aggregated PDF per Type in Send Documents",
    );
    expect(humanizeReportTitle("#348 default brand logo on login")).toBe(
      "#348 Default Brand Logo on Login",
    );
  });

  it("summarizes an audit-flow-run JSON blob", () => {
    const raw = JSON.stringify({
      type: "audit-flow-run",
      runId: "7c8dc9c9",
      overall: 67,
      rating: "Needs work",
      categories: [{ id: "mobile" }],
    });
    expect(humanizeReportTitle(raw)).toBe(
      "Ran an AuditFlow audit — scored 67/100 · Needs work",
    );
  });

  it("summarizes a test-pilot-catalog JSON blob with a test count", () => {
    const raw = JSON.stringify({
      type: "test-pilot-catalog",
      docId: "fb49bee4",
      filename: "generated-tests.md",
      sections: [{ tests: [1, 2] }, { tests: [3] }],
    });
    expect(humanizeReportTitle(raw)).toBe(
      "Generated a Test Pilot catalog from generated-tests.md — 3 tests",
    );
  });

  it("falls back to a title-cased type for unknown module results", () => {
    expect(humanizeReportTitle('{"type":"chat-reply","reply":"hi"}')).toBe(
      "Chat reply",
    );
  });

  it("strips the `bump … gitlink --` daily-merge prefix", () => {
    expect(
      humanizeReportTitle(
        "chore(claims): bump svelte gitlink -- #369 round icon badges across authenticated flow",
      ),
    ).toBe("#369 Round Icon Badges Across Authenticated Flow");
  });

  it("handles a #ref before the bump and unwraps the parenthetical message", () => {
    expect(
      humanizeReportTitle(
        "chore(claims): #368 bump svelte gitlink (app primary -> brand navy #00447c)",
      ),
    ).toBe("#368 App Primary → Brand Navy #00447c");
    expect(
      humanizeReportTitle(
        "chore(claims): #380 bump svelte gitlink (aggregated PDF per type in Send Documents progress)",
      ),
    ).toBe("#380 Aggregated PDF per Type in Send Documents Progress");
  });

  it("keeps a trailing clause when the message is not wholly parenthesised", () => {
    expect(
      humanizeReportTitle(
        "chore(claims): bump svelte gitlink (DTO/locale sync) + dev seed",
      ),
    ).toBe("(DTO/locale Sync) + Dev Seed");
  });

  it("strips a non-gitlink conventional prefix and prettifies ` -- `", () => {
    expect(
      humanizeReportTitle(
        "fix(claims): email brand colors -- #00447c navy headers, #2563eb accents/CTA",
      ),
    ).toBe("Email Brand Colors — #00447c Navy Headers, #2563eb accents/CTA");
    expect(humanizeReportTitle("chore(deps): bump axios to 1.7.2")).toBe(
      "Bump Axios to 1.7.2",
    );
  });

  it("keeps the original subject when a bare bump leaves nothing", () => {
    expect(humanizeReportTitle("chore(claims): bump svelte gitlink")).toBe(
      "chore(claims): bump svelte gitlink",
    );
  });

  it("does not strip a colon prefix from a hand-typed manual entry", () => {
    expect(humanizeReportTitle("Met John: onboarding notes")).toBe(
      "Met John: Onboarding Notes",
    );
  });

  it("never leaks raw braces for a truncated JSON blob", () => {
    // A blob cut off mid-object (JSON.parse fails) still resolves to a
    // friendly line via the `type` marker — never the raw braces.
    const truncated = '{"type":"audit-flow-run","overall":89,"rating":"Good","categ';
    expect(humanizeReportTitle(truncated)).toBe("Ran an AuditFlow audit");
    expect(humanizeReportTitle(truncated).startsWith("{")).toBe(false);
  });
});

describe("mergeCustomItems", () => {
  const custom = (date: string, title: string, id = `${date}:${title}`): ReportCustomItem => ({
    id,
    date,
    title,
    category: "feature",
  });

  it("appends a custom item to an existing day bucket, flagged userAdded", () => {
    const out = mergeCustomItems([day(FRI, ["agent task"])], [custom(FRI, "manual task")]);
    const fri = out.find((d) => d.date === FRI)!;
    expect(fri.items.map((i) => i.title)).toEqual(["agent task", "manual task"]);
    const manual = fri.items.find((i) => i.title === "manual task")!;
    expect(manual.userAdded).toBe(true);
    expect(manual.source).toBe("manual");
  });

  it("creates a new day bucket when none exists for the custom item's date", () => {
    const out = mergeCustomItems([], [custom("2026-06-03", "lonely entry")]);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("2026-06-03");
    expect(out[0].items[0].title).toBe("lonely entry");
  });

  it("hides (does not lose) items outside the window", () => {
    const items = [custom("2026-06-02", "in"), custom("2026-06-20", "out")];
    const out = mergeCustomItems([], items, { since: "2026-06-01", until: "2026-06-05" });
    const titles = out.flatMap((d) => d.items.map((i) => i.title));
    expect(titles).toEqual(["in"]);
    // The same cache with a wider window surfaces the previously hidden item.
    const wide = mergeCustomItems([], items, { since: "2026-06-01", until: "2026-06-30" });
    expect(wide.flatMap((d) => d.items.map((i) => i.title)).sort()).toEqual(["in", "out"]);
  });

  it("does not mutate the input days or drop agent items", () => {
    const base = [day(FRI, ["a", "b"])];
    const out = mergeCustomItems(base, [custom(FRI, "c")]);
    expect(base[0].items).toHaveLength(2); // untouched
    expect(out.find((d) => d.date === FRI)!.items).toHaveLength(3);
  });

  it("skips malformed dates", () => {
    const out = mergeCustomItems([], [custom("not-a-date", "x")]);
    expect(out).toHaveLength(0);
  });
});

describe("formatFileSummary", () => {
  const item = (files?: string[], fileCount?: number) => ({
    id: "x",
    title: "t",
    category: "polish" as const,
    source: "git" as const,
    ...(files ? { files } : {}),
    ...(fileCount !== undefined ? { fileCount } : {}),
  });

  it("returns null when there are no files", () => {
    expect(formatFileSummary(item())).toBeNull();
    expect(formatFileSummary(item([]))).toBeNull();
  });

  it("lists files with the right singular/plural noun", () => {
    expect(formatFileSummary(item(["a.ts"]))).toBe("1 file · a.ts");
    expect(formatFileSummary(item(["a.ts", "b.ts"]))).toBe("2 files · a.ts, b.ts");
  });

  it("caps the preview at 3 and adds a +N more suffix from fileCount", () => {
    const out = formatFileSummary(item(["a", "b", "c", "d"], 8));
    expect(out).toBe("8 files · a, b, c (+5 more)");
  });

  it("derives the extra count from the list when fileCount is absent", () => {
    expect(formatFileSummary(item(["a", "b", "c", "d", "e"]))).toBe(
      "5 files · a, b, c (+2 more)",
    );
  });

  it("ignores a fileCount that's not larger than the list", () => {
    expect(formatFileSummary(item(["a", "b"], 2))).toBe("2 files · a, b");
    expect(formatFileSummary(item(["a", "b"], 1))).toBe("2 files · a, b");
  });
});

describe("parseReportPayload — files/fileCount coercion", () => {
  it("stores a cleaned, capped files list (cards use it) but keeps it OUT of the plain export", () => {
    const run = parseReportPayload(
      {
        days: [
          {
            date: "2026-06-05",
            items: [
              {
                ref: "a1b2c3d",
                title: "tonalize button",
                category: "polish",
                source: "git",
                files: ["src/A.svelte", "", "  src/B.svelte ", 42, "C.css", "d", "e", "f", "g"],
                fileCount: 9,
              },
            ],
          },
        ],
      },
      { runId: "r", range: "daily", anchorDate: "2026-06-05", generatedAt: 0 },
    )!;
    const it = run.days[0].items[0];
    // non-strings dropped, trimmed, capped to 6 stored (the card still shows these)
    expect(it.files).toEqual(["src/A.svelte", "src/B.svelte", "C.css", "d", "e", "f"]);
    expect(it.fileCount).toBe(9);
    // …but the export is plain prose: no file paths, no commit short-sha.
    const md = renderReportMarkdown(run);
    expect(md).toContain("- Tonalize Button");
    expect(md).not.toContain("src/A.svelte");
    expect(md).not.toContain("files ·");
    expect(md).not.toContain("a1b2c3d");
  });

  it("omits files when none are valid", () => {
    const run = parseReportPayload(
      {
        days: [
          { date: "2026-06-05", items: [{ title: "x", category: "chore", source: "git", files: [1, 2] }] },
        ],
      },
      { runId: "r", range: "daily", anchorDate: "2026-06-05", generatedAt: 0 },
    )!;
    expect(run.days[0].items[0].files).toBeUndefined();
  });
});

describe("roll-up children (Pinta annotations)", () => {
  it("coerces children from string and object shapes, dropping empties", () => {
    const run = parseReportPayload(
      {
        days: [
          {
            date: "2026-06-05",
            items: [
              {
                id: "annot-1",
                title: "3 Pinta annotations",
                category: "annotate",
                source: "pinta-annotate",
                children: [
                  "make the submit button navy",
                  { title: "  tighten card spacing  ", ref: "/checkout", url: "http://x/y" },
                  { title: "" }, // dropped — no title
                  42, // dropped — not a child
                ],
              },
            ],
          },
        ],
      },
      { runId: "r", range: "daily", anchorDate: "2026-06-05", generatedAt: 0 },
    )!;
    const item = run.days[0].items[0];
    expect(item.children).toEqual([
      { title: "make the submit button navy" },
      { title: "tighten card spacing", ref: "/checkout", url: "http://x/y" },
    ]);
  });

  it("indents children as nested bullets in the markdown export", () => {
    const run = parseReportPayload(
      {
        days: [
          {
            date: "2026-06-05",
            items: [
              {
                id: "annot-1",
                title: "2 Pinta annotations",
                category: "annotate",
                source: "pinta-annotate",
                children: [
                  { title: "make the submit button navy" },
                  { title: "tighten card spacing", ref: "/checkout" },
                ],
              },
            ],
          },
        ],
      },
      { runId: "r", range: "daily", anchorDate: "2026-06-05", generatedAt: 0 },
    )!;
    const md = renderReportMarkdown(run);
    // Parent row uses the fixed roll-up label (not the raw "N Pinta
    // annotations" count); children are plain, Title-Cased, no page route.
    expect(md).toContain("- Fixes and Additional Features");
    expect(md).not.toContain("Pinta Annotations");
    expect(md).toContain("  - Make the Submit Button Navy");
    expect(md).toContain("  - Tighten Card Spacing");
    expect(md).not.toContain("/checkout");
  });

  it("omits children when none are valid", () => {
    const run = parseReportPayload(
      {
        days: [
          {
            date: "2026-06-05",
            items: [
              { title: "x", category: "annotate", source: "pinta-annotate", children: [1, {}, ""] },
            ],
          },
        ],
      },
      { runId: "r", range: "daily", anchorDate: "2026-06-05", generatedAt: 0 },
    )!;
    expect(run.days[0].items[0].children).toBeUndefined();
  });
});

describe("reportItemDisplayTitle (annotation roll-up rename)", () => {
  it("labels an annotate roll-up 'Fixes and Additional Features'", () => {
    const bySource = { id: "a", title: "14 Pinta annotations", category: "chore" as const, source: "pinta-annotate" as const };
    const byCategory = { id: "b", title: "7 Pinta annotation batches applied", category: "annotate" as const, source: "git" as const };
    expect(isAnnotateRollup(bySource)).toBe(true);
    expect(reportItemDisplayTitle(bySource)).toBe("Fixes and Additional Features");
    expect(reportItemDisplayTitle(byCategory)).toBe("Fixes and Additional Features");
  });

  it("humanizes a normal item's title unchanged", () => {
    const commit = { id: "c", title: "fix login dialog", category: "bug-fix" as const, source: "git" as const };
    expect(isAnnotateRollup(commit)).toBe(false);
    expect(reportItemDisplayTitle(commit)).toBe("Fix Login Dialog");
  });
});

describe("mergeAnnotationChildren (export fallback)", () => {
  const annotateDay = (date: string): ReportDay => ({
    date,
    items: [
      { id: "a", title: "fix", category: "chore", source: "git" },
      { id: "b", title: "5 Pinta annotations", category: "annotate", source: "pinta-annotate" },
    ],
  });

  it("attaches cached children to an annotate item that has none", () => {
    const out = mergeAnnotationChildren(
      [annotateDay("2026-06-22")],
      { "2026-06-22": [{ title: "make it navy" }, { title: "pad the card" }] },
    );
    expect(out[0].items[0].children).toBeUndefined(); // non-annotate untouched
    expect(out[0].items[1].children).toEqual([
      { title: "make it navy" },
      { title: "pad the card" },
    ]);
  });

  it("does not overwrite agent-provided children", () => {
    const day: ReportDay = {
      date: "2026-06-22",
      items: [
        { id: "b", title: "2 Pinta annotations", category: "annotate", source: "pinta-annotate", children: [{ title: "agent one" }] },
      ],
    };
    const out = mergeAnnotationChildren([day], {
      "2026-06-22": [{ title: "fallback one" }],
    });
    expect(out[0].items[0].children).toEqual([{ title: "agent one" }]);
  });

  it("is a no-op when the day has no cached children", () => {
    const day = annotateDay("2026-06-22");
    const out = mergeAnnotationChildren([day], {});
    expect(out[0]).toBe(day); // same identity — nothing changed
  });
});

describe("annotation-children fallback helpers", () => {
  it("derives a local ISO date from epoch ms (or null)", () => {
    const ms = new Date(2026, 5, 30, 14, 30).getTime(); // local June 30 2026
    expect(isoDateLocal(ms)).toBe("2026-06-30");
    expect(isoDateLocal(undefined)).toBeNull();
    expect(isoDateLocal(NaN)).toBeNull();
  });

  it("flags module-result summaries but not plain/absent ones", () => {
    expect(looksLikeModuleSummary('{"type":"audit-flow-run","overall":67}')).toBe(true);
    expect(looksLikeModuleSummary('{"type":"audit-flow-run","over')).toBe(true); // truncated
    expect(looksLikeModuleSummary("Applied 3 edits")).toBe(false);
    expect(looksLikeModuleSummary("{}")).toBe(false);
    expect(looksLikeModuleSummary(undefined)).toBe(false);
  });

  it("extracts a page path from a session url", () => {
    expect(pagePathFromUrl("http://localhost:5173/checkout")).toBe("/checkout");
    expect(pagePathFromUrl("http://localhost:5173/")).toBeUndefined();
    expect(pagePathFromUrl("not a url")).toBeUndefined();
    expect(pagePathFromUrl(undefined)).toBeUndefined();
  });

  it("normalizes a comment to one capped line", () => {
    expect(oneLineComment("  make it navy  \nsecond line")).toBe("make it navy");
    expect(oneLineComment("")).toBe("");
    const long = "x".repeat(200);
    const out = oneLineComment(long);
    expect(out.length).toBe(118); // 117 + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("mergeReportDays (per-day fetch more)", () => {
  const it_ = (id: string, title = id) => ({
    id,
    title,
    category: "chore" as const,
    source: "git" as const,
  });

  it("appends only new items to an existing day, deduping by id", () => {
    const existing = [{ date: FRI, items: [it_("a"), it_("b")] }];
    const incoming = [{ date: FRI, items: [it_("b"), it_("c"), it_("d")] }];
    const { days, added } = mergeReportDays(existing, incoming);
    expect(added).toBe(2);
    const fri = days.find((d) => d.date === FRI)!;
    expect(fri.items.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("creates a bucket for a date the run didn't have", () => {
    const existing = [{ date: FRI, items: [it_("a")] }];
    const incoming = [{ date: "2026-06-04", items: [it_("x")] }];
    const { days, added } = mergeReportDays(existing, incoming);
    expect(added).toBe(1);
    expect(days.find((d) => d.date === "2026-06-04")!.items.map((i) => i.id)).toEqual(["x"]);
  });

  it("reports zero added when everything is already present", () => {
    const existing = [{ date: FRI, items: [it_("a"), it_("b")] }];
    const { added } = mergeReportDays(existing, [{ date: FRI, items: [it_("a")] }]);
    expect(added).toBe(0);
  });

  it("does not mutate the inputs", () => {
    const existing = [{ date: FRI, items: [it_("a")] }];
    mergeReportDays(existing, [{ date: FRI, items: [it_("b")] }]);
    expect(existing[0]!.items).toHaveLength(1);
  });
});
