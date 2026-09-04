// @vitest-environment happy-dom
//
// Unit tests for the Design Variants pure helpers — with emphasis on
// sanitizeVariantHtml, the security-critical inbound gate for
// agent-generated HTML (see the trust-edge note in design-variants.ts).

import { describe, expect, it } from "vitest";
import {
  buildSrcdoc,
  DEFAULT_DEVICE_PRESETS,
  frameScale,
  MAX_DIRECTION_CHARS,
  MAX_PAGES,
  MAX_VARIANTS,
  normalizeDirection,
  parseApplyResult,
  parseDevicePresets,
  parsePagesResult,
  parseVariantsResult,
  PREVIEW_HTML_MAX_ELEMENT,
  PREVIEW_HTML_MAX_PAGE,
  sanitizeVariantHtml,
  validateVariantRun,
  type DesignVariant,
} from "./design-variants.js";

function variant(overrides: Partial<DesignVariant> = {}): DesignVariant {
  return {
    id: "v1",
    label: "Test",
    rationale: "",
    previewHtml: "<div>hi</div>",
    summary: "",
    ...overrides,
  };
}

describe("sanitizeVariantHtml", () => {
  it("drops script elements", () => {
    const out = sanitizeVariantHtml("<div>ok</div><script>alert(1)</script>");
    expect(out).toContain("ok");
    expect(out).not.toContain("script");
  });

  it("drops iframe/object/embed/link/meta/base/form", () => {
    const out = sanitizeVariantHtml(
      '<iframe src="https://evil"></iframe><object></object><embed>' +
        '<link rel="stylesheet" href="https://evil/x.css"><meta http-equiv="refresh" content="0">' +
        "<base href='https://evil'><form action='https://evil'></form><p>keep</p>",
    );
    expect(out).toBe("<p>keep</p>");
  });

  it("strips on* handlers", () => {
    const out = sanitizeVariantHtml('<img onerror="alert(1)" alt="x">');
    expect(out).not.toContain("onerror");
    expect(out).toContain("<img");
  });

  it("strips javascript: and data: URLs, keeps normal ones", () => {
    const out = sanitizeVariantHtml(
      '<a href="javascript:alert(1)">a</a><a href="JAVA SCRIPT:x">b</a>' +
        '<img src="data:text/html,x"><a href="/fine">c</a>',
    );
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("data:");
    expect(out).toContain('href="/fine"');
  });

  it("drops style attributes containing url(", () => {
    const out = sanitizeVariantHtml(
      '<div style="background:url(https://evil/x.png);color:red">x</div>' +
        '<div style="color:blue">y</div>',
    );
    expect(out).not.toContain("evil");
    expect(out).toContain('style="color:blue"');
  });

  it("keeps <style> elements but neuters url() inside them", () => {
    const out = sanitizeVariantHtml(
      "<style>.a{background:url('https://evil/x.png');color:red}</style><div class='a'>x</div>",
    );
    expect(out).toContain("<style>");
    expect(out).not.toContain("evil");
    expect(out).toContain("color:red");
  });

  it("handles empty / non-string input", () => {
    expect(sanitizeVariantHtml("")).toBe("");
    // @ts-expect-error deliberate bad input
    expect(sanitizeVariantHtml(undefined)).toBe("");
  });

  // SVG foreign-content elements keep a LOWERCASE tagName — the classic
  // innerHTML-sanitizer bypass. These must not survive.
  it("drops <script> inside <svg> (lowercase tagName bypass)", () => {
    // <p> placed BEFORE the svg — happy-dom's foreign-content parsing
    // differs from browsers for elements after an svg, and this test is
    // about the script, not the parser.
    const out = sanitizeVariantHtml("<p>k</p><svg><script>alert(1)</script></svg>");
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>k</p>");
  });

  it("neuters url() and @import in <style> inside <svg>", () => {
    const out = sanitizeVariantHtml(
      "<svg><style>@import url('https://evil/x.css');.a{background:url(https://evil/y.png)}</style></svg>",
    );
    expect(out).not.toContain("evil");
    expect(out).not.toContain("@import");
  });

  it("strips string-form @import in top-level <style>", () => {
    const out = sanitizeVariantHtml(
      '<style>@import "https://evil/x.css"; .a{color:red}</style>',
    );
    expect(out).not.toContain("evil");
    expect(out).not.toContain("@import");
    expect(out).toContain("color:red");
  });
});

describe("buildSrcdoc", () => {
  it("wraps sanitized preview html in a full document", () => {
    const doc = buildSrcdoc(
      variant({ previewHtml: "<button>Go</button><script>x()</script>" }),
    );
    expect(doc).toContain("<!doctype html>");
    expect(doc).toContain("<button>Go</button>");
    expect(doc).not.toContain("x()");
  });
});

describe("parseDevicePresets", () => {
  it("returns defaults for blank / undefined / bad JSON / wrong shapes", () => {
    expect(parseDevicePresets(undefined)).toEqual(DEFAULT_DEVICE_PRESETS);
    expect(parseDevicePresets("")).toEqual(DEFAULT_DEVICE_PRESETS);
    expect(parseDevicePresets("not json")).toEqual(DEFAULT_DEVICE_PRESETS);
    expect(parseDevicePresets("{}")).toEqual(DEFAULT_DEVICE_PRESETS);
    expect(parseDevicePresets('[{"label":"X","width":-2,"height":5}]')).toEqual(
      DEFAULT_DEVICE_PRESETS,
    );
    expect(parseDevicePresets(true)).toEqual(DEFAULT_DEVICE_PRESETS);
  });

  it("parses a valid override and drops invalid rows", () => {
    const out = parseDevicePresets(
      '[{"label":"Phone","width":375,"height":667},{"label":"","width":5,"height":5}]',
    );
    expect(out).toEqual([{ label: "Phone", width: 375, height: 667 }]);
  });
});

