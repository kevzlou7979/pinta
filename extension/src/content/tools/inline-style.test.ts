// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest";
import {
  applyPreview,
  diffAppliedProps,
  rebuildInline,
} from "./inline-style.js";

// These tests reproduce the tool-mixing bug: combining Resize → Text →
// Paint (etc.) used to revert earlier edits because each tool reset the
// element to its TRUE original before re-applying only its own changes.
// The fix: each tool resets to the element's CURRENT inline style
// (captured when it starts), which already carries the earlier tools'
// work. A DOM env is required so the browser's real CSS engine parses
// values — the same engine the tools use in the extension.

function el(): HTMLElement {
  return document.createElement("div");
}

/** Model of one tool session: capture the element's current inline style
 *  as the base, then apply this tool's changes on top of it (exactly what
 *  the real tools do — begin captures `baseCssText`, apply re-layers). */
function runTool(node: HTMLElement, changes: Record<string, string>): {
  base: string;
  applied: Record<string, string>;
} {
  const base = node.style.cssText;
  applyPreview(node, base, changes);
  return { base, applied: diffAppliedProps(base, node.style.cssText) };
}

describe("applyPreview — layering", () => {
  let node: HTMLElement;
  beforeEach(() => {
    node = el();
  });

  it("applies changes onto the base", () => {
    applyPreview(node, "", { "font-weight": "700", color: "rgb(1, 2, 3)" });
    expect(node.style.getPropertyValue("font-weight")).toBe("700");
    expect(node.style.getPropertyValue("color")).toBe("rgb(1, 2, 3)");
  });

  it("PRESERVES the base while applying — the core fix", () => {
    // Base already carries a prior tool's resize.
    applyPreview(node, "width: 200px; height: 50px;", {
      "background-color": "rgb(10, 20, 30)",
    });
    expect(node.style.getPropertyValue("width")).toBe("200px");
    expect(node.style.getPropertyValue("height")).toBe("50px");
    expect(node.style.getPropertyValue("background-color")).toBe(
      "rgb(10, 20, 30)",
    );
  });

  it("is idempotent — re-applying doesn't stack or drift", () => {
    const base = "width: 200px;";
    applyPreview(node, base, { color: "rgb(1, 1, 1)" });
    applyPreview(node, base, { color: "rgb(2, 2, 2)" });
    expect(node.style.getPropertyValue("color")).toBe("rgb(2, 2, 2)");
    expect(node.style.getPropertyValue("width")).toBe("200px");
  });

  it("an empty value contributes nothing (a cleared field)", () => {
    applyPreview(node, "", { color: "", "font-weight": "700" });
    expect(node.style.getPropertyValue("color")).toBe("");
    expect(node.style.getPropertyValue("font-weight")).toBe("700");
  });
});

describe("combining tools — Resize → Text → Paint accumulates", () => {
  it("keeps every earlier tool's edit through the whole chain", () => {
    const node = el();

    // 1. Resize sets width/height.
    runTool(node, { width: "211px", height: "42px" });
    // 2. Text formats — base now includes the resize.
    runTool(node, { "font-weight": "700", "font-size": "18px" });
    // 3. Paint recolors — base now includes resize + text.
    runTool(node, { "background-color": "rgb(16, 42, 87)", color: "rgb(255, 255, 255)" });

    // All three tools survive (the bug was #3 reverting #1 and #2).
    expect(node.style.getPropertyValue("width")).toBe("211px");
    expect(node.style.getPropertyValue("height")).toBe("42px");
    expect(node.style.getPropertyValue("font-weight")).toBe("700");
    expect(node.style.getPropertyValue("font-size")).toBe("18px");
    expect(node.style.getPropertyValue("background-color")).toBe("rgb(16, 42, 87)");
    expect(node.style.getPropertyValue("color")).toBe("rgb(255, 255, 255)");
  });

  it("a later tool can still override an earlier tool's property", () => {
    const node = el();
    runTool(node, { color: "rgb(1, 1, 1)" });
    runTool(node, { color: "rgb(9, 9, 9)", "font-weight": "600" });
    expect(node.style.getPropertyValue("color")).toBe("rgb(9, 9, 9)");
    expect(node.style.getPropertyValue("font-weight")).toBe("600");
  });
});

