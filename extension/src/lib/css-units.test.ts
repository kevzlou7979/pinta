import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASES,
  EDITOR_UNITS,
  baseFor,
  convertLength,
  convertShorthand,
  defaultUnitFor,
  ensureUnits,
  isResponsiveLength,
  parseLength,
  toUnitlessLineHeight,
  trimNumber,
  type UnitBases,
} from "./css-units.js";

// A 24px heading inside a 32px parent, on a 16px-root page. The three
// bases differ on purpose so a conversion picking the wrong one is
// obvious in the expected value.
const BASES: UnitBases = {
  ownFontSize: 24,
  parentFontSize: 32,
  rootFontSize: 16,
  parentWidth: 800,
};

describe("defaultUnitFor", () => {
  it("starts font-size in em so type stays proportional to its parent", () => {
    expect(defaultUnitFor("font-size")).toBe("em");
    expect(defaultUnitFor("FONT-SIZE")).toBe("em");
  });

  it("starts spacing / sizing in rem so it follows the root scale", () => {
    for (const p of ["padding", "margin", "gap", "border-radius", "width", "height"]) {
      expect(defaultUnitFor(p)).toBe("rem");
    }
  });

  it("falls back to rem for anything unlisted", () => {
    expect(defaultUnitFor("inset-inline-start")).toBe("rem");
  });
});

describe("baseFor", () => {
  it("measures em against the parent for font-size, the element otherwise", () => {
    expect(baseFor("font-size", "em", BASES)).toBe(32);
    expect(baseFor("padding", "em", BASES)).toBe(24);
  });

  it("measures rem against the root", () => {
    expect(baseFor("padding", "rem", BASES)).toBe(16);
  });

  it("has no base for % on a box property when the parent wasn't measured", () => {
    expect(baseFor("padding", "%", DEFAULT_BASES)).toBe(0);
    expect(baseFor("font-size", "%", DEFAULT_BASES)).toBe(16);
  });

  it("only spends the parent width on properties whose % means inline size", () => {
    expect(baseFor("width", "%", BASES)).toBe(800);
    expect(baseFor("padding", "%", BASES)).toBe(800);
    // % of the parent's height / of the element's own box — not ours to guess.
    expect(baseFor("height", "%", BASES)).toBe(0);
    expect(baseFor("border-radius", "%", BASES)).toBe(0);
    expect(baseFor("gap", "%", BASES)).toBe(0);
  });
});

describe("convertLength", () => {
  it("converts px to em against the PARENT font size for font-size", () => {
    // 24px inside a 32px parent = 0.75em, not 1em.
    expect(convertLength("24px", "font-size", "em", BASES)).toBe("0.75em");
  });

  it("converts px to em against the element's OWN font size elsewhere", () => {
    // 24px of padding on a 24px-type element = 1em.
    expect(convertLength("24px", "padding", "em", BASES)).toBe("1em");
    expect(convertLength("12px", "padding", "em", BASES)).toBe("0.5em");
  });

  it("converts px to rem against the root font size", () => {
    expect(convertLength("24px", "font-size", "rem", BASES)).toBe("1.5rem");
    expect(convertLength("24px", "padding", "rem", BASES)).toBe("1.5rem");
  });

  it("converts back to px", () => {
    expect(convertLength("1.5rem", "padding", "px", BASES)).toBe("24px");
    expect(convertLength("0.75em", "font-size", "px", BASES)).toBe("24px");
  });

  it("reads an existing relative unit rather than reinterpreting the number", () => {
    // 1em of padding is 24px, which is 1.5rem — not 1rem.
    expect(convertLength("1em", "padding", "rem", BASES)).toBe("1.5rem");
  });

  it("keeps 0 as 0 in every unit", () => {
    for (const u of EDITOR_UNITS) {
      expect(convertLength("0", "padding", u, BASES)).toBe("0");
      expect(convertLength("0px", "padding", u, BASES)).toBe("0");
    }
  });

  it("leaves keywords untouched", () => {
    for (const kw of ["auto", "normal", "none", "inherit", "fit-content", "max-content"]) {
      expect(convertLength(kw, "width", "em", BASES)).toBe(kw);
    }
  });

  it("leaves units it can't resolve untouched", () => {
    expect(convertLength("50vh", "height", "rem", BASES)).toBe("50vh");
    expect(convertLength("3ch", "width", "rem", BASES)).toBe("3ch");
  });

  it("converts % only where a base exists", () => {
    // font-size: % of the parent's font size.
    expect(convertLength("50%", "font-size", "px", BASES)).toBe("16px");
    expect(convertLength("16px", "font-size", "%", BASES)).toBe("50%");
    // box property with a measured parent width.
    expect(convertLength("50%", "width", "px", BASES)).toBe("400px");
    // …and untouched without one.
    expect(convertLength("50%", "width", "px", DEFAULT_BASES)).toBe("50%");
    expect(convertLength("24px", "width", "%", DEFAULT_BASES)).toBe("24px");
    // border-radius / height % mean something else entirely — left as-is.
    expect(convertLength("50%", "border-radius", "rem", BASES)).toBe("50%");
    expect(convertLength("100%", "height", "rem", BASES)).toBe("100%");
  });

  it("handles fractional and negative values", () => {
    expect(convertLength("-8px", "margin", "rem", BASES)).toBe("-0.5rem");
    expect(convertLength(".5rem", "padding", "px", BASES)).toBe("8px");
  });

  it("round-trips px → em → px", () => {
    for (const px of ["8px", "12px", "13px", "24px", "37px"]) {
      const em = convertLength(px, "padding", "em", BASES);
      expect(convertLength(em, "padding", "px", BASES)).toBe(px);
    }
  });

  it("round-trips px → rem → px", () => {
    for (const px of ["8px", "13px", "24px", "37px"]) {
      const rem = convertLength(px, "font-size", "rem", BASES);
      expect(convertLength(rem, "font-size", "px", BASES)).toBe(px);
    }
  });
});

