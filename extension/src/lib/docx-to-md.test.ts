import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  DocxImportError,
  docxPartsToMarkdown,
  docxToMarkdown,
  recoverPintaFrontmatter,
} from "./docx-to-md.js";
import {
  composeResultsDocx,
  composeTesterSheetDocx,
  composeTesterSheetMarkdown,
  parseTestDocMarkdown,
} from "./test-pilot-doc.js";
import { composeFrontmatter, parsePintaResultsMarkdown } from "./test-pilot-md.js";
import type { TestPilotCatalog } from "./state.svelte.js";

// Test Pilot import only read Markdown, so a sheet that came back from
// Google Drive as .docx (Drive converts an uploaded .md into a Google Doc)
// was rejected. These pin the .docx → Markdown reader against the three
// documents it has to cope with: Pinta's own Word exports, a Google Docs
// export of a Pinta .md, and a doc holding un-rendered Markdown.

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:v="urn:schemas-microsoft-com:vml"';
const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`;
const run = (t: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (inner: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
const heading = (t: string, n: number) => para(run(t), `<w:pStyle w:val="Heading${n}"/>`);
const cell = (t: string) => `<w:tc><w:tcPr/>${para(run(t))}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join("")}</w:tr>`;
const numbered = (t: string, numId = 1) => para(run(t), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`);
const NUMBERING = `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;

function catalog(): TestPilotCatalog {
  return {
    docId: "doc-1234",
    filename: "claims-uat.md",
    title: "Claims UAT",
    author: "Mark",
    description: "Thorough pass over the claim form.",
    importedAt: 1,
    sections: [
      {
        title: "1.1 Sign in",
        tests: [
          { id: "AUTH-01", test: "Login with valid credentials", expected: "Lands on the dashboard", status: "pass", detail: { steps: ["Open the login page", "Enter the QA account", "Press Sign in"], askedAt: 1 } },
          { id: "AUTH-02", test: "Wrong password | pipe in text", expected: "Shows an inline error", status: "fail" },
        ],
      },
      {
        title: "1.2 Claim form",
        tests: [{ id: "CLM-01", test: "Date of loss accepts today", expected: "No range error", status: "untested" }],
      },
    ],
  } as TestPilotCatalog;
}

describe("Pinta's own Word exports import back", () => {
  it("tester sheet .docx → same sections, rows and steps", async () => {
    const md = await docxToMarkdown(await composeTesterSheetDocx(catalog()));
    // The export carries the envelope, so it takes the Pinta-file path.
    const parsed = parsePintaResultsMarkdown("claims-uat.md", md)!.catalog;
    expect(parsed.docId).toBe("doc-1234");
    expect(parsed.title).toBe("Claims UAT");
    expect(parsed.author).toBe("Mark");
    expect(parsed.sections.map((s) => s.title)).toEqual(["1.1 Sign in", "1.2 Claim form"]);
    expect(parsed.sections[0]!.tests.map((t) => t.id)).toEqual(["AUTH-01", "AUTH-02"]);
    expect(parsed.sections[0]!.tests[1]!.test).toBe("Wrong password | pipe in text");
    expect(parsed.sections[0]!.tests[0]!.detail?.steps).toEqual([
      "Open the login page",
      "Enter the QA account",
      "Press Sign in",
    ]);
    // The tester-instructions paragraph is not mistaken for the description.
    expect(parsed.description).toBe("Thorough pass over the claim form.");
  });

  it("results .docx → Pass / Fail marks survive", async () => {
    const md = await docxToMarkdown(await composeResultsDocx(catalog(), "2026-10-08"));
    const parsed = parsePintaResultsMarkdown("claims-uat.md", md)!.catalog;
    expect(parsed.docId).toBe("doc-1234");
    const status = Object.fromEntries(parsed.sections.flatMap((s) => s.tests).map((t) => [t.id, t.status]));
    expect(status).toEqual({ "AUTH-01": "pass", "AUTH-02": "fail", "CLM-01": "untested" });
  });
});

describe("Google Docs export of a Pinta .md", () => {
  // Drive turns `---\nkey: v\nkey: v\n---` into a horizontal rule plus
  // ONE Heading 2 holding every key, then real headings / tables / lists.
  const googleDoc = doc(
    para(`<w:r><w:pict><v:rect o:hr="t"/></w:pict></w:r>`) +
      heading("pinta-test-pilot: 1 doc-id: 7f3c-uuid scope: plan:Sprint 12 tester: Jeremy Cruz email: jeremy@example.test date: 2026-10-08 environment: UAT run-type: Thorough notes: build 0.10.0, two blockers", 2) +
      heading("Claims UAT", 1) +
      para(run("By Mark", "<w:i/>")) +
      heading("1.1 Sign in", 2) +
      `<w:tbl><w:tblPr/>${row("ID", "Test", "Expected Result", "Result", "Rev")}${row("AUTH-01", "Login with valid credentials", "Lands on the dashboard", "✓ Pass", "2")}${row("AUTH-02", "Wrong password", "Shows an inline error", "✗ Fail", "")}</w:tbl>` +
      heading("Steps", 3) +
      heading("AUTH-01 — Login with valid credentials", 4) +
      numbered("Open the login page") +
      numbered("Press Sign in"),
  );

  it("rebuilds the frontmatter envelope so the doc-id and sign-off come back", () => {
    const md = docxPartsToMarkdown({ document: googleDoc, numbering: NUMBERING });
    expect(md.startsWith("---\npinta-test-pilot: 1\ndoc-id: 7f3c-uuid\n")).toBe(true);
    const out = parsePintaResultsMarkdown("claims-uat.md", md)!;
    expect(out).not.toBeNull();
    expect(out.catalog.docId).toBe("7f3c-uuid");
    expect(out.scope).toBe("plan:Sprint 12");
    expect(out.signoff).toEqual({
      tester: "Jeremy Cruz",
      email: "jeremy@example.test",
      date: "2026-10-08",
      environment: "UAT",
      runType: "Thorough",
      notes: "build 0.10.0, two blockers",
    });
    expect(out.catalog.title).toBe("Claims UAT");
    expect(out.catalog.author).toBe("Mark");
    const tests = out.catalog.sections[0]!.tests;
    expect(tests.map((t) => [t.id, t.status])).toEqual([
      ["AUTH-01", "pass"],
      ["AUTH-02", "fail"],
    ]);
    expect(tests[0]!.lastChangedRev).toBe(2);
    expect(tests[0]!.detail?.steps).toEqual(["Open the login page", "Press Sign in"]);
  });

  it("a real Pinta tester sheet survives the same trip", () => {
    // Model the conversion from the Markdown Pinta actually writes, so the
    // test follows the exporter instead of a hand-typed fixture.
    const c = catalog();
    const sheet = composeFrontmatter(c.docId) + composeTesterSheetMarkdown(c);
    expect(parsePintaResultsMarkdown("x.md", sheet)!.catalog.docId).toBe("doc-1234");
    const md = docxPartsToMarkdown({
      document: doc(
        para(`<w:r><w:pict><v:rect o:hr="t"/></w:pict></w:r>`) +
          heading("pinta-test-pilot: 1 doc-id: doc-1234", 2) +
          heading("Claims UAT", 1) +
          heading("1.1 Sign in", 2) +
          `<w:tbl>${row("ID", "Test", "Expected Result", "Result")}${row("AUTH-01", "Login with valid credentials", "Lands on the dashboard", "")}</w:tbl>`,
      ),
    });
    expect(parsePintaResultsMarkdown("x.md", md)!.catalog.docId).toBe("doc-1234");
  });
});

describe("other Word documents", () => {
  it("a doc holding un-rendered Markdown reads back as that Markdown", () => {
    const lines = ["---", "pinta-test-pilot: 1", "doc-id: raw-1", "---", "# Raw sheet", "## Section A", "| ID | Test | Expected Result | Result |", "|----|------|-----------------|--------|", "| A-1 | Do a thing | It works | ✓ Pass |"];
    const md = docxPartsToMarkdown({ document: doc(lines.map((l) => para(run(l))).join("")) });
    const out = parsePintaResultsMarkdown("raw.md", md)!;
    expect(out.catalog.docId).toBe("raw-1");
    expect(out.catalog.sections[0]!.tests[0]).toMatchObject({ id: "A-1", status: "pass" });
  });

  it("a Title style becomes the # title and Heading 1 the sections", () => {
    const md = docxPartsToMarkdown({
      document: doc(
        para(run("Release test plan"), `<w:pStyle w:val="Title"/>`) +
          heading("Checkout", 1) +
          `<w:tbl>${row("ID", "Test", "Expected Result", "Result")}${row("CO-1", "Pay by card", "Order placed", "")}</w:tbl>`,
      ),
    });
    expect(md).toContain("# Release test plan");
    expect(md).toContain("## Checkout");
    expect(parseTestDocMarkdown("plan.md", md)!.sections[0]!.title).toBe("Checkout");
  });

  it("inline formatting, split runs, links, bullets and localized heading styles", () => {
    const md = docxPartsToMarkdown({
      styles: `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/></w:style></w:styles>`,
      rels: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="x" Target="https://example.test/spec" TargetMode="External"/><Relationship Id="rId6" Type="x" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`,
      numbering: NUMBERING,
      document: doc(
        para(run("Plano"), `<w:pStyle w:val="Ttulo1"/>`) +
          para(run("Ex", "<w:b/>") + run("pected ", "<w:b/>") + run("result &amp; ") + run("npm test", `<w:rFonts w:ascii="Courier New"/>`)) +
          para(`<w:hyperlink r:id="rId5">${run("the spec")}</w:hyperlink>${run(" and ")}<w:hyperlink r:id="rId6">${run("a bad link")}</w:hyperlink>`) +
          numbered("First bullet", 2) +
          numbered("Second bullet", 2) +
          para(`<w:del>${run("deleted text")}</w:del>${run("kept text")}`),
      ),
    });
    expect(md).toContain("# Plano");
    expect(md).toContain("**Expected** result & `npm test`");
    expect(md).toContain("[the spec](https://example.test/spec) and a bad link");
    expect(md).not.toContain("javascript:");
    expect(md).toContain("- First bullet\n- Second bullet");
    expect(md).toContain("kept text");
    expect(md).not.toContain("deleted text");
  });
});

