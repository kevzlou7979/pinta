import { describe, expect, it } from "vitest";
import { dataUrlToBlob, itemImageFilename } from "./report-image.js";
import type { ReportItem } from "./report.js";

function item(partial: Partial<ReportItem>): ReportItem {
  return {
    id: "id-1",
    title: "Some work",
    category: "feature",
    source: "git",
    ...partial,
  };
}

describe("itemImageFilename", () => {
  it("uses the ref when present", () => {
    expect(itemImageFilename(item({ ref: "#382" }), "2026-06-29")).toBe(
      "pinta-report-item-2026-06-29-382.png",
    );
  });

  it("slugs the title when there's no ref", () => {
    expect(
      itemImageFilename(
        item({ ref: undefined, title: "Force logout on Send Documents!" }),
        "2026-06-29",
      ),
    ).toBe("pinta-report-item-2026-06-29-force-logout-on-send-documents.png");
  });

  it("humanizes a JSON module title before slugging", () => {
    const name = itemImageFilename(
      item({ ref: undefined, title: '{"type":"audit-discussion"}' }),
      "2026-06-29",
    );
    expect(name).toBe("pinta-report-item-2026-06-29-discussed-an-auditflow-finding.png");
  });

  it("falls back to the id when ref and title are empty", () => {
    expect(
      itemImageFilename(item({ ref: undefined, title: "", id: "abc123" }), "2026-06-29"),
    ).toBe("pinta-report-item-2026-06-29-abc123.png");
  });

  it("caps the slug length", () => {
    const long = "x".repeat(80);
    const name = itemImageFilename(item({ ref: undefined, title: long }), "2026-06-29");
    const slug = name.replace("pinta-report-item-2026-06-29-", "").replace(".png", "");
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe("dataUrlToBlob", () => {
  it("decodes a base64 PNG data URL to a Blob of the right type + size", async () => {
    // 1x1 transparent PNG.
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const blob = dataUrlToBlob(`data:image/png;base64,${b64}`);
    expect(blob.type).toBe("image/png");
    // Decoded length matches the raw bytes (not the base64 string length).
    expect(blob.size).toBe(atob(b64).length);
  });

  it("rejects a non-data URL", () => {
    expect(() => dataUrlToBlob("https://example.com/x.png")).toThrow();
  });
});
