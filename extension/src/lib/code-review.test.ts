// Unit tests for the Code Review pure helpers (Phase 23) — the parsers
// are the version-skew defense, the scoring functions drive the deck's
// gamification verbatim.

import { describe, expect, it } from "vitest";
import {
  CARD_DIFF_MAX,
  clampDiff,
  DIFF_TRUNCATED_MARKER,
  gradeFor,
  MAX_REVIEW_CARDS,
  nextStreak,
  normalizeTopic,
  parseFixResult,
  parseLearnReply,
  parseReviewRun,
  scoreRun,
  splitDiffLines,
  TITLE_MAX,
  type ReviewCard,
  type ReviewVerdict,
} from "./code-review.js";

const RUN_ID = "run-1";

function card(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    id: "c1",
    title: "T",
    description: "",
    file: "src/a.ts",
    diff: "+x",
    ...overrides,
  };
}

describe("parseReviewRun", () => {
  const good = JSON.stringify({
    type: "code-review-run",
    runId: RUN_ID,
    source: "working-tree",
    cards: [
      { id: "c1", title: "Debounce search", description: "Adds a debounce.", file: "src/s.ts", diff: "@@ -1 +1 @@\n-a\n+b", risk: "low" },
    ],
    dropped: 2,
  });

  it("parses a well-formed run", () => {
    const run = parseReviewRun(good, RUN_ID);
    expect(run?.cards).toHaveLength(1);
    expect(run?.source).toBe("working-tree");
    expect(run?.dropped).toBe(2);
    expect(run?.cards[0].risk).toBe("low");
  });

  it("accepts type aliases + duck-typed payloads + field aliases", () => {
    const aliased = JSON.stringify({
      items: [{ label: "L", desc: "d", path: "src/x.ts", patch: "+y", severity: "HIGH" }],
    });
    const run = parseReviewRun(aliased, RUN_ID);
    expect(run?.cards[0].title).toBe("L");
    expect(run?.cards[0].description).toBe("d");
    expect(run?.cards[0].file).toBe("src/x.ts");
    expect(run?.cards[0].diff).toBe("+y");
    expect(run?.cards[0].risk).toBe("high");
  });

  it("rejects a mismatched runId, accepts a missing one", () => {
    expect(
      parseReviewRun(
        JSON.stringify({ type: "code-review-run", runId: "other", cards: [{ file: "f", diff: "+1" }] }),
        RUN_ID,
      ),
    ).toBeNull();
    const noId = parseReviewRun(
      JSON.stringify({ type: "code-review-run", cards: [{ file: "f", diff: "+1" }] }),
      RUN_ID,
    );
    expect(noId?.runId).toBe(RUN_ID);
  });

  it("drops cards without diff or file, fills ids/titles", () => {
    const run = parseReviewRun(
      JSON.stringify({
        cards: [{ file: "f.ts", diff: "+1" }, { title: "no diff" }, { diff: "+2" }],
      }),
      RUN_ID,
    );
    expect(run?.cards).toHaveLength(1);
    expect(run?.cards[0].id).toBe("card-1");
    expect(run?.cards[0].title).toBe("Change 1");
  });

  it("caps cards, truncates diffs and titles", () => {
    const run = parseReviewRun(
      JSON.stringify({
        cards: Array.from({ length: 30 }, (_, i) => ({
          file: `f${i}.ts`,
          diff: "x".repeat(CARD_DIFF_MAX + 10),
          title: "t".repeat(TITLE_MAX + 10),
        })),
      }),
      RUN_ID,
    );
    expect(run?.cards).toHaveLength(MAX_REVIEW_CARDS);
    expect(run?.cards[0].diff.endsWith(DIFF_TRUNCATED_MARKER)).toBe(true);
    expect(run?.cards[0].title).toHaveLength(TITLE_MAX);
  });

  it("returns null for garbage / empty / wrong shapes", () => {
    expect(parseReviewRun("not json", RUN_ID)).toBeNull();
    expect(parseReviewRun("{}", RUN_ID)).toBeNull();
    expect(parseReviewRun(JSON.stringify({ type: "other" }), RUN_ID)).toBeNull();
    expect(parseReviewRun(JSON.stringify({ cards: [] }), RUN_ID)).toBeNull();
  });

  it("parses topic-mode runs and echoes the topic", () => {
    const run = parseReviewRun(
      JSON.stringify({
        type: "code-review-run",
        source: "topic",
        topic: "MFA authentication",
        cards: [{ file: "src/auth/mfa.ts", diff: "@@ src/auth/mfa.ts:12 @@\nfunction verifyTotp() {" }],
      }),
      RUN_ID,
    );
    expect(run?.source).toBe("topic");
    expect(run?.topic).toBe("MFA authentication");
  });
});

