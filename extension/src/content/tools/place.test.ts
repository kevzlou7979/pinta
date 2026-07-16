import { describe, expect, it } from "vitest";
import {
  flowAxis,
  insertionBarRect,
  pickInsertion,
  type Rect,
} from "./place.js";

// Vertical list: three stacked rows, full width.
const rows: Rect[] = [
  { x: 0, y: 0, width: 100, height: 20 },
  { x: 0, y: 24, width: 100, height: 20 },
  { x: 0, y: 48, width: 100, height: 20 },
];

// Horizontal list: three side-by-side chips.
const chips: Rect[] = [
  { x: 0, y: 0, width: 30, height: 20 },
  { x: 34, y: 0, width: 30, height: 20 },
  { x: 68, y: 0, width: 30, height: 20 },
];

describe("flowAxis", () => {
  it("detects vertical (block) flow", () => {
    expect(flowAxis(rows)).toBe("y");
  });

  it("detects horizontal (inline/flex-row) flow", () => {
    expect(flowAxis(chips)).toBe("x");
  });

  it("defaults to vertical for 0-1 children", () => {
    expect(flowAxis([])).toBe("y");
    expect(flowAxis([rows[0]!])).toBe("y");
  });
});

describe("pickInsertion", () => {
  it("returns null for an empty list", () => {
    expect(pickInsertion([], 10, 10)).toBeNull();
  });

  it("picks the nearest row and before/after by midpoint (vertical)", () => {
    // Point in the upper half of row 1 → before row 1.
    expect(pickInsertion(rows, 50, 26)).toEqual({ index: 1, before: true, axis: "y" });
    // Point in the lower half of row 1 → after row 1.
    expect(pickInsertion(rows, 50, 40)).toEqual({ index: 1, before: false, axis: "y" });
  });

  it("picks the nearest chip by x midpoint (horizontal)", () => {
    expect(pickInsertion(chips, 36, 10)).toEqual({ index: 1, before: true, axis: "x" });
    expect(pickInsertion(chips, 60, 10)).toEqual({ index: 1, before: false, axis: "x" });
  });

  it("snaps to the nearest child when the point is outside every rect", () => {
    // Below the whole vertical list → nearest is the last row, after it.
    expect(pickInsertion(rows, 50, 200)).toEqual({ index: 2, before: false, axis: "y" });
    // Left of the whole chip row → first chip, before it.
    expect(pickInsertion(chips, -20, 10)).toEqual({ index: 0, before: true, axis: "x" });
  });
});

describe("insertionBarRect", () => {
  const child: Rect = { x: 10, y: 30, width: 80, height: 20 };

  it("draws a horizontal bar above/below in vertical flow", () => {
    const above = insertionBarRect(child, true, "y");
    expect(above.width).toBe(80);
    expect(above.y).toBeCloseTo(30 - above.height / 2);
    const below = insertionBarRect(child, false, "y");
    expect(below.y).toBeCloseTo(50 - below.height / 2);
  });

  it("draws a vertical bar left/right in horizontal flow", () => {
    const left = insertionBarRect(child, true, "x");
    expect(left.height).toBe(20);
    expect(left.x).toBeCloseTo(10 - left.width / 2);
    const right = insertionBarRect(child, false, "x");
    expect(right.x).toBeCloseTo(90 - right.width / 2);
  });
});