describe("convertShorthand", () => {
  it("converts every token", () => {
    const bases: UnitBases = { ...DEFAULT_BASES, ownFontSize: 16 };
    expect(convertShorthand("8px 16px", "padding", "em", bases)).toBe("0.5em 1em");
    expect(convertShorthand("8px 16px 24px 32px", "padding", "rem", bases)).toBe(
      "0.5rem 1rem 1.5rem 2rem",
    );
  });

  it("keeps mixed keyword / length shorthands readable", () => {
    expect(convertShorthand("0 auto", "margin", "rem", BASES)).toBe("0 auto");
  });

  it("passes function and comma values through untouched", () => {
    const fns = [
      "calc(100% - 2rem)",
      "var(--space-4)",
      "clamp(1rem, 2vw, 2rem)",
      "min(100%, 40rem)",
      "0 4px 12px rgba(0, 0, 0, 0.1)",
    ];
    for (const v of fns) {
      expect(convertShorthand(v, "padding", "em", BASES)).toBe(v);
    }
  });

  it("returns empty for empty input", () => {
    expect(convertShorthand("", "padding", "em", BASES)).toBe("");
    expect(convertShorthand("   ", "padding", "em", BASES)).toBe("");
  });
});

describe("ensureUnits", () => {
  it("gives a bare number the unit the user is looking at", () => {
    expect(ensureUnits("24", "rem")).toBe("24rem");
    expect(ensureUnits("1.5", "em")).toBe("1.5em");
  });

  it("leaves tokens that already carry a unit alone", () => {
    expect(ensureUnits("1.5rem 12px", "em")).toBe("1.5rem 12px");
  });

  it("leaves 0, keywords and functions alone", () => {
    expect(ensureUnits("0 auto", "rem")).toBe("0 auto");
    expect(ensureUnits("auto", "rem")).toBe("auto");
    expect(ensureUnits("calc(100% - 16px)", "rem")).toBe("calc(100% - 16px)");
    expect(ensureUnits("", "rem")).toBe("");
  });
});

describe("toUnitlessLineHeight", () => {
  it("turns a computed px line-height into a ratio", () => {
    expect(toUnitlessLineHeight("38.4px", 24)).toBe("1.6");
    expect(toUnitlessLineHeight("24px", 16)).toBe("1.5");
  });

  it("leaves an existing ratio and 'normal' alone", () => {
    expect(toUnitlessLineHeight("1.5", 24)).toBe("1.5");
    expect(toUnitlessLineHeight("normal", 24)).toBe("normal");
  });

  it("reads em / % against the element's own font size", () => {
    expect(toUnitlessLineHeight("1.5em", 24)).toBe("1.5");
    expect(toUnitlessLineHeight("150%", 24)).toBe("1.5");
  });

  it("gives up safely without a font size", () => {
    expect(toUnitlessLineHeight("24px", 0)).toBe("24px");
  });
});

describe("trimNumber", () => {
  it("drops trailing zeros", () => {
    expect(trimNumber(1.5)).toBe("1.5");
    expect(trimNumber(1)).toBe("1");
    expect(trimNumber(10)).toBe("10");
    expect(trimNumber(100)).toBe("100");
    expect(trimNumber(0)).toBe("0");
    expect(trimNumber(0.75)).toBe("0.75");
    expect(trimNumber(1.0000001)).toBe("1");
    expect(trimNumber(-0.5)).toBe("-0.5");
  });

  it("honours the decimals argument", () => {
    expect(trimNumber(1.23456, 2)).toBe("1.23");
  });

  it("never returns NaN", () => {
    expect(trimNumber(Number.NaN)).toBe("0");
    expect(trimNumber(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("parseLength / isResponsiveLength", () => {
  it("parses a plain length", () => {
    expect(parseLength("1.5rem")).toEqual({ n: 1.5, unit: "rem" });
    expect(parseLength("24")).toEqual({ n: 24, unit: "" });
  });

  it("refuses keywords and functions", () => {
    expect(parseLength("auto")).toBeNull();
    expect(parseLength("calc(1rem + 2px)")).toBeNull();
    expect(parseLength("")).toBeNull();
  });

  it("flags px-only values as non-responsive", () => {
    expect(isResponsiveLength("16px")).toBe(false);
    expect(isResponsiveLength("16")).toBe(false);
    expect(isResponsiveLength("1rem")).toBe(true);
    expect(isResponsiveLength("0")).toBe(true);
    expect(isResponsiveLength("auto")).toBe(true);
  });
});
