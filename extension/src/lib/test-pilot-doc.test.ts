import { describe, expect, it } from "vitest";
import {
  composeTestDocMarkdown,
  composeTesterSheetDocx,
  composeTesterSheetMarkdown,
  nextUserTestId,
  parseTestDocMarkdown,
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

describe("composeTesterSheetMarkdown + parseTestDocMarkdown round-trip", () => {
  const richCatalog = (): TestPilotCatalog =>
    makeCatalog({
      title: "Claim Form UAT",
      author: "Mark",
      description: "Test pass against the staging branch.",
      sections: [
        {
          title: "1.1 Authentication",
          tests: [
            {
              id: "AUTH-01",
              test: "Open a valid claim deep-link",
              expected: "Redirects to email-entry step",
              status: "pass",
              detail: {
                steps: ["Sign in as test user.", "Open `/claim/abc123`."],
                askedAt: 0,
              },
            },
            {
              id: "AUTH-02",
              test: "Submit a registered email",
              expected: "Generic confirmation",
              status: "untested",
            },
          ],
        },
      ],
    });

  it("emits the tester instructions blockquote + per-section Steps appendix", () => {
    const md = composeTesterSheetMarkdown(richCatalog());
    expect(md).toContain("# Claim Form UAT");
    expect(md).toContain("_By Mark_");
    expect(md).toContain("> **Tester instructions:**");
    expect(md).toContain("## 1.1 Authentication");
    expect(md).toContain("### Steps");
    expect(md).toContain("#### AUTH-01 — Open a valid claim deep-link");
    expect(md).toContain("1. Sign in as test user.");
    expect(md).toContain("#### AUTH-02 — Submit a registered email");
    expect(md).toContain("_(no steps generated yet");
  });

  it("leaves the Result column blank in tester sheets regardless of status", () => {
    const md = composeTesterSheetMarkdown(richCatalog());
    // AUTH-01 is "pass" in the source catalog but must not leak into
    // the tester sheet's Result CELL. The instructions blockquote
    // legitimately mentions "✓ Pass" as guidance, so we assert on
    // the cell shape directly instead of doing a global string scan.
    expect(md).toMatch(/\| AUTH-01 \|[^|]*\|[^|]*\|\s*\|/);
    expect(md).toMatch(/\| AUTH-02 \|[^|]*\|[^|]*\|\s*\|/);
  });

  it("round-trips through parseTestDocMarkdown — steps + structure preserved", () => {
    const md = composeTesterSheetMarkdown(richCatalog());
    const parsed = parseTestDocMarkdown("tester.md", md);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("Claim Form UAT");
    expect(parsed!.author).toBe("Mark");
    expect(parsed!.sections).toHaveLength(1);
    const section = parsed!.sections[0]!;
    expect(section.title).toBe("1.1 Authentication");
    expect(section.tests).toHaveLength(2);
    expect(section.tests[0]!.id).toBe("AUTH-01");
    expect(section.tests[0]!.expected).toContain("Redirects");
    // Status comes back as untested because the tester sheet blanks
    // the Result column — that's the contract.
    expect(section.tests[0]!.status).toBe("untested");
    // Steps survive the round-trip.
    expect(section.tests[0]!.detail?.steps).toEqual([
      "Sign in as test user.",
      "Open `/claim/abc123`.",
    ]);
    // Test 2 has no detail block (skipped per "(no steps generated yet"
    // sentinel).
    expect(section.tests[1]!.detail).toBeUndefined();
  });

  it("recovers Pass/Fail marks from a results-style MD on import", () => {
    const md = [
      "# Claim Form UAT",
      "",
      "## 1.1 Authentication",
      "",
      "| ID | Test | Expected Result | Result |",
      "|----|------|-----------------|--------|",
      "| AUTH-01 | Open deep-link | Redirects | ✓ Pass |",
      "| AUTH-02 | Submit email | Confirmation | ✗ Fail |",
      "",
    ].join("\n");
    const parsed = parseTestDocMarkdown("results.md", md);
    expect(parsed).not.toBeNull();
    expect(parsed!.sections[0]!.tests[0]!.status).toBe("pass");
    expect(parsed!.sections[0]!.tests[1]!.status).toBe("fail");
  });

  it("returns null when the input doesn't look like a Pinta doc", () => {
    expect(parseTestDocMarkdown("readme.md", "Just a regular paragraph.\n"))
      .toBeNull();
    expect(parseTestDocMarkdown("empty.md", "")).toBeNull();
  });
});

describe("composeTesterSheetDocx", () => {
  it("produces a non-empty zip with a PK header", () => {
    const bytes = composeTesterSheetDocx(
      makeCatalog({
        title: "Smoke",
        sections: [
          {
            title: "1.1",
            tests: [
              { id: "T-1", test: "x", expected: "y", status: "untested" },
            ],
          },
        ],
      }),
    );
    expect(bytes.length).toBeGreaterThan(200);
    // All real .docx files are ZIP archives — PK\x03\x04 magic header.
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
  });
});