describe("recoverPintaFrontmatter", () => {
  it("leaves an intact envelope and plain documents alone", () => {
    const intact = "---\npinta-test-pilot: 1\ndoc-id: a\n---\n\n# T\n";
    expect(recoverPintaFrontmatter(intact)).toBe(intact);
    const plain = "# Just a plan\n\n## Section\n";
    expect(recoverPintaFrontmatter(plain)).toBe(plain);
    const noMarker = "---\n\n## tester: someone\n\n# Title\n";
    expect(recoverPintaFrontmatter(noMarker)).toBe(noMarker);
  });
});

describe("files that aren't readable .docx", () => {
  it("rejects non-zip bytes, zips without a body, and damaged zips with a plain message", async () => {
    await expect(docxToMarkdown(strToU8("# not a docx"))).rejects.toBeInstanceOf(DocxImportError);
    await expect(docxToMarkdown(zipSync({ "hello.txt": strToU8("hi") }))).rejects.toThrow(/no document body/);
    const damaged = zipSync({ "word/document.xml": strToU8(doc(para(run("x")))) }).slice(0, 40);
    await expect(docxToMarkdown(damaged)).rejects.toBeInstanceOf(DocxImportError);
    await expect(docxToMarkdown(zipSync({ "word/document.xml": strToU8(doc("")) }))).rejects.toThrow(/no readable text/);
  });
});