describe("diffAppliedProps — the delta a tool applied", () => {
  it("captures only the changed properties", () => {
    const delta = diffAppliedProps(
      "width: 200px;",
      "width: 200px; background-color: rgb(1, 2, 3);",
    );
    expect(delta).toEqual({ "background-color": "rgb(1, 2, 3)" });
  });

  it("records a property the tool REMOVED as empty string", () => {
    // A prop present in the base but gone in the applied style = the tool
    // cleared it → recorded as "" so a rebuild removes it.
    const delta = diffAppliedProps("color: rgb(9, 9, 9);", "");
    expect(delta).toEqual({ color: "" });
  });

  it("expands a shorthand to the longhands the browser actually sets", () => {
    // Paint sets `border-color`; the engine expands it. The delta captures
    // the longhands, which rebuild replays faithfully.
    const delta = diffAppliedProps("", "border-color: rgb(1, 2, 3);");
    expect(delta["border-top-color"]).toBe("rgb(1, 2, 3)");
    expect(delta["border-left-color"]).toBe("rgb(1, 2, 3)");
  });

  it("captures a transform (Scale's preview) as its delta", () => {
    const delta = diffAppliedProps(
      "width: 100px;",
      "width: 100px; transform-origin: top left; transform: scale(1.5);",
    );
    expect(delta.transform).toBe("scale(1.5)");
    expect(delta["transform-origin"]).toBe("top left");
    expect(delta.width).toBeUndefined();
  });

  it("survives complex base values without corrupting the diff", () => {
    // A url() with an embedded ';' would break a naive string parser; the
    // browser engine handles it, so the diff stays clean.
    const base = 'background-image: url("a.png?x=1;y=2");';
    const delta = diffAppliedProps(base, base + " color: rgb(1, 2, 3);");
    expect(delta).toEqual({ color: "rgb(1, 2, 3)" });
  });
});

describe("rebuildInline — removing one annotation keeps the others", () => {
  it("replays survivors on top of the true original", () => {
    const node = el();
    const resize = { width: "211px", height: "42px" };
    const text = { "font-weight": "700" };
    const paint = { "background-color": "rgb(16, 42, 87)" };

    // Remove the TEXT annotation: rebuild from original + resize + paint.
    rebuildInline(node, "", [resize, paint]);
    expect(node.style.getPropertyValue("width")).toBe("211px");
    expect(node.style.getPropertyValue("height")).toBe("42px");
    expect(node.style.getPropertyValue("background-color")).toBe("rgb(16, 42, 87)");
    expect(node.style.getPropertyValue("font-weight")).toBe(""); // the removed one is gone
    // `text` referenced so lint doesn't flag the intent of the scenario.
    expect(text["font-weight"]).toBe("700");
  });

  it("removing the LAST annotation leaves the earlier ones intact", () => {
    const node = el();
    rebuildInline(node, "", [{ width: "211px" }, { "font-weight": "700" }]);
    expect(node.style.getPropertyValue("width")).toBe("211px");
    expect(node.style.getPropertyValue("font-weight")).toBe("700");
  });

  it("last-writer wins when survivors touch the same property", () => {
    const node = el();
    rebuildInline(node, "", [{ color: "rgb(1, 1, 1)" }, { color: "rgb(9, 9, 9)" }]);
    expect(node.style.getPropertyValue("color")).toBe("rgb(9, 9, 9)");
  });

  it("an empty-string delta clears a property from the original", () => {
    const node = el();
    // Original had a border; a survivor annotation removed it (Paint →
    // transparent recorded as "").
    rebuildInline(node, "border-color: rgb(9, 9, 9);", [{ "border-color": "" }]);
    expect(node.style.getPropertyValue("border-color")).toBe("");
  });

  it("no survivors → snaps back to the true original", () => {
    const node = el();
    node.style.cssText = "width: 999px; color: rgb(5, 5, 5);";
    rebuildInline(node, "width: 100px;", []);
    expect(node.style.getPropertyValue("width")).toBe("100px");
    expect(node.style.getPropertyValue("color")).toBe("");
  });
});

describe("end-to-end mixing: combine three, remove the middle one", () => {
  it("rebuilds to exactly resize + paint", () => {
    const node = el();
    // Combine, capturing each tool's applied delta like the extension does.
    const a = runTool(node, { width: "211px", height: "42px" }); // resize
    const b = runTool(node, { "font-weight": "700" }); // text
    const c = runTool(node, { "background-color": "rgb(16, 42, 87)" }); // paint

    // Sanity: everything is present after combining.
    expect(node.style.getPropertyValue("font-weight")).toBe("700");

    // Remove the middle (text) annotation → rebuild from the survivors' deltas.
    rebuildInline(node, "", [a.applied, c.applied]);

    expect(node.style.getPropertyValue("width")).toBe("211px");
    expect(node.style.getPropertyValue("height")).toBe("42px");
    expect(node.style.getPropertyValue("background-color")).toBe("rgb(16, 42, 87)");
    expect(node.style.getPropertyValue("font-weight")).toBe("");
    expect(b.applied["font-weight"]).toBe("700"); // the removed delta was captured
  });
});
