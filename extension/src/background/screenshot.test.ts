import { describe, expect, it } from "vitest";
import {
  AREA_BUDGET,
  DEVICE_FRAME_MAX_EDGE,
  MAX_CANVAS_SIDE,
  deviceFrameOutputSize,
  fullPageHeightCap,
} from "./screenshot.js";

describe("fullPageHeightCap", () => {
  it("caps typical widths at the canvas side limit", () => {
    expect(fullPageHeightCap(1280)).toBe(MAX_CANVAS_SIDE);
    expect(fullPageHeightCap(1920)).toBe(MAX_CANVAS_SIDE);
  });

  it("caps very wide pages by the area budget", () => {
    const cap = fullPageHeightCap(8000);
    expect(cap).toBe(Math.floor(AREA_BUDGET / 8000));
    expect(cap * 8000).toBeLessThanOrEqual(AREA_BUDGET);
  });

  it("never returns 0 or NaN for degenerate widths", () => {
    expect(fullPageHeightCap(0)).toBe(MAX_CANVAS_SIDE);
    expect(fullPageHeightCap(-5)).toBe(MAX_CANVAS_SIDE);
    expect(fullPageHeightCap(1e12)).toBeGreaterThanOrEqual(1);
  });
});

const report = (over: Partial<Parameters<typeof deviceFrameOutputSize>[0]> = {}) => ({
  rect: { x: 0, y: 0, width: 390, height: 844 },
  cssWidth: 390,
  cssHeight: 844,
  viewportWidth: 1920,
  viewportHeight: 1080,
  devicePixelRatio: 1,
  ...over,
});

describe("deviceFrameOutputSize", () => {
  it("keeps device CSS size for an actual-size frame on DPR 1", () => {
    expect(deviceFrameOutputSize(report())).toEqual({ width: 390, height: 844, k: 1 });
  });

  it("never upscales a scaled-down frame past its on-screen pixels", () => {
    const out = deviceFrameOutputSize(
      report({ cssWidth: 1440, cssHeight: 900, rect: { x: 0, y: 0, width: 720, height: 450 } }),
    );
    expect(out).toEqual({ width: 720, height: 450, k: 0.5 });
  });

  it("uses DPR pixels but not beyond CSS size", () => {
    const out = deviceFrameOutputSize(
      report({
        cssWidth: 1440,
        cssHeight: 900,
        rect: { x: 0, y: 0, width: 720, height: 450 },
        devicePixelRatio: 2,
      }),
    );
    expect(out.width).toBe(1440);
    expect(out.height).toBe(900);
  });

  it("caps the long edge", () => {
    const out = deviceFrameOutputSize(
      report({ cssWidth: 1920, cssHeight: 1080, rect: { x: 0, y: 0, width: 1920, height: 1080 } }),
    );
    expect(Math.max(out.width, out.height)).toBe(DEVICE_FRAME_MAX_EDGE);
    expect(out.width / out.height).toBeCloseTo(1920 / 1080, 2);
  });
});
