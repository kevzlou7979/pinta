import { describe, expect, it } from "vitest";
import type { Annotation } from "@pinta/shared";
import {
  IMPORT_ISSUE_COMMENT_CAP,
  buildImportFileIssueItems,
  parseImportedIssuesFiled,
} from "./import-issues.js";

/** Minimal annotation — the helper only reads the documented fields. */
function makeAnnotation(input: Partial<Annotation> = {}): Annotation {
  return {
    id: "a1",
    createdAt: 1,
    kind: "select",
    comment: "Button misaligned",
    targets: [
      {
        selector: "#save",
        outerHTML: "<button id=\"save\">Save</button>",
        computedStyles: {},
        nearbyText: ["Save", "Cancel"],
        boundingRect: { x: 0, y: 0, width: 10, height: 10 },
      },
    ],
    ...input,
  } as Annotation;
}

describe("buildImportFileIssueItems", () => {
  it("flattens id, kind, comment, url, selector, nearby text and image count", () => {
    const items = buildImportFileIssueItems(
      [makeAnnotation({ images: [{ id: "image1" }] as never })],
      "https://app.example/page",
    );
    expect(items).toEqual([
      {
        annotationId: "a1",
        kind: "select",
        comment: "Button misaligned",
        url: "https://app.example/page",
        where: { selector: "#save", text: "Save Cancel" },
        hasImages: true,
      },
    ]);
  });

  it("prefers the annotation's own url and tolerates a missing target", () => {
    const items = buildImportFileIssueItems(
      [
        makeAnnotation({
          url: "https://app.example/detail",
          targets: undefined,
          images: undefined,
        } as Partial<Annotation>),
      ],
      "https://app.example/page",
    );
    expect(items[0]!.url).toBe("https://app.example/detail");
    expect(items[0]!.where).toEqual({ selector: undefined, text: undefined });
    expect(items[0]!.hasImages).toBe(false);
  });

  it("caps nearby text at 200 chars", () => {
    const items = buildImportFileIssueItems(
      [
        makeAnnotation({
          targets: [
            {
              selector: "#x",
              outerHTML: "",
              computedStyles: {},
              nearbyText: ["y".repeat(500)],
              boundingRect: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        }),
      ],
      "https://a.b",
    );
    expect(items[0]!.where.text!.length).toBe(200);
  });

  it("caps a giant comment with a visible truncation marker (token bomb guard)", () => {
    const big = "x".repeat(IMPORT_ISSUE_COMMENT_CAP + 5000);
    const items = buildImportFileIssueItems(
      [makeAnnotation({ comment: big })],
      "https://a.b",
    );
    const c = items[0]!.comment;
    expect(c.length).toBe(IMPORT_ISSUE_COMMENT_CAP + "…[truncated]".length);
    expect(c.endsWith("…[truncated]")).toBe(true);
    expect(c.startsWith("xxx")).toBe(true);
  });

  it("leaves a comment at the cap untouched", () => {
    const exact = "x".repeat(IMPORT_ISSUE_COMMENT_CAP);
    const items = buildImportFileIssueItems(
      [makeAnnotation({ comment: exact })],
      "https://a.b",
    );
    expect(items[0]!.comment).toBe(exact);
  });
});

describe("parseImportedIssuesFiled", () => {
  const NOW = 1_700_000_000_000;

  it("returns null for malformed JSON, wrong type, or missing results", () => {
    expect(parseImportedIssuesFiled(undefined, NOW)).toBeNull();
    expect(parseImportedIssuesFiled("not json", NOW)).toBeNull();
    expect(
      parseImportedIssuesFiled(JSON.stringify({ type: "other", results: [] }), NOW),
    ).toBeNull();
    expect(
      parseImportedIssuesFiled(
        JSON.stringify({ type: "imported-issues-filed", results: "nope" }),
        NOW,
      ),
    ).toBeNull();
  });

  it("keeps valid rows, skips malformed ones, and sanitizes fields", () => {
    const summary = JSON.stringify({
      type: "imported-issues-filed",
      results: [
        {
          annotationId: "a1",
          target: "gitlab",
          url: "https://gitlab.example/i/1",
          title: "Bug 1",
        },
        { annotationId: "a2", target: "weird", path: ".pinta/tasks.md" },
        // Malformed rows — skipped, not fatal:
        null,
        "string",
        { target: "gitlab" },
        { annotationId: 42 },
        // Unsafe URL — dropped by safeExternalUrl:
        { annotationId: "a3", target: "gitlab", url: "javascript:alert(1)" },
      ],
    });
    const filed = parseImportedIssuesFiled(summary, NOW);
    expect(filed).not.toBeNull();
    expect(Object.keys(filed!).sort()).toEqual(["a1", "a2", "a3"]);
    expect(filed!["a1"]).toEqual({
      target: "gitlab",
      url: "https://gitlab.example/i/1",
      path: undefined,
      title: "Bug 1",
      at: NOW,
    });
    // Unknown target collapses to the local fallback.
    expect(filed!["a2"]!.target).toBe("local");
    expect(filed!["a2"]!.path).toBe(".pinta/tasks.md");
    expect(filed!["a3"]!.url).toBeUndefined();
  });

  it("an empty results list parses to an empty map (agent filed nothing)", () => {
    const filed = parseImportedIssuesFiled(
      JSON.stringify({ type: "imported-issues-filed", results: [] }),
      NOW,
    );
    expect(filed).toEqual({});
  });

  it("a hostile __proto__ annotation id lands as an own property", () => {
    const filed = parseImportedIssuesFiled(
      JSON.stringify({
        type: "imported-issues-filed",
        results: [{ annotationId: "__proto__", target: "local" }],
      }),
      NOW,
    );
    expect(filed).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(filed!, "__proto__")).toBe(true);
    expect(filed!["__proto__"]!.target).toBe("local");
    // And Object.prototype itself was not polluted.
    expect(({} as Record<string, unknown>).target).toBeUndefined();
  });
});