// ── Review findings (2026-10-08) ──────────────────────────────────────

describe("Pinta's Word exports carry the envelope", () => {
  it("results .docx comes back with its doc-id, sign-off and scope", async () => {
    const signoff = { tester: "Jeremy Cruz", email: "jeremy@example.test", date: "2026-10-08", environment: "UAT_2", runType: "Thorough", notes: "tester said date: tomorrow, environment: staging was down" };
    const md = await docxToMarkdown(await composeResultsDocx(catalog(), "2026-10-08", signoff, "plan:Sprint 12"));
    const out = parsePintaResultsMarkdown("r.md", md)!;
    expect(out).not.toBeNull();
    expect(out.catalog.docId).toBe("doc-1234");
    expect(out.scope).toBe("plan:Sprint 12");
    // Values that contain "date:" / "environment:" stay whole, and the
    // underscore in the environment survives.
    expect(out.signoff).toEqual({ tester: "Jeremy Cruz", email: "jeremy@example.test", date: "2026-10-08", environment: "UAT_2", runType: "Thorough", notes: signoff.notes });
    const status = Object.fromEntries(out.catalog.sections.flatMap((s) => s.tests).map((t) => [t.id, t.status]));
    expect(status).toEqual({ "AUTH-01": "pass", "AUTH-02": "fail", "CLM-01": "untested" });
  });

  it("tester sheet .docx comes back with its doc-id", async () => {
    const md = await docxToMarkdown(await composeTesterSheetDocx({ ...catalog(), docId: "my_doc_id-9" }));
    expect(parsePintaResultsMarkdown("t.md", md)!.catalog.docId).toBe("my_doc_id-9");
  });
});

describe("envelope recovery edge cases", () => {
  const hr = para(`<w:r><w:pict><v:rect o:hr="t"/></w:pict></w:r>`);
  it("a horizontal rule later in the document does not hide the mangled envelope", () => {
    const md = docxPartsToMarkdown({
      document: doc(
        hr + heading("pinta-test-pilot: 1 doc-id: 7f3c-uuid", 2) + heading("Sheet", 1) + heading("Sec", 2) +
          `<w:tbl>${row("ID", "Test", "Expected Result", "Result")}${row("A-1", "Do", "Works", "")}</w:tbl>` + hr + para(run("footer")),
      ),
    });
    expect(parsePintaResultsMarkdown("x.md", md)!.catalog.docId).toBe("7f3c-uuid");
  });

  it("keys are read in Pinta's order, so a capitalised or out-of-order word stays in its value", () => {
    const md = recoverPintaFrontmatter("## pinta-test-pilot: 1 doc-id: d1 tester: QA Scope: Team date: 2026-10-08\n\n# T\n");
    expect(md).toContain("tester: QA Scope: Team\n");
    expect(md).toContain("date: 2026-10-08\n");
    expect(md).not.toContain("\nscope:");
  });
});

