import { describe, it, expect } from "vitest";
import {
  deviceClassForWidth,
  viewportLabel,
  viewportAgentNote,
  type Annotation,
} from "@pinta/shared";
import { formatSessionAsClipboard, formatSessionAsText } from "./format-clipboard.js";

describe("deviceClassForWidth", () => {
  it("classifies by breakpoint (≤480 mobile, ≤1024 tablet, else desktop)", () => {
    expect(deviceClassForWidth(320)).toBe("mobile");
    expect(deviceClassForWidth(425)).toBe("mobile");
    expect(deviceClassForWidth(480)).toBe("mobile");
    expect(deviceClassForWidth(481)).toBe("tablet");
    expect(deviceClassForWidth(768)).toBe("tablet");
    expect(deviceClassForWidth(1024)).toBe("tablet");
    expect(deviceClassForWidth(1025)).toBe("desktop");
    expect(deviceClassForWidth(1440)).toBe("desktop");
  });
});

describe("viewportLabel", () => {
  it("labels mobile/tablet with rounded width", () => {
    expect(viewportLabel({ width: 425 })).toBe("Mobile · 425px");
    expect(viewportLabel({ width: 768.4 })).toBe("Tablet · 768px");
  });

  it("hides desktop unless includeDesktop is set", () => {
    expect(viewportLabel({ width: 1440 })).toBeNull();
    expect(viewportLabel({ width: 1440 }, { includeDesktop: true })).toBe(
      "Desktop · 1440px",
    );
  });

  it("returns null for missing / non-finite width", () => {
    expect(viewportLabel(undefined)).toBeNull();
    expect(viewportLabel({ width: NaN })).toBeNull();
  });
});

describe("viewportAgentNote", () => {
  it("scopes narrow captures to their breakpoint", () => {
    expect(viewportAgentNote({ width: 425 })).toContain("mobile breakpoint (≤480px)");
    expect(viewportAgentNote({ width: 425 })).toContain("keep the desktop layout unchanged");
    expect(viewportAgentNote({ width: 768 })).toContain("tablet breakpoint (≤1024px)");
  });

  it("stays silent for desktop / missing viewport", () => {
    expect(viewportAgentNote({ width: 1440 })).toBeNull();
    expect(viewportAgentNote(undefined)).toBeNull();
  });
});

function selectAnn(width: number, comment = "make these cards not a grid"): Annotation {
  return {
    id: "a1",
    createdAt: 0,
    kind: "select",
    strokes: [],
    color: "#000",
    comment,
    target: { selector: ".grid", outerHTML: "<div class='grid'>", computedStyles: {}, nearbyText: [], boundingRect: { x: 0, y: 0, width: 0, height: 0 } },
    viewport: { scrollY: 0, width, height: 900 },
  };
}

describe("format-clipboard viewport note", () => {
  it("adds a Viewport scoping line for a mobile capture (markdown)", () => {
    const md = formatSessionAsClipboard({
      url: "http://localhost/x",
      annotations: [selectAnn(425)],
    });
    expect(md).toContain("**Viewport:**");
    expect(md).toContain("mobile breakpoint (≤480px)");
  });

  it("adds a Viewport line in the text variant too", () => {
    const txt = formatSessionAsText({
      url: "http://localhost/x",
      annotations: [selectAnn(425)],
    });
    expect(txt).toContain("Viewport:");
    expect(txt).toContain("mobile breakpoint");
  });

  it("omits the Viewport line for a desktop capture", () => {
    const md = formatSessionAsClipboard({
      url: "http://localhost/x",
      annotations: [selectAnn(1440)],
    });
    expect(md).not.toContain("**Viewport:**");
  });
});
