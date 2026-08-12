import { describe, it, expect } from "vitest";
import {
  filterUntoasted,
  appendToasted,
  mergePending,
  mergePorts,
  toastBody,
  badgeText,
  moduleWantsToast,
} from "./watch-notify.js";

describe("filterUntoasted", () => {
  it("keeps only items whose id is not in the toasted set", () => {
    const items = [{ id: "1" }, { id: "2" }, { id: "3" }];
    expect(filterUntoasted(items, ["2"])).toEqual([{ id: "1" }, { id: "3" }]);
  });

  it("passes everything through when nothing was toasted", () => {
    expect(filterUntoasted([{ id: "a" }], [])).toEqual([{ id: "a" }]);
  });
});

describe("appendToasted", () => {
  it("appends new ids and skips duplicates", () => {
    expect(appendToasted(["1"], ["2", "1", "3"])).toEqual(["1", "2", "3"]);
  });

  it("caps from the front so the oldest ids age out", () => {
    expect(appendToasted(["a", "b", "c"], ["d", "e"], 4)).toEqual([
      "b",
      "c",
      "d",
      "e",
    ]);
  });
});

describe("mergePending", () => {
  it("starts fresh from null", () => {
    const p = mergePending(null, "m", [{ id: "1", title: "A" }]);
    expect(p).toEqual({ moduleId: "m", items: [{ id: "1", title: "A" }] });
  });

  it("accumulates + dedupes for the same module", () => {
    const p0 = { moduleId: "m", items: [{ id: "1", title: "A" }] };
    const p1 = mergePending(p0, "m", [
      { id: "1", title: "A" },
      { id: "2", title: "B" },
    ]);
    expect(p1.items.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("replaces the pending set when the module changes", () => {
    const p0 = { moduleId: "m", items: [{ id: "1", title: "A" }] };
    const p1 = mergePending(p0, "other", [{ id: "9", title: "Z" }]);
    expect(p1).toEqual({ moduleId: "other", items: [{ id: "9", title: "Z" }] });
  });
});

describe("mergePorts", () => {
  it("puts the newest port first and dedupes", () => {
    expect(mergePorts([7878, 7880], 7880)).toEqual([7880, 7878]);
  });

  it("caps the list", () => {
    expect(mergePorts([1, 2, 3, 4, 5], 6, 5)).toEqual([6, 1, 2, 3, 4]);
  });
});

describe("toastBody / badgeText", () => {
  it("renders up to four lines then an ellipsis", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
      title: `T${i}`,
    }));
    const body = toastBody(items);
    expect(body.split("\n")).toHaveLength(5);
    expect(body.endsWith("…")).toBe(true);
  });

  it("badge text clamps at 99+ and clears at zero", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(7)).toBe("7");
    expect(badgeText(120)).toBe("99+");
  });
});

describe("moduleWantsToast", () => {
  it("requires the module to be enabled", () => {
    expect(moduleWantsToast({}, "m")).toBe(false);
    expect(moduleWantsToast({ m: { enabled: false } }, "m")).toBe(false);
    expect(moduleWantsToast({ m: { enabled: true } }, "m")).toBe(true);
  });

  it("mutes only on an explicit false setting", () => {
    expect(
      moduleWantsToast(
        { m: { enabled: true, settings: { watchNotifications: false } } },
        "m",
      ),
    ).toBe(false);
    expect(
      moduleWantsToast(
        { m: { enabled: true, settings: { watchNotifications: true } } },
        "m",
      ),
    ).toBe(true);
    expect(
      moduleWantsToast({ m: { enabled: true, settings: {} } }, "m"),
    ).toBe(true);
  });
});
