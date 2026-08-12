import { describe, it, expect } from "vitest";
import { diffSeen, parseItems } from "./watcher.js";

describe("diffSeen", () => {
  it("treats everything as fresh against an empty seen list", () => {
    const { fresh, nextSeen } = diffSeen(["1", "2", "3"], []);
    expect(fresh).toEqual(["1", "2", "3"]);
    expect(nextSeen).toEqual(["1", "2", "3"]);
  });

  it("returns only ids not previously seen", () => {
    const { fresh } = diffSeen(["1", "2", "3"], ["1", "2"]);
    expect(fresh).toEqual(["3"]);
  });

  it("returns no fresh ids when all are already seen", () => {
    const { fresh } = diffSeen(["1", "2"], ["2", "1", "0"]);
    expect(fresh).toEqual([]);
  });

  it("puts fresh ids first and dedups the merged seen list", () => {
    const { nextSeen } = diffSeen(["3", "1"], ["1", "2"]);
    expect(nextSeen).toEqual(["3", "1", "2"]);
  });

  it("caps the seen list so it can't grow unbounded", () => {
    const seen = Array.from({ length: 10 }, (_, i) => `old-${i}`);
    const { nextSeen } = diffSeen(["new"], seen, 5);
    expect(nextSeen).toHaveLength(5);
    expect(nextSeen[0]).toBe("new"); // fresh id kept
  });
});

describe("parseItems", () => {
  it("reads a bare JSON array with default id/title paths", () => {
    const out = parseItems(
      JSON.stringify([
        { id: "7", title: "Fix login" },
        { id: "8", title: "Add export" },
      ]),
      {},
    );
    expect(out).toEqual([
      { id: "7", title: "Fix login" },
      { id: "8", title: "Add export" },
    ]);
  });

  it("honors custom idPath / labelPath (e.g. GitLab iid)", () => {
    const out = parseItems(
      JSON.stringify([{ iid: 42, title: "Claimant title dropdown" }]),
      { idPath: "iid", labelPath: "title" },
    );
    expect(out).toEqual([{ id: "42", title: "Claimant title dropdown" }]);
  });

  it("unwraps a { items: [...] } envelope", () => {
    const out = parseItems(JSON.stringify({ items: [{ id: "1", title: "A" }] }), {});
    expect(out).toEqual([{ id: "1", title: "A" }]);
  });

  it("skips entries with no id and falls back to id for a missing title", () => {
    const out = parseItems(
      JSON.stringify([{ id: "1" }, { title: "no id here" }]),
      {},
    );
    expect(out).toEqual([{ id: "1", title: "1" }]);
  });
});