describe("normalizeTopic", () => {
  it("collapses whitespace, trims, and caps", () => {
    expect(normalizeTopic("  MFA   auth \n flow ")).toBe("MFA auth flow");
    expect(normalizeTopic("x".repeat(500)).length).toBe(120);
    expect(normalizeTopic("   ")).toBe("");
  });
});

describe("clampDiff", () => {
  it("leaves short diffs alone, truncates long ones with the marker", () => {
    expect(clampDiff("+a")).toBe("+a");
    const clamped = clampDiff("y".repeat(CARD_DIFF_MAX * 2));
    expect(clamped.length).toBe(CARD_DIFF_MAX + DIFF_TRUNCATED_MARKER.length);
  });
});

describe("parseLearnReply", () => {
  it("parses the envelope and its aliases", () => {
    expect(parseLearnReply(JSON.stringify({ type: "code-review-learn", reply: "hi" }))).toBe("hi");
    expect(parseLearnReply(JSON.stringify({ answer: "a" }))).toBe("a");
    expect(parseLearnReply(JSON.stringify({ message: "m" }))).toBe("m");
  });

  it("accepts bare markdown, rejects wrong-typed envelopes and empties", () => {
    expect(parseLearnReply("Just some **markdown**.")).toBe("Just some **markdown**.");
    expect(parseLearnReply(JSON.stringify({ type: "audit-run", reply: "x" }))).toBeNull();
    expect(parseLearnReply("")).toBeNull();
  });
});

describe("parseFixResult", () => {
  it("parses fixed payloads incl. file aliases", () => {
    const out = parseFixResult(
      JSON.stringify({
        type: "code-review-fixed",
        cardId: "c1",
        summary: "done",
        changedFiles: [{ path: "src/a.ts", note: "n" }, { bad: 1 }],
      }),
    );
    expect(out?.cardId).toBe("c1");
    expect(out?.files).toEqual([{ path: "src/a.ts", note: "n" }]);
  });

  it("duck-types on summary, rejects garbage", () => {
    expect(parseFixResult(JSON.stringify({ summary: "s" }))?.summary).toBe("s");
    expect(parseFixResult("nope")).toBeNull();
    expect(parseFixResult("{}")).toBeNull();
  });
});

describe("scoreRun / gradeFor / nextStreak", () => {
  const cards = [card({ id: "a" }), card({ id: "b" }), card({ id: "c" })];

  it("scores over reviewed cards only", () => {
    const verdicts: Record<string, ReviewVerdict> = { a: "pass", b: "fail" };
    expect(scoreRun(cards, verdicts)).toEqual({
      passed: 1,
      failed: 1,
      reviewed: 2,
      total: 3,
      pct: 50,
    });
    expect(scoreRun(cards, {}).pct).toBe(0);
  });

  it("grade boundaries", () => {
    expect(gradeFor(100)).toBe("S");
    expect(gradeFor(99)).toBe("A");
    expect(gradeFor(90)).toBe("A");
    expect(gradeFor(89)).toBe("B");
    expect(gradeFor(75)).toBe("B");
    expect(gradeFor(74)).toBe("C");
    expect(gradeFor(60)).toBe("C");
    expect(gradeFor(59)).toBe("D");
  });

  it("streak resets on fail", () => {
    expect(nextStreak(0, "pass")).toBe(1);
    expect(nextStreak(4, "pass")).toBe(5);
    expect(nextStreak(7, "fail")).toBe(0);
  });
});

describe("splitDiffLines", () => {
  it("classifies hunks, adds, dels, context, and file headers", () => {
    const lines = splitDiffLines(
      "--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new",
    );
    expect(lines.map((l) => l.kind)).toEqual([
      "ctx",
      "ctx",
      "hunk",
      "ctx",
      "del",
      "add",
    ]);
  });

  it("handles CRLF", () => {
    const lines = splitDiffLines("+a\r\n-b\r");
    expect(lines[0]).toEqual({ kind: "add", text: "+a" });
    expect(lines[1]).toEqual({ kind: "del", text: "-b" });
  });
});