describe("headings and lists", () => {
  it("Pinta-style bold headings are still found when every paragraph names the Normal style", () => {
    const normal = `<w:pStyle w:val="Normal"/>`;
    const md = docxPartsToMarkdown({
      document: doc(
        para(run("Claims UAT", `<w:b/><w:sz w:val="36"/>`), normal) +
          para(run("1.1 Sign in", `<w:b/><w:sz w:val="30"/>`), normal) +
          `<w:tbl>${row("ID", "Test", "Expected Result", "Result")}${row("A-1", "Do", "Works", "")}</w:tbl>`,
      ),
    });
    expect(parseTestDocMarkdown("x.md", md)!.sections[0]!.title).toBe("1.1 Sign in");
  });

  it("a document with real heading styles keeps bold lead-ins as bold text", () => {
    const md = docxPartsToMarkdown({
      document: doc(
        heading("Plan", 1) +
          para(run("Expected result:", `<w:b/><w:sz w:val="24"/>`)) +
          para(run("2024-10-08", `<w:b/><w:sz w:val="22"/>`)) +
          para(run("By clicking Submit the user accepts the terms.")),
      ),
    });
    expect(md).toContain("**Expected result:**");
    expect(md).toContain("**2024-10-08**");
    expect(md).not.toMatch(/^#{2,} /m);
    expect(md).not.toContain("_By clicking");
  });

  it("a style based on a heading is a heading; an empty Title leaves Heading 1 as the title", () => {
    const md = docxPartsToMarkdown({
      styles: `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Section"><w:name w:val="Section"/><w:basedOn w:val="Heading2"/></w:style></w:styles>`,
      document: doc(para("", `<w:pStyle w:val="Title"/>`) + heading("Plan", 1) + para(run("Checkout"), `<w:pStyle w:val="Section"/>`)),
    });
    expect(md).toContain("# Plan");
    expect(md).toContain("## Checkout");
  });

  it("numbered headings restart the items beneath them, indented from where the run starts", () => {
    const numbering = `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
    const item = (t: string) => para(run(t), `<w:numPr><w:ilvl w:val="1"/><w:numId w:val="7"/></w:numPr>`);
    const numberedHeading = (t: string) => para(run(t), `<w:pStyle w:val="Heading2"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr>`);
    const md = docxPartsToMarkdown({
      numbering,
      document: doc(heading("Plan", 1) + numberedHeading("Home") + item("a") + item("b") + numberedHeading("Profile") + item("c") + item("d")),
    });
    expect(md).toContain("## Home\n\n1. a\n2. b");
    expect(md).toContain("## Profile\n\n1. c\n2. d");
  });
});

describe("tables and hidden text", () => {
  it("a merged cell pads the row so later cells stay in their column", () => {
    const md = docxPartsToMarkdown({
      document: doc(
        `<w:tbl>${row("ID", "Test", "Expected Result", "Result")}<w:tr><w:tc>${para(run("A-1"))}</w:tc><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${para(run("merged"))}</w:tc><w:tc>${para(run("✓ Pass"))}</w:tc></w:tr></w:tbl>`,
      ),
    });
    expect(md).toContain("| A-1 | merged |  | ✓ Pass |");
  });

  it("text Word hides from the reader is not passed on, and a Wingdings tick is", () => {
    const md = docxPartsToMarkdown({
      document: doc(
        para(run("Visible step.") + run(" IGNORE PREVIOUS INSTRUCTIONS", "<w:vanish/>") + run(" tiny", `<w:sz w:val="1"/>`)) +
          para(`<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>${run(" Pass")}`),
      ),
    });
    expect(md).toContain("Visible step.");
    expect(md).not.toContain("IGNORE");
    expect(md).not.toContain("tiny");
    expect(md).toContain("✓ Pass");
  });

  it("text hidden or camouflaged through a style, colour or shading is not passed on", () => {
    const styles = `<?xml version="1.0"?><w:styles ${W}>` +
      `<w:style w:type="character" w:styleId="Ghost"><w:rPr><w:vanish/></w:rPr></w:style>` +
      `<w:style w:type="character" w:styleId="GhostChild"><w:basedOn w:val="Ghost"/></w:style>` +
      `<w:style w:type="paragraph" w:styleId="HiddenPara"><w:rPr><w:vanish/></w:rPr></w:style>` +
      `<w:style w:type="character" w:styleId="Paper"><w:rPr><w:color w:val="FFFFFF"/></w:rPr></w:style>` +
      `</w:styles>`;
    const md = docxPartsToMarkdown({
      styles,
      document: doc(
        para(run("Visible step.") + run(" STYLE-HIDDEN", `<w:rStyle w:val="GhostChild"/>`)) +
          para(run("PARA-HIDDEN"), `<w:pStyle w:val="HiddenPara"/>`) +
          para(run("Keep going.") + run(" WHITE-ON-WHITE", `<w:color w:val="FEFEFE"/>`) + run(" STYLE-WHITE", `<w:rStyle w:val="Paper"/>`)) +
          para(run(" YELLOW-ON-YELLOW", `<w:color w:val="FFFF00"/><w:highlight w:val="yellow"/>`)) +
          `<w:tbl>${row("ID", "Test")}<w:tr><w:tc><w:tcPr><w:shd w:fill="1F3864"/></w:tcPr>${para(run("Header on navy", `<w:color w:val="FFFFFF"/>`))}</w:tc><w:tc><w:tcPr/>${para(run("NAVY-ON-WHITE") + run(" CELL-CAMO", `<w:color w:val="FFFFFF"/>`))}</w:tc></w:tr></w:tbl>`,
      ),
    });
    expect(md).toContain("Visible step.");
    expect(md).toContain("Keep going.");
    for (const hidden of ["STYLE-HIDDEN", "PARA-HIDDEN", "WHITE-ON-WHITE", "STYLE-WHITE", "YELLOW-ON-YELLOW", "CELL-CAMO"]) {
      expect(md).not.toContain(hidden);
    }
    // White text on a dark cell is readable and stays.
    expect(md).toContain("Header on navy");
    expect(md).toContain("NAVY-ON-WHITE");
  });

  it("a document default or default paragraph style that hides text applies to unstyled runs, and a run can unhide", () => {
    const styles = `<?xml version="1.0"?><w:styles ${W}>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:vanish/></w:rPr></w:style></w:styles>`;
    const md = docxPartsToMarkdown({
      styles,
      document: doc(para(run("DEFAULT-HIDDEN") + run(" shown", `<w:vanish w:val="0"/>`))),
    });
    expect(md).not.toContain("DEFAULT-HIDDEN");
    expect(md).toContain("shown");
  });

  it("nested cells, shading patterns and theme colours are judged the way Word paints them", () => {
    const tc = (shd: string, inner: string) => `<w:tc><w:tcPr>${shd}</w:tcPr>${inner}</w:tc>`;
    const md = docxPartsToMarkdown({
      document: doc(
        `<w:tbl>${row("ID", "Test")}<w:tr>${tc("", para(run("N-1")))}${tc(
          `<w:shd w:val="clear" w:fill="000000"/>`,
          `<w:tbl><w:tr>${tc(`<w:shd w:val="clear" w:fill="FFFFFF"/>`, para(run("NESTED-CAMO", `<w:color w:val="FFFFFF"/>`)))}${tc("", para(run("Dark outer", `<w:color w:val="FFFFFF"/>`)))}</w:tr></w:tbl>`,
        )}</w:tr></w:tbl>` +
          para(run("SOLID-WHITE", `<w:color w:val="FFFFFF"/><w:shd w:val="solid" w:color="FFFFFF" w:fill="000000"/>`)) +
          para(run("THEME-PAGE", `<w:color w:val="000000" w:themeColor="background1"/>`)) +
          para(run("Theme text", `<w:color w:val="FFFFFF" w:themeColor="text1"/>`)) +
          para(run("WEB-HIDDEN", `<w:vanish w:val="0"/><w:webHidden/>`)) +
          para(run("On a pattern", `<w:color w:val="FFFFFF"/>`), `<w:shd w:val="pct50" w:color="000000" w:fill="FFFFFF"/>`) +
          para(run("On auto solid", `<w:color w:val="FFFFFF"/>`), `<w:shd w:val="solid" w:color="auto" w:fill="FFFFFF"/>`),
      ),
    });
    for (const hidden of ["NESTED-CAMO", "SOLID-WHITE", "THEME-PAGE", "WEB-HIDDEN"]) expect(md).not.toContain(hidden);
    expect(md).toContain("Dark outer");
    expect(md).toContain("Theme text");
    expect(md).toContain("On a pattern");
    expect(md).toContain("On auto solid");
  });

  it("an explicit paragraph style not based on Normal does not inherit Normal's hiding", () => {
    const styles = `<?xml version="1.0"?><w:styles ${W}>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:vanish/></w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="Plain"/></w:styles>`;
    const md = docxPartsToMarkdown({ styles, document: doc(para(run("Styled plain"), `<w:pStyle w:val="Plain"/>`)) });
    expect(md).toContain("Styled plain");
  });

  it("a link target cannot break out of the Markdown link", () => {
    const md = docxPartsToMarkdown({
      rels: `<?xml version="1.0"?><Relationships xmlns="x"><Relationship Id="r1" Target="https://a.test/) [evil](javascript:alert(2)" TargetMode="External"/></Relationships>`,
      document: doc(para(`<w:hyperlink r:id="r1">${run("x")}</w:hyperlink>`)),
    });
    expect(md.trim()).toBe("[x](https://a.test/%29%20[evil]%28javascript:alert%282%29)");
  });
});

describe("hostile input stays fast", () => {
  it("unterminated comments / processing instructions / CDATA do not go quadratic", () => {
    for (const junk of ["<!--", "<?", "<![CDATA[", "<w:p "]) {
      const t0 = performance.now();
      const xml = doc(para(run("ok"))) + junk.repeat(Math.ceil(400_000 / junk.length));
      expect(docxPartsToMarkdown({ document: xml })).toContain("ok");
      // 256 KB of "<!--" took 18 s with the old regex tokenizer.
      expect(performance.now() - t0, junk).toBeLessThan(1500);
    }
  });

  it("refuses a part over the size cap", async () => {
    const big = strToU8(doc(para(run("x".repeat(9 * 1024 * 1024)))));
    await expect(docxToMarkdown(zipSync({ "word/document.xml": big }))).rejects.toThrow(/too large/);
  });

  it("finds the main part the package points at", async () => {
    const rels = `<?xml version="1.0"?><Relationships xmlns="x"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document2.xml"/></Relationships>`;
    const md = await docxToMarkdown(zipSync({ "_rels/.rels": strToU8(rels), "word/document2.xml": strToU8(doc(heading("Elsewhere", 1))) }));
    expect(md).toContain("# Elsewhere");
  });
});

// ── Verification-pass findings (2026-10-08) ───────────────────────────

describe("Pinta's Word export reads back the same as its Markdown export", () => {
  // The export marks headings with an outline level, so awkward text —
  // a title ending in ":", a very long section name — is still a heading.
  const awkward = (): TestPilotCatalog => {
    const c = catalog();
    c.title = "Release 2.0:";
    c.author = "Mark B. Jr.";
    c.sections[0]!.title = "Login:";
    c.sections[1]!.title = `Claim form: ${"very long section name ".repeat(9).trim()}`;
    c.sections[0]!.tests[0]!.test = "Sign in works: happy path.";
    return c;
  };

  it("tester sheet: same title, author, sections, rows and steps as the .md", async () => {
    const c = awkward();
    const viaMd = parsePintaResultsMarkdown("a.md", composeFrontmatter(c.docId) + composeTesterSheetMarkdown(c))!.catalog;
    const viaDocx = parsePintaResultsMarkdown("a.md", await docxToMarkdown(await composeTesterSheetDocx(c)))!.catalog;
    const shape = (x: TestPilotCatalog) => ({
      docId: x.docId,
      title: x.title,
      author: x.author,
      sections: x.sections.map((s) => ({ title: s.title, tests: s.tests.map((t) => [t.id, t.test, t.expected, t.detail?.steps ?? []]) })),
    });
    expect(shape(viaDocx)).toEqual(shape(viaMd));
    expect(viaDocx.sections.map((s) => s.title)).toEqual(["Login:", c.sections[1]!.title]);
  });

  it("an envelope value may contain a later key: one key per line keeps it whole", async () => {
    const signoff = { tester: "Ann date: x", email: "ann@example.test", date: "2026-10-08", environment: "UAT", runType: "Thorough", notes: "see scope: all" };
    const out = parsePintaResultsMarkdown("r.md", await docxToMarkdown(await composeResultsDocx({ ...catalog(), docId: "abc" }, "2026-10-08", signoff, "plan:Release notes: v2")))!;
    expect(out.catalog.docId).toBe("abc");
    expect(out.scope).toBe("plan:Release notes: v2");
    expect(out.signoff).toEqual({ tester: "Ann date: x", email: "ann@example.test", date: "2026-10-08", environment: "UAT", runType: "Thorough", notes: "see scope: all" });
  });

  it("a failure note's repro steps are not read back as the test's how-to steps", async () => {
    const c = catalog();
    c.sections[0]!.tests[1]!.failNotes = [{ id: "n1", description: "Error never clears", steps: "Go to Login Page\nLook at the field", at: 1 }] as never;
    const md = await docxToMarkdown(await composeResultsDocx(c, "2026-10-08"));
    expect(md).toContain("### Failure notes");
    expect(md).toContain("> 1. Go to Login Page");
    const parsed = parsePintaResultsMarkdown("r.md", md)!.catalog;
    expect(parsed.sections[0]!.tests.find((t) => t.id === "AUTH-02")!.detail).toBeUndefined();
  });

  it("an export from before the outline level (bold sizes only) still imports", () => {
    const old = (t: string, sz: number) => para(run(t, `<w:b/><w:sz w:val="${sz}"/>`));
    const md = docxPartsToMarkdown({
      document: doc(
        old("Claims UAT", 36) + para(run("By Mark")) + old("1.1 Sign in", 30) +
          `<w:tbl>${row("ID", "Test", "Expected Result", "Result")}${row("AUTH-01", "Login", "Dashboard", "✓ Pass")}</w:tbl>` +
          old("Steps", 26) + old("AUTH-01 — Login", 22) + para(run("1. Open the login page")),
      ),
    });
    const parsed = parseTestDocMarkdown("old.md", md)!;
    expect(parsed.author).toBe("Mark");
    expect(parsed.sections[0]!.tests[0]).toMatchObject({ id: "AUTH-01", status: "pass" });
    expect(parsed.sections[0]!.tests[0]!.detail?.steps).toEqual(["Open the login page"]);
  });

  it("one real heading style added by a tester does not hide the export's own headings", async () => {
    const xml = await (async () => {
      const { unzipSync, strFromU8 } = await import("fflate");
      return strFromU8(unzipSync(await composeTesterSheetDocx(catalog()))["word/document.xml"]!);
    })();
    const withNote = xml.replace("</w:body>", `${heading("Tester remarks", 2)}${para(run("All good."))}</w:body>`);
    const out = parsePintaResultsMarkdown("t.md", docxPartsToMarkdown({ document: withNote }))!;
    expect(out.catalog.docId).toBe("doc-1234");
    expect(out.catalog.sections.map((s) => s.title)).toEqual(["1.1 Sign in", "1.2 Claim form", "Tester remarks"]);
  });
});

describe("mixed and odd documents", () => {
  it("a styled Title with unstyled 14pt bold section lines still gets sections", () => {
    const md = docxPartsToMarkdown({
      document: doc(
        para(run("Release plan"), `<w:pStyle w:val="Title"/>`) +
          para(run("Checkout", `<w:b/><w:sz w:val="28"/>`)) +
          `<w:tbl>${row("ID", "Test", "Expected Result", "Result")}${row("CO-1", "Pay by card", "Order placed", "")}</w:tbl>`,
      ),
    });
    expect(parseTestDocMarkdown("p.md", md)!.sections[0]!.title).toBe("Checkout");
  });

  it('w:val="off" is off, and a run with no size is not treated as tiny', () => {
    const md = docxPartsToMarkdown({
      document: doc(para(run("shown", `<w:vanish w:val="off"/><w:b w:val="off"/>`) + run(" also shown", `<w:sz w:val=""/>`))),
    });
    expect(md.trim()).toBe("shown also shown");
  });

  it("a by-line ending in a full stop is still the author", () => {
    const md = docxPartsToMarkdown({ document: doc(heading("Plan", 1) + para(run("By Mark B. Jr.")) + heading("Sec", 2)) });
    expect(md).toContain("_By Mark B. Jr._");
  });
});

describe("crafted input stays linear", () => {
  const timed = (label: string, xml: string, parts: { numbering?: string } = {}) => {
    const t0 = performance.now();
    docxPartsToMarkdown({ document: xml, ...parts });
    expect(performance.now() - t0, label).toBeLessThan(2500);
  };

  it("a huge unquoted attribute blob", () => {
    // 80k chars took 11 s with the attribute regex.
    timed("attrs", doc(`<w:p ${"a".repeat(200_000)}=>${run("x")}</w:p>`));
  });

  it("a long run of spaces in a heading, a cell and a bold run", () => {
    // 80k spaces took 9 s with the /\s*\n\s*/ replaces.
    const gap = " ".repeat(200_000);
    timed("heading", doc(heading(`a${gap}b`, 1)));
    timed("cell", doc(`<w:tbl>${row(`a${gap}b`, "x")}</w:tbl>`));
    timed("bold", doc(para(run(`${gap}a${gap}`, "<w:b/>"))));
  });

  it("thousands of list items each with its own list id", () => {
    // 20k items took 56 s when every item scanned every counter.
    let body = "";
    for (let i = 1; i <= 20_000; i++) body += para(run("x"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${i}"/></w:numPr>`);
    timed("lists", doc(body));
  });
});

describe("zip caps don't refuse honest files", () => {
  it("a stored (uncompressed) body larger than the compressed cap still imports", async () => {
    const xml = doc(heading("Big", 1) + para(run("y".repeat(3 * 1024 * 1024))));
    const md = await docxToMarkdown(zipSync({ "word/document.xml": [strToU8(xml), { level: 0 }] }));
    expect(md.startsWith("# Big")).toBe(true);
  });

  it("an oversized optional part is skipped, not fatal", async () => {
    const styles = `<?xml version="1.0"?><w:styles ${W}><!-- ${"s".repeat(9 * 1024 * 1024)} --></w:styles>`;
    const md = await docxToMarkdown(zipSync({ "word/document.xml": strToU8(doc(heading("Fine", 1))), "word/styles.xml": strToU8(styles) }));
    expect(md).toContain("# Fine");
  });
});

// ── Final-pass findings (2026-10-08) ──────────────────────────────────

describe("rules that only apply to Pinta exports stay out of ordinary documents", () => {
  const table = `<w:tbl>${row("ID", "Test", "Expected Result", "Result")}${row("L-1", "Login", "Dashboard", "")}</w:tbl>`;

  it("a styled document's big bold callouts and cover words are not headings", () => {
    const big = (t: string, sz: number) => para(run(t, `<w:b/><w:sz w:val="${sz}"/>`));
    const md = docxPartsToMarkdown({
      document: doc(big("CONFIDENTIAL", 36) + heading("Plan", 1) + heading("Login", 2) + big("IMPORTANT: use the VPN.", 28) + table),
    });
    expect(md).toContain("**CONFIDENTIAL**");
    expect(md).toContain("**IMPORTANT: use the VPN.**");
    const parsed = parseTestDocMarkdown("p.md", md)!;
    expect(parsed.title).toBe("Plan");
    expect(parsed.sections.map((s) => [s.title, s.tests.length])).toEqual([["Login", 1]]);
  });

  it("an outline level on a caption in a styled document is not a section", () => {
    const md = docxPartsToMarkdown({
      document: doc(heading("Plan", 1) + heading("Login", 2) + para(run("Figure 1: the login page"), `<w:pStyle w:val="Caption"/><w:outlineLvl w:val="1"/>`) + table),
    });
    expect(md).not.toContain("## Figure 1");
    expect(parseTestDocMarkdown("p.md", md)!.sections.map((s) => [s.title, s.tests.length])).toEqual([["Login", 1]]);
  });

  it('"Failure notes" in someone else\'s document is just a heading', () => {
    const md = docxPartsToMarkdown({
      numbering: NUMBERING,
      document: doc(para(run("Plan"), `<w:pStyle w:val="Title"/>`) + heading("Failure notes", 2) + numbered("first") + numbered("second")),
    });
    expect(md).toContain("### Failure notes\n\n1. first\n2. second");
    expect(md).not.toContain("> ");
  });

  it("a sentence that starts with By is not the author", () => {
    const md = docxPartsToMarkdown({ document: doc(heading("Plan", 1) + para(run("By default all tests need VPN.")) + heading("Sec", 2)) });
    expect(md).not.toContain("_By default");
    const named = docxPartsToMarkdown({ document: doc(heading("Plan", 1) + para(run("By Ana de la Cruz")) + heading("Sec", 2)) });
    expect(named).toContain("_By Ana de la Cruz_");
  });
});

describe("hand-edited envelope lines", () => {
  it("several keys packed onto one line fall back to the ordered read", () => {
    const a = recoverPintaFrontmatter("pinta-test-pilot: 1 doc-id: d1\ntester: Jo date: 2026-10-08\n\n# T\n");
    expect(a.startsWith("---\npinta-test-pilot: 1\ndoc-id: d1\ntester: Jo\ndate: 2026-10-08\n---\n")).toBe(true);
    const b = recoverPintaFrontmatter("pinta-test-pilot: 1\ndoc-id: d1 tester: Jo\n\n# T\n");
    expect(b.startsWith("---\npinta-test-pilot: 1\ndoc-id: d1\ntester: Jo\n---\n")).toBe(true);
  });
});

describe("a list with a crafted number of levels", () => {
  it("60,000 items over 60,000 declared levels converts in linear time", () => {
    // Took 38 s when every item walked every level's counter.
    let lvls = "";
    let body = "";
    for (let i = 0; i < 60_000; i++) {
      lvls += `<w:lvl w:ilvl="${i}"><w:numFmt w:val="decimal"/></w:lvl>`;
      body += para(run("x"), `<w:numPr><w:ilvl w:val="${i}"/><w:numId w:val="1"/></w:numPr>`);
    }
    const numbering = `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0">${lvls}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
    const t0 = performance.now();
    const md = docxPartsToMarkdown({ document: doc(body), numbering });
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(md.split("\n").length).toBeGreaterThan(50_000);
  });
});
