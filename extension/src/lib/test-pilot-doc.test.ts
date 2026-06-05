import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  composeResultsDocx,
  composeTestDocMarkdown,
  composeTesterSheetDocx,
  composeTesterSheetMarkdown,
  nextUserTestId,
  parseTestDocMarkdown,
} from "./test-pilot-doc.js";
import type { TestPilotCatalog } from "./state.svelte.js";

/** Pull `word/document.xml` text out of a composed DOCX zip so a test
 *  can assert on the rendered content, not just the PK header. */
function docxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  return strFromU8(files["word/document.xml"]!);
}

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

  it("strips illegal XML control chars so later sections aren't truncated", () => {
    // A form-feed / vertical-tab in an early section's text used to leak
    // into document.xml, making it not well-formed — Word rendered up to
    // that byte and silently dropped every later section. Build the bad
    // chars via fromCharCode so no source-level escape is involved.
    const ff = String.fromCharCode(0x0c); // form-feed
    const vt = String.fromCharCode(0x0b); // vertical tab
    const cat = makeCatalog({
      title: "Multi",
      sections: [
        {
          title: "Section One",
          tests: [
            {
              id: "S1-1",
              test: `tab${vt}order`,
              expected: `reflow${ff}works`,
              status: "untested",
            },
          ],
        },
        { title: "Section Two", tests: [{ id: "S2-1", test: "a", expected: "b", status: "untested" }] },
        { title: "Section Three", tests: [{ id: "S3-1", test: "c", expected: "d", status: "untested" }] },
      ],
    });
    const xml = docxText(composeTesterSheetDocx(cat));
    // No illegal control char survived into the OOXML.
    const illegal = [...xml].filter((c) => {
      const n = c.charCodeAt(0);
      return n < 0x20 && n !== 0x09 && n !== 0x0a && n !== 0x0d;
    });
    expect(illegal).toHaveLength(0);
    // Every section is present — the bad chars must not truncate the doc.
    expect(xml).toContain("Section One");
    expect(xml).toContain("Section Two");
    expect(xml).toContain("Section Three");
  });

  it("keeps valid astral characters (emoji) intact", () => {
    const cat = makeCatalog({
      title: "Emoji",
      sections: [
        { title: "S", tests: [{ id: "E-1", test: "rocket 🚀 ok", expected: "✓", status: "untested" }] },
      ],
    });
    const xml = docxText(composeTesterSheetDocx(cat));
    expect(xml).toContain("🚀");
    expect(xml).toContain("✓");
  });
});

describe("composeResultsDocx", () => {
  const cat = makeCatalog({
    title: "Checkout UAT",
    author: "QA",
    sections: [
      {
        title: "1.1 Cart",
        tests: [
          { id: "C-1", test: "Add item", expected: "Cart shows 1", status: "pass" },
          {
            id: "C-2",
            test: "Remove item",
            expected: "Cart empties",
            status: "fail",
            chat: [
              { id: "m1", role: "user", text: "Why did this fail?" },
              { id: "m2", role: "agent", text: "The **remove** button is a no-op." },
            ],
          },
          { id: "C-3", test: "Apply coupon", expected: "10% off", status: "untested" },
        ],
      },
    ],
  });

  it("produces a valid .docx zip (PK header)", () => {
    const bytes = composeResultsDocx(cat, "2026-06-04");
    expect(bytes.length).toBeGreaterThan(200);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("renders the results title, meta tally, and filled Result marks", () => {
    const xml = docxText(composeResultsDocx(cat, "2026-06-04"));
    expect(xml).toContain("Test Pilot results — Checkout UAT");
    expect(xml).toContain("Run on 2026-06-04");
    expect(xml).toContain("by QA");
    expect(xml).toContain("1/3 passed, 1 failed, 1 untested");
    // Result column is FILLED (unlike the tester sheet) — all three glyphs.
    expect(xml).toContain("✓ Pass");
    expect(xml).toContain("✗ Fail");
    expect(xml).toContain("⚠ Untested");
  });

  it("includes a Conversations block only for rows with a chat thread", () => {
    const xml = docxText(composeResultsDocx(cat, "2026-06-04"));
    expect(xml).toContain("Conversation — C-2");
    expect(xml).toContain("tester: ");
    expect(xml).toContain("agent: ");
    // Markdown emphasis in chat text is stripped for clean Word prose.
    expect(xml).toContain("The remove button is a no-op.");
    expect(xml).not.toContain("**remove**");
    // Rows without chat don't spawn a conversation heading.
    expect(xml).not.toContain("Conversation — C-1");
  });
});
