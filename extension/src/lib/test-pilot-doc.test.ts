import { describe, expect, it } from "vitest";
import {
  composeTestDocMarkdown,
  nextUserTestId,
} from "./test-pilot-doc.js";
import type { TestPilotCatalog } from "./state.svelte.js";

// Hand-rolled minimal catalog shape so we don't have to boot the
// whole state class. The pure helpers only touch the fields they
// document — extra fields are fine to omit.
function makeCatalog(input: Partial<TestPilotCatalog> = {}): TestPilotCatalog {
  return {
    docId: "doc-1",
    filename: "uat.md",
    importedAt: 1_700_000_000_000,
    sections: [],
    ...input,
  } as TestPilotCatalog;
}

describe("nextUserTestId", () => {
  it("returns USER-1 for an empty catalog", () => {
    expect(nextUserTestId(makeCatalog())).toBe("USER-1");
  });

  it("returns USER-1 when no test uses the USER- prefix", () => {
    const cat = makeCatalog({
      sections: [
        {
          title: "1.1 Auth",
          tests: [
            { id: "AUTH-01", test: "x", expected: "y", status: "untested" },
            { id: "AUTH-02", test: "x", expected: "y", status: "untested" },
          ],
        },
      ],
    });
    expect(nextUserTestId(cat)).toBe("USER-1");
  });

  it("returns one above the max existing USER-N across the whole catalog", () => {
    const cat = makeCatalog({
      sections: [
        {
          title: "1.1",
          tests: [
            { id: "USER-3", test: "", expected: "", status: "untested" },
            { id: "AUTH-01", test: "", expected: "", status: "untested" },
          ],
        },
        {
          title: "1.2",
          tests: [
            { id: "USER-7", test: "", expected: "", status: "untested" },
            { id: "USER-2", test: "", expected: "", status: "untested" },
          ],
        },
      ],
    });
    expect(nextUserTestId(cat)).toBe("USER-8");
  });

  it("ignores malformed USER- ids (USER-abc, USER--1, USERX)", () => {
    const cat = makeCatalog({
      sections: [
        {
          title: "1",
          tests: [
            { id: "USER-abc", test: "", expected: "", status: "untested" },
            { id: "USER--1", test: "", expected: "", status: "untested" },
            { id: "USERX-1", test: "", expected: "", status: "untested" },
            { id: "USER-5", test: "", expected: "", status: "untested" },
          ],
        },
      ],
    });
    // Only USER-5 parses; next is USER-6.
    expect(nextUserTestId(cat)).toBe("USER-6");
  });
});

describe("composeTestDocMarkdown", () => {
  it("uses filename as heading when title is empty", () => {
    const md = composeTestDocMarkdown(
      makeCatalog({ filename: "my-spec.md" }),
    );
    expect(md.startsWith("# my-spec.md\n")).toBe(true);
  });

  it("prefers explicit title over filename", () => {
    const md = composeTestDocMarkdown(
      makeCatalog({ title: "Hero spec", filename: "fallback.md" }),
    );
    expect(md.startsWith("# Hero spec\n")).toBe(true);
  });

  it("emits author line + description paragraph when present", () => {
    const md = composeTestDocMarkdown(
      makeCatalog({
        author: "Mark",
        description: "Round-2 UAT for the claims flow.",
      }),
    );
    expect(md).toContain("_By Mark_");
    expect(md).toContain("Round-2 UAT for the claims flow.");
  });

  it("escapes pipes and collapses newlines in test cells", () => {
    const md = composeTestDocMarkdown(
      makeCatalog({
        sections: [
          {
            title: "1.1",
            tests: [
              {
                id: "X|1",
                test: "click | submit\nthen wait",
                expected: "shows | toast",
                status: "untested",
              },
            ],
          },
        ],
      }),
    );
    // Pipe escaped, newline collapsed to space.
    expect(md).toContain("| X\\|1 | click \\| submit then wait | shows \\| toast |");
  });

  it("emits one ## section per catalog section with a table per", () => {
    const md = composeTestDocMarkdown(
      makeCatalog({
        sections: [
          {
            title: "1.1 Auth",
            tests: [
              {
                id: "AUTH-01",
                test: "sign in",
                expected: "lands on /home",
                status: "untested",
              },
            ],
          },
          {
            title: "1.2 List",
            tests: [
              {
                id: "USER-1",
                test: "filter by status",
                expected: "rows filtered",
                status: "untested",
              },
            ],
          },
        ],
      }),
    );
    expect(md).toContain("## 1.1 Auth");
    expect(md).toContain("## 1.2 List");
    expect(md).toContain("| AUTH-01 | sign in | lands on /home |");
    expect(md).toContain("| USER-1 | filter by status | rows filtered |");
    // Standard table header appears once per section (two total).
    const matches = md.match(/\| ID \| Test \| Expected Result \|/g);
    expect(matches?.length).toBe(2);
  });

  it("preserves section + row order verbatim", () => {
    const md = composeTestDocMarkdown(
      makeCatalog({
        sections: [
          {
            title: "B",
            tests: [
              { id: "B-1", test: "", expected: "", status: "untested" },
              { id: "B-2", test: "", expected: "", status: "untested" },
            ],
          },
          {
            title: "A",
            tests: [
              { id: "A-1", test: "", expected: "", status: "untested" },
            ],
          },
        ],
      }),
    );
    // B section appears before A section in the output.
    const bIdx = md.indexOf("## B");
    const aIdx = md.indexOf("## A");
    expect(bIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(bIdx);
    // B-1 row appears before B-2 row.
    expect(md.indexOf("| B-1 |")).toBeLessThan(md.indexOf("| B-2 |"));
  });

  it("returns a single # heading and empty body for a catalog with no sections", () => {
    const md = composeTestDocMarkdown(makeCatalog({ filename: "empty.md" }));
    expect(md).toBe("# empty.md\n\n");
  });
});