describe("frameScale", () => {
  it("fits device width into card width, never upscaling", () => {
    expect(frameScale(1280, 320)).toBeCloseTo(0.25);
    expect(frameScale(390, 780)).toBe(1);
    expect(frameScale(0, 300)).toBe(1);
  });
});

describe("parseVariantsResult", () => {
  const good = JSON.stringify({
    type: "design-variants-run",
    runId: "r1",
    variants: [
      { id: "v1", label: "A", rationale: "r", previewHtml: "<div>a</div>", summary: "s" },
      { id: "v2", label: "B", rationale: "r", previewHtml: "<div>b</div>", summary: "s", swap: { cssChanges: { color: "red" } } },
    ],
  });

  it("parses a well-formed run", () => {
    const out = parseVariantsResult(good);
    expect(out?.runId).toBe("r1");
    expect(out?.variants).toHaveLength(2);
    expect(out?.variants[1].swap?.cssChanges).toEqual({ color: "red" });
  });

  it("accepts type aliases and duck-typed payloads", () => {
    for (const type of ["variants-run", "design-variants", undefined]) {
      const payload: Record<string, unknown> = {
        variants: [{ previewHtml: "<i>x</i>" }],
      };
      if (type) payload.type = type;
      expect(parseVariantsResult(JSON.stringify(payload))).not.toBeNull();
    }
  });

  it("fills missing ids/labels and drops variants without previewHtml", () => {
    const out = parseVariantsResult(
      JSON.stringify({
        type: "design-variants-run",
        variants: [{ previewHtml: "<i>x</i>" }, { label: "no html" }],
      }),
    );
    expect(out?.variants).toHaveLength(1);
    expect(out?.variants[0].id).toBe("v1");
    expect(out?.variants[0].label).toBe("Variant 1");
  });

  it("clamps to MAX_VARIANTS", () => {
    const out = parseVariantsResult(
      JSON.stringify({
        type: "design-variants-run",
        variants: Array.from({ length: 6 }, (_, i) => ({
          previewHtml: `<i>${i}</i>`,
        })),
      }),
    );
    expect(out?.variants).toHaveLength(MAX_VARIANTS);
  });

  it("returns null for garbage / empty / wrong shapes", () => {
    expect(parseVariantsResult("not json")).toBeNull();
    expect(parseVariantsResult("{}")).toBeNull();
    expect(parseVariantsResult(JSON.stringify({ type: "other" }))).toBeNull();
    expect(
      parseVariantsResult(JSON.stringify({ type: "design-variants-run", variants: [] })),
    ).toBeNull();
  });
});

describe("validateVariantRun", () => {
  it("clamps previewHtml at the per-scope cap", () => {
    const big = "x".repeat(PREVIEW_HTML_MAX_PAGE + 100);
    const el = validateVariantRun([variant({ previewHtml: big })], "element");
    const pg = validateVariantRun([variant({ previewHtml: big })], "page");
    expect(el[0].previewHtml.length).toBe(PREVIEW_HTML_MAX_ELEMENT);
    expect(pg[0].previewHtml.length).toBe(PREVIEW_HTML_MAX_PAGE);
  });
});

describe("parseApplyResult", () => {
  it("parses applied payloads incl. files", () => {
    const out = parseApplyResult(
      JSON.stringify({
        type: "design-variants-applied",
        variantId: "v2",
        summary: "done",
        files: [{ path: "src/App.svelte", note: "swapped bg" }, { bad: true }],
      }),
    );
    expect(out?.variantId).toBe("v2");
    expect(out?.files).toEqual([{ path: "src/App.svelte", note: "swapped bg" }]);
  });

  it("duck-types on variantId and rejects garbage", () => {
    expect(parseApplyResult(JSON.stringify({ variantId: "v1" }))).not.toBeNull();
    expect(parseApplyResult("nope")).toBeNull();
    expect(parseApplyResult("{}")).toBeNull();
  });
});

describe("parsePagesResult", () => {
  it("parses pages, requires leading slash, clamps at MAX_PAGES", () => {
    const out = parsePagesResult(
      JSON.stringify({
        type: "design-variants-pages",
        pages: [
          { path: "/signin", label: "Sign in" },
          { path: "https://evil.example/x", label: "nope" },
          { path: "/home" },
          ...Array.from({ length: 20 }, (_, i) => ({ path: `/p${i}` })),
        ],
      }),
    );
    expect(out?.[0]).toEqual({ path: "/signin", label: "Sign in" });
    expect(out?.some((p) => p.label === "nope")).toBe(false);
    expect(out?.[1]).toEqual({ path: "/home", label: "/home" });
    expect(out?.length).toBe(MAX_PAGES);
  });

  it("returns null for garbage or no valid pages", () => {
    expect(parsePagesResult("x")).toBeNull();
    expect(
      parsePagesResult(JSON.stringify({ type: "design-variants-pages", pages: [{ path: "relative" }] })),
    ).toBeNull();
  });
});

describe("normalizeDirection", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeDirection("  make it   glassy\n and compact  ")).toBe(
      "make it glassy and compact",
    );
  });

  it("returns empty string for blank input", () => {
    expect(normalizeDirection("")).toBe("");
    expect(normalizeDirection("   \n\t ")).toBe("");
  });

  it("caps at MAX_DIRECTION_CHARS", () => {
    const long = "x".repeat(MAX_DIRECTION_CHARS + 100);
    expect(normalizeDirection(long)).toHaveLength(MAX_DIRECTION_CHARS);
  });
});
