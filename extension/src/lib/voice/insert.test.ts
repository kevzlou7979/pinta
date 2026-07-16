import { describe, it, expect } from "vitest";
import { insertAtCaret } from "./insert";

describe("insertAtCaret", () => {
  it("inserts into an empty field with no padding", () => {
    expect(insertAtCaret("", 0, 0, "hello world")).toEqual({
      value: "hello world",
      caret: 11,
    });
  });

  it("adds a joining space after an existing word", () => {
    // caret at end of "hello"
    expect(insertAtCaret("hello", 5, 5, "world")).toEqual({
      value: "hello world",
      caret: 11,
    });
  });

  it("does not double up whitespace when one already exists", () => {
    expect(insertAtCaret("hello ", 6, 6, "world")).toEqual({
      value: "hello world",
      caret: 11,
    });
  });

  it("replaces the current selection", () => {
    // select "world" in "hello world" (indices 6..11)
    expect(insertAtCaret("hello world", 6, 11, "there")).toEqual({
      value: "hello there",
      caret: 11,
    });
  });

  it("inserts mid-string and spaces on both sides", () => {
    // caret between "hello" and "world": "hello |world"
    const r = insertAtCaret("hello world", 5, 5, "big");
    expect(r.value).toBe("hello big world");
    expect(r.caret).toBe("hello big".length);
  });

  it("clamps out-of-range / negative selection bounds", () => {
    expect(insertAtCaret("abc", -5, 999, "x")).toEqual({
      value: "x",
      caret: 1,
    });
  });
});
