import { describe, expect, it } from "vitest";
import {
  DRAW_STYLE_DEFAULT,
  readDrawStyle,
  wireDrawStyle,
} from "./draw-style.js";

describe("wireDrawStyle", () => {
  it("returns undefined for the default style (lean wire)", () => {
    expect(wireDrawStyle({ ...DRAW_STYLE_DEFAULT })).toBeUndefined();
  });

  it("returns undefined when only the color differs (color rides Annotation.color)", () => {
    expect(
      wireDrawStyle({ ...DRAW_STYLE_DEFAULT, color: "#2563EB" }),
    ).toBeUndefined();
  });

  it("emits only the non-default fields", () => {
    expect(
      wireDrawStyle({
        color: "#FF3D6E",
        width: 5,
        fill: "translucent",
        radius: 0,
        dashed: false,
      }),
    ).toEqual({ width: 5, fill: "translucent" });
  });

  it("emits radius and dashed when set", () => {
    expect(
      wireDrawStyle({
        color: "#FF3D6E",
        width: 3,
        fill: "solid",
        radius: 8,
        dashed: true,
      }),
    ).toEqual({ fill: "solid", radius: 8, dashed: true });
  });
});

describe("readDrawStyle", () => {
  it("returns defaults for missing / malformed input", () => {
    expect(readDrawStyle(undefined)).toEqual(DRAW_STYLE_DEFAULT);
    expect(readDrawStyle(null)).toEqual(DRAW_STYLE_DEFAULT);
    expect(readDrawStyle("junk")).toEqual(DRAW_STYLE_DEFAULT);
    expect(readDrawStyle({ fill: "plaid", width: "huge" })).toEqual(
      DRAW_STYLE_DEFAULT,
    );
  });

  it("round-trips a stored style", () => {
    const s = {
      color: "#10B981",
      width: 2,
      fill: "solid" as const,
      radius: 16,
      dashed: true,
    };
    expect(readDrawStyle(s)).toEqual(s);
  });
});
