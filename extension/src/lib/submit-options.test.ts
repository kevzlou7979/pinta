import { describe, expect, it } from "vitest";
import { DEFAULT_SUBMIT_OPTIONS, parseSubmitOptions } from "./submit-options.js";

describe("parseSubmitOptions", () => {
  it("fresh install (nothing stored) → defaults, autoApply off", () => {
    expect(DEFAULT_SUBMIT_OPTIONS.autoApply).toBe(false);
    expect(parseSubmitOptions(undefined)).toEqual({
      options: { autoApply: false, includeScreenshot: false, justAsk: false },
    });
  });

  it("a stored true stays true, and ticks keep only true entries", () => {
    const out = parseSubmitOptions({
      autoApply: true,
      includeScreenshot: true,
      ticked: { "gitlab-issues": true, other: false, junk: "yes" },
    });
    expect(out.options).toEqual({ autoApply: true, includeScreenshot: true, justAsk: false });
    expect(out.ticked).toEqual({ "gitlab-issues": true });
  });

  it("junk falls back to defaults", () => {
    for (const raw of [null, "x", 42, { autoApply: "true", justAsk: 1, ticked: "no" }]) {
      const out = parseSubmitOptions(raw);
      expect(out.options).toEqual(DEFAULT_SUBMIT_OPTIONS);
      expect(out.ticked).toBeUndefined();
    }
  });

  it("returns a fresh object (callers may mutate it)", () => {
    const a = parseSubmitOptions(undefined).options;
    a.autoApply = true;
    expect(DEFAULT_SUBMIT_OPTIONS.autoApply).toBe(false);
  });
});
