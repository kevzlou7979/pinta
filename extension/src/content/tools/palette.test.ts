import { describe, it, expect } from "vitest";
import { normalizeColor, rankColors } from "./palette.js";

describe("normalizeColor", () => {
  it("converts rgb() to uppercase hex", () => {
    expect(normalizeColor("rgb(16, 42, 87)")).toBe("#102A57");
  });

  it("converts rgba() with opaque alpha", () => {
    expect(normalizeColor("rgba(255, 61, 110, 1)")).toBe("#FF3D6E");
  });

  it("supports the space/slash rgb syntax", () => {
    expect(normalizeColor("rgb(16 42 87 / 0.8)")).toBe("#102A57");
  });

  it("drops fully transparent colors", () => {
    expect(normalizeColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(normalizeColor("transparent")).toBeNull();
  });

  it("drops near-invisible alpha (scrim layers)", () => {
    expect(normalizeColor("rgba(0, 0, 0, 0.05)")).toBeNull();
  });

  it("keeps a translucent-but-visible color, dropping alpha", () => {
    expect(normalizeColor("rgba(16, 42, 87, 0.5)")).toBe("#102A57");
  });

  it("accepts percentage alpha", () => {
    expect(normalizeColor("rgb(16 42 87 / 90%)")).toBe("#102A57");
    expect(normalizeColor("rgb(16 42 87 / 2%)")).toBeNull();
  });

  it("normalizes 3- and 6-digit hex", () => {
    expect(normalizeColor("#abc")).toBe("#AABBCC");
    expect(normalizeColor("#A1B2C3")).toBe("#A1B2C3");
  });

  it("clamps and rounds out-of-range channels", () => {
    expect(normalizeColor("rgb(300, -5, 12.6)")).toBe("#FF000D");
  });

  it("returns null for junk / unsupported keywords", () => {
    expect(normalizeColor("")).toBeNull();
    expect(normalizeColor("none")).toBeNull();
    expect(normalizeColor("currentcolor")).toBeNull();
    expect(normalizeColor("not-a-color")).toBeNull();
  });
});

describe("rankColors", () => {
  it("counts and orders most-used first", () => {
    const out = rankColors([
      "rgb(0, 0, 0)",
      "rgb(255, 255, 255)",
      "rgb(0, 0, 0)",
      "rgb(0, 0, 0)",
      "rgb(255, 255, 255)",
    ]);
    expect(out).toEqual([
      { color: "#000000", count: 3 },
      { color: "#FFFFFF", count: 2 },
    ]);
  });

  it("skips unusable colors", () => {
    const out = rankColors(["transparent", "rgba(0,0,0,0)", "rgb(1, 2, 3)"]);
    expect(out).toEqual([{ color: "#010203", count: 1 }]);
  });

  it("dedupes across equivalent notations", () => {
    const out = rankColors(["#fff", "rgb(255, 255, 255)", "rgba(255,255,255,1)"]);
    expect(out).toEqual([{ color: "#FFFFFF", count: 3 }]);
  });

  it("keeps first-seen order for ties", () => {
    const out = rankColors(["rgb(1,1,1)", "rgb(2,2,2)"]);
    expect(out.map((s) => s.color)).toEqual(["#010101", "#020202"]);
  });

  it("honors the limit", () => {
    const samples = Array.from({ length: 40 }, (_, i) => `rgb(${i}, 0, 0)`);
    expect(rankColors(samples, 5)).toHaveLength(5);
  });

  it("returns empty for no usable samples", () => {
    expect(rankColors(["transparent", "none"])).toEqual([]);
  });
});
