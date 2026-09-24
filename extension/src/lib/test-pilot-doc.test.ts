import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  appendRevision,
  composeResultsDocx,
  composeTestDocMarkdown,
  diffCatalogs,
  isEmptyDiff,
  REVISION_LOG_LIMIT,
  composeTesterSheetDocx,
  composeTesterSheetMarkdown,
  nextUserTestId,
  parseTestDocMarkdown,
  selectUnfiledFailures,
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
  it("produces a non-empty zip with a PK header", async () => {
    const bytes = await composeTesterSheetDocx(
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

  it("strips illegal XML control chars so later sections aren't truncated", async () => {
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
    const xml = docxText(await composeTesterSheetDocx(cat));
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

  it("keeps valid astral characters (emoji) intact", async () => {
    const cat = makeCatalog({
      title: "Emoji",
      sections: [
        { title: "S", tests: [{ id: "E-1", test: "rocket 🚀 ok", expected: "✓", status: "untested" }] },
      ],
    });
    const xml = docxText(await composeTesterSheetDocx(cat));
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

  it("produces a valid .docx zip (PK header)", async () => {
    const bytes = await composeResultsDocx(cat, "2026-06-04");
    expect(bytes.length).toBeGreaterThan(200);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("renders the results title, meta tally, and filled Result marks", async () => {
    const xml = docxText(await composeResultsDocx(cat, "2026-06-04"));
    expect(xml).toContain("Test Pilot results — Checkout UAT");
    expect(xml).toContain("Run on 2026-06-04");
    expect(xml).toContain("by QA");
    expect(xml).toContain("1/3 passed, 1 failed, 1 untested");
    // Result column is FILLED (unlike the tester sheet) — all three glyphs.
    expect(xml).toContain("✓ Pass");
    expect(xml).toContain("✗ Fail");
    expect(xml).toContain("⚠ Untested");
  });

  it("includes a Conversations block only for rows with a chat thread", async () => {
    const xml = docxText(await composeResultsDocx(cat, "2026-06-04"));
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

describe("selectUnfiledFailures", () => {
  const failCat = () =>
    makeCatalog({
      sections: [
        {
          title: "1.1 Auth",
          tests: [
            { id: "AUTH-01", test: "Login", expected: "Dashboard", status: "fail" },
            { id: "AUTH-02", test: "Bad PIN", expected: "Error", status: "pass" },
          ],
        },
        {
          title: "1.2 Claims",
          tests: [
            { id: "CLM-01", test: "List", expected: "Rows", status: "fail" },
            { id: "CLM-02", test: "Filter", expected: "Subset", status: "untested" },
          ],
        },
      ],
    });

  it("returns every failed row with its section, skipping pass/untested", () => {
    const out = selectUnfiledFailures(failCat(), {});
    expect(out).toEqual([
      { id: "AUTH-01", section: "1.1 Auth", test: "Login", expected: "Dashboard" },
      { id: "CLM-01", section: "1.2 Claims", test: "List", expected: "Rows" },
    ]);
  });

  it("drops rows that already have an issue filed", () => {
    const out = selectUnfiledFailures(failCat(), { "AUTH-01": { at: 1 } });
    expect(out.map((t) => t.id)).toEqual(["CLM-01"]);
  });

  it("selectedIds narrows to the ticked unfiled failures only", () => {
    const out = selectUnfiledFailures(failCat(), {}, ["CLM-01", "AUTH-02", "GONE-9"]);
    // AUTH-02 passed and GONE-9 doesn't exist — only CLM-01 survives.
    expect(out.map((t) => t.id)).toEqual(["CLM-01"]);
  });

  it("returns [] when nothing is ticked or nothing failed", () => {
    expect(selectUnfiledFailures(failCat(), {}, [])).toEqual([]);
    expect(selectUnfiledFailures(makeCatalog(), {})).toEqual([]);
  });

  it("a filed map with hostile keys doesn't hide real failures", () => {
    // Object.prototype members must not read as "already filed".
    const out = selectUnfiledFailures(failCat(), Object.create(null));
    expect(out).toHaveLength(2);
    const cat = failCat();
    cat.sections[0]!.tests[0]!.id = "constructor";
    expect(selectUnfiledFailures(cat, {}).map((t) => t.id)).toContain("constructor");
  });
});

describe("diffCatalogs", () => {
  const catalogWith = (
    tests: { id: string; test: string; expected?: string }[],
  ) =>
    makeCatalog({
      sections: [
        {
          title: "1.1 Auth",
          tests: tests.map((t) => ({
            id: t.id,
            test: t.test,
            expected: t.expected ?? "ok",
            status: "untested" as const,
          })),
        },
      ],
    });

  it("reports nothing for an identical regenerate", () => {
    const a = catalogWith([{ id: "AUTH-01", test: "login" }]);
    const b = catalogWith([{ id: "AUTH-01", test: "login" }]);
    const diff = diffCatalogs(a, b);
    expect(diff).toEqual({ added: [], changed: [], removed: [] });
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("ignores pure whitespace reflow", () => {
    const a = catalogWith([{ id: "AUTH-01", test: "log  in", expected: "ok" }]);
    const b = catalogWith([{ id: "AUTH-01", test: "log in", expected: " ok " }]);
    expect(isEmptyDiff(diffCatalogs(a, b))).toBe(true);
  });

  it("separates added, reworded and removed rows", () => {
    const a = catalogWith([
      { id: "AUTH-01", test: "login" },
      { id: "AUTH-02", test: "logout" },
    ]);
    const b = catalogWith([
      { id: "AUTH-01", test: "login with SSO" },
      { id: "AUTH-03", test: "reset password" },
    ]);
    expect(diffCatalogs(a, b)).toEqual({
      added: ["AUTH-03"],
      changed: ["AUTH-01"],
      removed: ["AUTH-02"],
    });
  });

  it("treats a missing prior catalog as all-new", () => {
    const b = catalogWith([{ id: "AUTH-01", test: "login" }]);
    expect(diffCatalogs(null, b)).toEqual({
      added: ["AUTH-01"],
      changed: [],
      removed: [],
    });
  });

  it("matches ids across sections, not positions", () => {
    const a = makeCatalog({
      sections: [
        { title: "A", tests: [{ id: "X-1", test: "t", expected: "e", status: "untested" }] },
      ],
    });
    const b = makeCatalog({
      sections: [
        { title: "B", tests: [{ id: "X-1", test: "t", expected: "e", status: "untested" }] },
      ],
    });
    expect(isEmptyDiff(diffCatalogs(a, b))).toBe(true);
  });
});

describe("appendRevision", () => {
  const entry = (rev: number) => ({
    rev,
    at: rev,
    added: [],
    changed: [],
    removed: [],
  });

  it("appends newest last", () => {
    const log = appendRevision(appendRevision(undefined, entry(1)), entry(2));
    expect(log.map((r) => r.rev)).toEqual([1, 2]);
  });

  it("caps the log so storage stays small", () => {
    let log = appendRevision(undefined, entry(1));
    for (let rev = 2; rev <= REVISION_LOG_LIMIT + 5; rev++) {
      log = appendRevision(log, entry(rev));
    }
    expect(log).toHaveLength(REVISION_LOG_LIMIT);
    expect(log[log.length - 1]!.rev).toBe(REVISION_LOG_LIMIT + 5);
  });
});

describe("Rev column round-trip", () => {
  it("writes the last-changed revision and reads it back", () => {
    const md = composeTestDocMarkdown(
      makeCatalog({
        sections: [
          {
            title: "1.1 Auth",
            tests: [
              {
                id: "AUTH-01",
                test: "login",
                expected: "lands on dashboard",
                status: "pass",
                firstSeenRev: 1,
                lastChangedRev: 3,
              },
              {
                id: "AUTH-02",
                test: "logout",
                expected: "back to login",
                status: "untested",
                firstSeenRev: 2,
              },
            ],
          },
        ],
      }),
    );
    expect(md).toContain("| ID | Test | Expected Result | Result | Rev |");
    expect(md).toContain("| AUTH-01 | login | lands on dashboard | ✓ Pass | 3 |");
    expect(md).toContain("| AUTH-02 | logout | back to login |  | 2 |");

    const parsed = parseTestDocMarkdown("uat.md", md)!;
    const rows = parsed.sections[0]!.tests;
    expect(rows[0]!.lastChangedRev).toBe(3);
    expect(rows[1]!.lastChangedRev).toBe(2);
    expect(rows[0]!.status).toBe("pass");
  });

  it("leaves rows from a pre-versioning file unstamped", () => {
    const md = [
      "# UAT",
      "",
      "## 1.1 Auth",
      "",
      "| ID | Test | Expected Result | Result |",
      "|----|------|-----------------|--------|",
      "| AUTH-01 | login | ok | |",
      "",
    ].join(String.fromCharCode(10));
    const parsed = parseTestDocMarkdown("uat.md", md)!;
    expect(parsed.sections[0]!.tests[0]!.lastChangedRev).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 21 gaps — recycled ids, junk Rev cells, [chat] + Rev together,
// escaped pipes through the 5-column table, and the tester sheet's
// silent loss of provenance.
// ─────────────────────────────────────────────────────────────────────

describe("diffCatalogs — an id reused after its row was deleted", () => {
  const one = (id: string, test: string) =>
    makeCatalog({
      sections: [
        {
          title: "1.1 Auth",
          tests: [{ id, test, expected: "ok", status: "untested" as const }],
        },
      ],
    });

  it("a same-regenerate recycle reads as a reword, not add+remove", () => {
    // AUTH-02 used to be "logout"; this regenerate hands the id to a
    // completely unrelated scenario. There is no way to tell the two
    // apart from ids alone, so the row inherits AUTH-02's history.
    const prior = one("AUTH-02", "logout");
    const next = one("AUTH-02", "delete account and purge PII");
    expect(diffCatalogs(prior, next)).toEqual({
      added: [],
      changed: ["AUTH-02"],
      removed: [],
    });
  });

  it("a delete-then-readd across two regenerates does read as added", () => {
    const rev1 = makeCatalog({
      sections: [
        {
          title: "1.1 Auth",
          tests: [
            { id: "AUTH-01", test: "login", expected: "ok", status: "untested" },
            { id: "AUTH-02", test: "logout", expected: "ok", status: "untested" },
          ],
        },
      ],
    });
    const rev2 = one("AUTH-01", "login");
    expect(diffCatalogs(rev1, rev2).removed).toEqual(["AUTH-02"]);
    const rev3 = makeCatalog({
      sections: [
        {
          title: "1.1 Auth",
          tests: [
            { id: "AUTH-01", test: "login", expected: "ok", status: "untested" },
            {
              id: "AUTH-02",
              test: "delete account",
              expected: "ok",
              status: "untested",
            },
          ],
        },
      ],
    });
    expect(diffCatalogs(rev2, rev3)).toEqual({
      added: ["AUTH-02"],
      changed: [],
      removed: [],
    });
  });
});

describe("Rev cell with junk text", () => {
  const rowWithRev = (rev: string) =>
    [
      "# UAT",
      "",
      "## 1.1 Auth",
      "",
      "| ID | Test | Expected Result | Result | Rev |",
      "|----|------|-----------------|--------|-----|",
      `| AUTH-01 | login | ok |  | ${rev} |`,
      "",
    ].join("\n");

  const revOf = (cell: string) =>
    parseTestDocMarkdown("uat.md", rowWithRev(cell))!.sections[0]!.tests[0]!;

  it("non-numeric junk leaves the row unstamped", () => {
    for (const junk of ["n/a", "v3", "TBD", "", "  "]) {
      const row = revOf(junk);
      expect(
        row.firstSeenRev,
        `rev cell ${JSON.stringify(junk)}`,
      ).toBeUndefined();
      expect(row.lastChangedRev).toBeUndefined();
    }
  });

  it("zero and negative revisions are rejected, not stamped", () => {
    expect(revOf("0").lastChangedRev).toBeUndefined();
    expect(revOf("-1").lastChangedRev).toBeUndefined();
  });

  it("a leading-numeric cell is taken at face value (parseInt prefix)", () => {
    // Documents current behaviour: "3 (new)" and "3abc" both read as 3.
    expect(revOf("3 (new)").lastChangedRev).toBe(3);
    expect(revOf("3abc").lastChangedRev).toBe(3);
    // …but a leading non-digit is not salvaged.
    expect(revOf("rev 3").lastChangedRev).toBeUndefined();
  });

  it("a fractional cell truncates rather than rejecting", () => {
    expect(revOf("2.9").lastChangedRev).toBe(2);
  });
});

describe("Result cell carrying [chat] next to a Rev column", () => {
  const parse = (result: string, rev: string) =>
    parseTestDocMarkdown(
      "uat.md",
      [
        "# UAT",
        "",
        "## 1.1 Auth",
        "",
        "| ID | Test | Expected Result | Result | Rev |",
        "|----|------|-----------------|--------|-----|",
        `| AUTH-01 | login | ok | ${result} | ${rev} |`,
        "",
      ].join("\n"),
    )!.sections[0]!.tests[0]!;

  it("keeps the mark and the revision when the exporter appended [chat]", () => {
    const row = parse("✓ Pass [chat]", "4");
    expect(row.status).toBe("pass");
    expect(row.lastChangedRev).toBe(4);
  });

  it("does the same for a failed row", () => {
    const row = parse("✗ Fail [chat]", "7");
    expect(row.status).toBe("fail");
    expect(row.lastChangedRev).toBe(7);
  });

  it("⚠ Untested [chat] stays untested and still carries its revision", () => {
    const row = parse("⚠ Untested [chat]", "2");
    expect(row.status).toBe("untested");
    expect(row.lastChangedRev).toBe(2);
  });
});

describe("escaped pipes through the 5-column doc table", () => {
  it("round-trips pipes in every text cell, including a trailing one", () => {
    const md = composeTestDocMarkdown(
      makeCatalog({
        sections: [
          {
            title: "1.1 Filters",
            tests: [
              {
                id: "FLT-01",
                test: "choose A|B from the picker",
                expected: "grid shows A|B|C",
                status: "fail",
                firstSeenRev: 2,
                lastChangedRev: 5,
              },
              {
                id: "FLT-02",
                // A cell whose text ENDS with a pipe sits flush against
                // the row's own closing delimiter after escaping.
                test: "trailing pipe|",
                expected: "|leading pipe",
                status: "pass",
                firstSeenRev: 5,
                lastChangedRev: 5,
              },
            ],
          },
        ],
      }),
    );
    expect(md).toContain("choose A\\|B from the picker");
    expect(md).toContain("grid shows A\\|B\\|C");

    const rows = parseTestDocMarkdown("uat.md", md)!.sections[0]!.tests;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "FLT-01",
      test: "choose A|B from the picker",
      expected: "grid shows A|B|C",
      status: "fail",
      lastChangedRev: 5,
    });
    expect(rows[1]).toMatchObject({
      id: "FLT-02",
      test: "trailing pipe|",
      expected: "|leading pipe",
      status: "pass",
      lastChangedRev: 5,
    });
  });

  it("a pipe in the id survives the escape and still keys the row", () => {
    const md = composeTestDocMarkdown(
      makeCatalog({
        sections: [
          {
            title: "S",
            tests: [
              {
                id: "A|B-1",
                test: "t",
                expected: "e",
                status: "untested",
                lastChangedRev: 3,
              },
            ],
          },
        ],
      }),
    );
    expect(md).toContain("| A\\|B-1 |");
    const row = parseTestDocMarkdown("uat.md", md)!.sections[0]!.tests[0]!;
    expect(row.id).toBe("A|B-1");
    expect(row.lastChangedRev).toBe(3);
  });
});

describe("composeTesterSheetMarkdown vs the 5-column doc table", () => {
  const catalog = makeCatalog({
    sections: [
      {
        title: "1.1 Auth",
        tests: [
          {
            id: "AUTH-01",
            test: "login",
            expected: "dashboard",
            status: "pass",
            firstSeenRev: 1,
            lastChangedRev: 4,
          },
        ],
      },
    ],
  });

  it("the tester sheet emits four columns with no Rev header", () => {
    const sheet = composeTesterSheetMarkdown(catalog);
    expect(sheet).toContain("| ID | Test | Expected Result | Result |");
    expect(sheet).not.toContain("| Rev |");
  });

  it("the doc table emits five columns with the Rev value filled", () => {
    const doc = composeTestDocMarkdown(catalog);
    expect(doc).toContain("| ID | Test | Expected Result | Result | Rev |");
    expect(doc).toContain("| AUTH-01 | login | dashboard | ✓ Pass | 4 |");
  });

  it("a tester-sheet round trip silently drops the revision stamps", () => {
    // Known gap: the sheet the tester actually edits has no Rev column,
    // so re-importing it as the catalog loses provenance and every
    // "new & changed since vN" scope degrades to revision 1.
    const back = parseTestDocMarkdown(
      "uat.md",
      composeTesterSheetMarkdown(catalog),
    )!;
    const row = back.sections[0]!.tests[0]!;
    expect(row.id).toBe("AUTH-01");
    expect(row.firstSeenRev).toBeUndefined();
    expect(row.lastChangedRev).toBeUndefined();
    // …whereas the doc table keeps them.
    const kept = parseTestDocMarkdown(
      "uat.md",
      composeTestDocMarkdown(catalog),
    )!.sections[0]!.tests[0]!;
    expect(kept.lastChangedRev).toBe(4);
  });

  it("neither composer carries catalog.rev — only per-row stamps", () => {
    const withRev = makeCatalog({ ...catalog, rev: 9, revisions: [] });
    const md = composeTestDocMarkdown(withRev);
    expect(parseTestDocMarkdown("uat.md", md)!.rev).toBeUndefined();
    expect(parseTestDocMarkdown("uat.md", md)!.revisions).toBeUndefined();
  });
});
