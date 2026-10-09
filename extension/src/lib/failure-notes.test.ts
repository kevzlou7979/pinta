import { describe, it, expect } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import {
  FAILURE_NOTE_LIMITS,
  failureNotesDigest,
  notesForExport,
  renderFailureNotesMarkdown,
  sanitizeFailureNotes,
  sanitizeFailureNotesById,
  splitSteps,
  type FailureNote,
} from "./failure-notes.js";
import {
  composeResultsDocx,
  imageDimensions,
  parseTestDocMarkdown,
  selectUnfiledFailures,
} from "./test-pilot-doc.js";
import { overlayResultsSidecar } from "./test-pilot-md.js";
import { decodePintaFile, encodePintaFile } from "./pinta-file.js";
import type { TestPilotCatalog } from "./state.svelte.js";

// 1×1 PNG.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function note(over: Partial<FailureNote> = {}): FailureNote {
  return {
    id: "n1",
    at: 1_700_000_000_000,
    description: "Stays on the dashboard after Log out.",
    steps: "1. Sign in\n2) Open the user menu\n- Click Log out",
    images: [{ dataUrl: PNG, mediaType: "image/png", name: "logout.png" }],
    ...over,
  };
}

function catalog(): TestPilotCatalog {
  return {
    docId: "doc-1",
    filename: "uat.md",
    importedAt: 0,
    title: "Portal UAT",
    sections: [
      {
        title: "1.1 Authentication",
        tests: [
          { id: "AUTH-05", test: "Deep link without permission", expected: "Unauthorized page", status: "pass" },
          {
            id: "AUTH-06",
            test: "Log out from the user menu",
            expected: "Returns to /login",
            status: "fail",
            failNotes: [note(), note({ id: "n2", description: "Back button re-opens the app.", steps: undefined, images: undefined })],
          },
          { id: "AUTH-07", test: "Forgot password", expected: "Recovery form opens", status: "fail" },
        ],
      },
    ],
  } as TestPilotCatalog;
}

describe("splitSteps", () => {
  it("returns one step per line and drops typed numbering / bullets", () => {
    expect(splitSteps("1. Sign in\n2) Open menu\n\n- Click Log out\n  * Wait")).toEqual([
      "Sign in",
      "Open menu",
      "Click Log out",
      "Wait",
    ]);
    expect(splitSteps(undefined)).toEqual([]);
    expect(splitSteps("  \n ")).toEqual([]);
  });

  it("keeps a step that merely starts with a number", () => {
    expect(splitSteps("3 items appear in the cart")).toEqual(["3 items appear in the cart"]);
  });
});

describe("sanitizeFailureNotes", () => {
  it("keeps well-formed notes and drops malformed ones entry by entry", () => {
    const out = sanitizeFailureNotes([
      note(),
      null,
      "nope",
      { id: "x", at: 1, description: "   " }, // nothing in it
      { description: "No id or time" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: "n1",
      at: 1_700_000_000_000,
      description: "Stays on the dashboard after Log out.",
      steps: "1. Sign in\n2) Open the user menu\n- Click Log out",
      images: [{ dataUrl: PNG, mediaType: "image/png", name: "logout.png" }],
    });
    expect(out[1]!.description).toBe("No id or time");
    expect(out[1]!.id).toBeTruthy();
    expect(typeof out[1]!.at).toBe("number");
  });

  it("drops images that are not PNG/JPEG data URLs (no remote or script URLs reach <img>)", () => {
    const out = sanitizeFailureNotes([
      {
        id: "a",
        at: 1,
        description: "d",
        images: [
          { dataUrl: "https://evil.example/x.png", mediaType: "image/png" },
          { dataUrl: "javascript:alert(1)", mediaType: "image/png" },
          { dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", mediaType: "image/svg+xml" },
          { dataUrl: "data:text/html;base64,PGI+", mediaType: "text/html" },
          { dataUrl: PNG, mediaType: "text/html" },
        ],
      },
    ]);
    expect(out[0]!.images).toEqual([{ dataUrl: PNG, mediaType: "image/png" }]);
  });

  it("caps notes per test, images per note and text length", () => {
    const many = Array.from({ length: 30 }, (_, i) => note({ id: `n${i}` }));
    expect(sanitizeFailureNotes(many)).toHaveLength(FAILURE_NOTE_LIMITS.notesPerTest);
    const big = sanitizeFailureNotes([
      note({
        description: "x".repeat(FAILURE_NOTE_LIMITS.descriptionChars + 50),
        images: Array.from({ length: 9 }, () => ({ dataUrl: PNG, mediaType: "image/png" })),
      }),
    ])[0]!;
    expect(big.description).toHaveLength(FAILURE_NOTE_LIMITS.descriptionChars);
    expect(big.images).toHaveLength(FAILURE_NOTE_LIMITS.imagesPerNote);
  });

  it("re-mints a repeated note id so two notes never move as one", () => {
    const out = sanitizeFailureNotes([note({ id: "a" }), note({ id: "a", description: "second" })]);
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe("a");
    expect(out[1]!.id).not.toBe("a");
    expect(out[1]!.description).toBe("second");
  });

  it("flattens control characters out of an image name (it is printed on one export line)", () => {
    const out = sanitizeFailureNotes([
      note({ images: [{ dataUrl: PNG, mediaType: "image/png", name: "x]_\n\n## Evil\r\n| X-1 | t | e | ✓ Pass |\u2028y" }] }),
    ]);
    const name = out[0]!.images![0]!.name!;
    expect(name).not.toMatch(/[\r\n\u2028]/);
    const md = renderFailureNotesMarkdown([{ id: "A-1", test: "t", status: "fail", failNotes: out }]);
    const doc = `# R\n\n## S\n\n| ID | Test | Expected | Result |\n|----|------|----------|--------|\n| A-1 | t | e | ✗ Fail |\n\n${md}`;
    const parsed = parseTestDocMarkdown("r.md", doc)!;
    expect(parsed.sections.map((x) => x.title)).toEqual(["S"]);
    expect(parsed.sections[0]!.tests.map((t) => t.id)).toEqual(["A-1"]);
  });

  it("the markdown export flattens a raw image name too (notes saved before validation)", () => {
    const md = renderFailureNotesMarkdown([
      { id: "A-1", test: "t", status: "fail", failNotes: [note({ images: [{ dataUrl: PNG, mediaType: "image/png", name: "a\n## Evil" }] })] },
    ]);
    expect(md).toContain("> _[image: a ## Evil]_");
    expect(md).not.toMatch(/^## Evil/m);
  });

  it("never keeps the composer's 'new note' marker as a note id", () => {
    const out = sanitizeFailureNotes([note({ id: "new" })]);
    expect(out[0]!.id).not.toBe("new");
    expect(out[0]!.id.length).toBeGreaterThan(8);
  });

  it("returns [] for anything that is not an array", () => {
    expect(sanitizeFailureNotes(undefined)).toEqual([]);
    expect(sanitizeFailureNotes({ 0: note() })).toEqual([]);
  });

  it("by-id variant leaves out ids with no valid notes and is prototype-safe", () => {
    const out = sanitizeFailureNotesById(
      JSON.parse(`{"AUTH-06":[{"id":"a","at":1,"description":"d"}],"AUTH-07":[{}],"__proto__":[{"id":"p","at":1,"description":"p"}]}`),
    );
    expect(Object.keys(out).sort()).toEqual(["AUTH-06", "__proto__"]);
    expect(({} as Record<string, unknown>)["AUTH-06"]).toBeUndefined();
    expect(sanitizeFailureNotesById([note()])).toEqual({});
  });
});

describe("notesForExport", () => {
  it("only a failed row's notes are exported", () => {
    expect(notesForExport({ status: "fail", failNotes: [note()] })).toHaveLength(1);
    expect(notesForExport({ status: "pass", failNotes: [note()] })).toEqual([]);
    expect(notesForExport({ status: "untested", failNotes: [note()] })).toEqual([]);
    expect(notesForExport({ status: "fail" })).toEqual([]);
  });
});

describe("renderFailureNotesMarkdown", () => {
  const md = renderFailureNotesMarkdown(catalog().sections[0]!.tests);

  it("names each note with the test id and title, numbered when there are several", () => {
    expect(md).toContain("**Failure notes**");
    expect(md).toContain("**Failure note — AUTH-06 · Log out from the user menu** (1 of 2)");
    expect(md).toContain("**Failure note — AUTH-06 · Log out from the user menu** (2 of 2)");
    expect(md).not.toContain("AUTH-05");
    expect(md).not.toContain("AUTH-07"); // failed, but no notes
  });

  it("writes the description, renumbered steps and an image placeholder", () => {
    expect(md).toContain("> Stays on the dashboard after Log out.");
    expect(md).toContain("> **Steps to reproduce:**\n> 1. Sign in\n> 2. Open the user menu\n> 3. Click Log out");
    expect(md).toContain("> _[image: logout.png]_");
    expect(md).not.toContain("base64");
  });

  it("is empty when no failed row has notes", () => {
    expect(renderFailureNotesMarkdown([{ id: "A", test: "t", status: "pass", failNotes: [note()] }])).toBe("");
  });

  it("survives re-import: note text is never read as a table row, heading or step", () => {
    const hostile = renderFailureNotesMarkdown([
      {
        id: "AUTH-06",
        test: "Log out",
        status: "fail",
        failNotes: [note({ description: "| X-1 | injected | row | ✓ Pass |\n## Fake section\n#### AUTH-06 — x", steps: "1. step one" })],
      },
    ]);
    const doc =
      `# Results\n\n## 1.1 Authentication\n\n| ID | Test | Expected | Result |\n|----|------|----------|--------|\n` +
      `| AUTH-06 | Log out | Returns to login | ✗ Fail [notes] |\n\n${hostile}`;
    const parsed = parseTestDocMarkdown("r.md", doc)!;
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.tests.map((t) => t.id)).toEqual(["AUTH-06"]);
    expect(parsed.sections[0]!.tests[0]!.status).toBe("fail");
    expect(parsed.sections[0]!.tests[0]!.detail).toBeUndefined();
  });
});

describe("failureNotesDigest", () => {
  it("is text only — description + numbered steps, no image data", () => {
    const d = failureNotesDigest(catalog().sections[0]!.tests[1]!.failNotes!);
    expect(d).toContain("Stays on the dashboard after Log out.");
    expect(d).toContain("Steps to reproduce: 1. Sign in 2. Open the user menu 3. Click Log out");
    expect(d).toContain("Back button re-opens the app.");
    expect(d).not.toContain("base64");
    expect(failureNotesDigest([])).toBe("");
  });

  it("rides on the issue-filing payload only for rows that have notes", () => {
    const rows = selectUnfiledFailures(catalog(), {});
    expect(rows.map((r) => r.id)).toEqual(["AUTH-06", "AUTH-07"]);
    expect(rows[0]!.notes).toContain("Stays on the dashboard");
    expect("notes" in rows[1]!).toBe(false);
  });
});

describe("imageDimensions", () => {
  it("reads a PNG header", () => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    b.set([0, 0, 0x03, 0x20], 16); // 800
    b.set([0, 0, 0x02, 0x58], 20); // 600
    expect(imageDimensions(b)).toEqual({ width: 800, height: 600 });
  });

  it("reads a JPEG start-of-frame after other segments", () => {
    const b = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, // APP0, length 4
      0xff, 0xdb, 0x00, 0x03, 0x00, // DQT, length 3
      0xff, 0xc2, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0, 0, 0, // SOF2 720×1280
    ]);
    expect(imageDimensions(b)).toEqual({ width: 1280, height: 720 });
  });

  it("returns null for anything else", () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });
});

describe("composeResultsDocx — failure notes", () => {
  it("lists each failed row's notes with id, title, expected, description and steps", async () => {
    const files = unzipSync(await composeResultsDocx(catalog(), "2026-10-08"));
    const xml = strFromU8(files["word/document.xml"]!);
    expect(xml).toContain("Failure notes");
    expect(xml).toContain("AUTH-06 — Log out from the user menu");
    expect(xml).toContain("Returns to /login");
    expect(xml).toContain("Note 1 of 2");
    expect(xml).toContain("Stays on the dashboard after Log out.");
    expect(xml).toContain("Steps to reproduce");
    expect(xml).toContain("3. Click Log out");
    expect(xml).toContain("Back button re-opens the app.");
    expect(xml).toContain("✗ Fail (see notes)");
    // AUTH-07 failed without notes: plain mark, no block of its own.
    expect(xml).not.toContain("AUTH-07 — Forgot password");
  });

  it("embeds the screenshot as a real picture part (media + relationship + content type)", async () => {
    const files = unzipSync(await composeResultsDocx(catalog(), "2026-10-08"));
    expect(files["word/media/image1.png"]).toBeTruthy();
    // PNG signature — the bytes are the image, not base64 text.
    expect([...files["word/media/image1.png"]!.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const rels = strFromU8(files["word/_rels/document.xml.rels"]!);
    expect(rels).toContain('Id="rIdImg1"');
    expect(rels).toContain('Target="media/image1.png"');
    const xml = strFromU8(files["word/document.xml"]!);
    expect(xml).toContain('r:embed="rIdImg1"');
    expect(xml).toContain("<wp:extent");
    expect(xml).not.toContain("base64");
    expect(strFromU8(files["[Content_Types].xml"]!)).toContain('Extension="png"');
  });

  it("stays well-formed XML with hostile note text", async () => {
    const c = catalog();
    c.sections[0]!.tests[1]!.failNotes = [
      note({ description: `</w:t><w:evil a="1"> & "quotes" \u000b`, images: [{ dataUrl: PNG, mediaType: "image/png", name: `a"b<c>.png` }] }),
    ];
    const xml = strFromU8(unzipSync(await composeResultsDocx(c, "2026-10-08"))["word/document.xml"]!);
    expect(xml).not.toContain("<w:evil");
    expect(xml).toContain("&lt;/w:t&gt;&lt;w:evil");
    expect(xml).toContain('name="a&quot;b&lt;c&gt;.png"');
    // The vertical tab is illegal in XML 1.0 — one would truncate the
    // document in Word.
    expect(xml).not.toContain("\u000b");
  });

  it("falls back to a placeholder line when a screenshot can't be embedded", async () => {
    const c = catalog();
    c.sections[0]!.tests[1]!.failNotes = [
      note({ images: [{ dataUrl: "data:image/png;base64,AAAA", mediaType: "image/png", name: "broken.png" }] }),
    ];
    const files = unzipSync(await composeResultsDocx(c, "2026-10-08"));
    expect(strFromU8(files["word/document.xml"]!)).toContain("[image: broken.png — could not be embedded]");
    expect(files["word/_rels/document.xml.rels"]).toBeUndefined();
  });

  it("a catalog without notes produces the same package as before (no media parts)", async () => {
    const c = catalog();
    for (const t of c.sections[0]!.tests) delete t.failNotes;
    const files = unzipSync(await composeResultsDocx(c, "2026-10-08"));
    expect(Object.keys(files).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
    expect(strFromU8(files["word/document.xml"]!)).not.toContain("Failure notes");
  });

  it("notes left on a row that was re-marked Pass are not exported", async () => {
    const c = catalog();
    c.sections[0]!.tests[1]!.status = "pass";
    const xml = strFromU8(unzipSync(await composeResultsDocx(c, "2026-10-08"))["word/document.xml"]!);
    expect(xml).not.toContain("Failure notes");
    expect(xml).not.toContain("Stays on the dashboard");
  });
});

describe("results sidecar", () => {
  it("restores failure notes from disk, validated", () => {
    const c = catalog();
    delete c.sections[0]!.tests[1]!.failNotes;
    overlayResultsSidecar(c, {
      "AUTH-06": {
        status: "fail",
        failNotes: [note({ images: [{ dataUrl: "https://x/y.png", mediaType: "image/png" }] })],
      },
    });
    const restored = c.sections[0]!.tests[1]!.failNotes!;
    expect(restored).toHaveLength(1);
    expect(restored[0]!.description).toBe("Stays on the dashboard after Log out.");
    expect(restored[0]!.images).toBeUndefined();
  });

  it("leaves the notes on screen alone while an imported run is overlaid", () => {
    const c = catalog();
    overlayResultsSidecar(
      c,
      { "AUTH-06": { failNotes: [note({ id: "stale", description: "stale" })] } },
      { skipStatuses: true },
    );
    expect(c.sections[0]!.tests[1]!.failNotes!.map((n) => n.id)).toEqual(["n1", "n2"]);
  });
});

describe(".pinta bundle", () => {
  const session = { id: "s", url: "https://app.test/", startedAt: 1, annotations: [], status: "drafting", producer: "test" } as any;
  const manifest = { title: "Run", author: "QA", accentColor: "#E6007E", exportedAt: 1 };

  it("round-trips failure notes with their screenshots", async () => {
    const blob = encodePintaFile(session, manifest, {
      docId: "doc-1",
      signoff: null,
      statuses: { "AUTH-06": "fail" },
      failNotes: { "AUTH-06": [note()] },
    });
    const decoded = decodePintaFile(await blob.text());
    expect(decoded.testPilot!.failNotes!["AUTH-06"]).toEqual([note()]);
  });

  it("drops malformed notes but still imports the marks", () => {
    const text = JSON.stringify({
      $pinta: "1",
      manifest,
      session,
      testPilot: {
        docId: "doc-1",
        signoff: null,
        statuses: { "AUTH-06": "fail" },
        failNotes: { "AUTH-06": "not a list", "AUTH-07": [{ description: "ok", images: [{ dataUrl: "javascript:alert(1)" }] }] },
      },
    });
    const tp = decodePintaFile(text).testPilot!;
    expect(tp.statuses).toEqual({ "AUTH-06": "fail" });
    expect(Object.keys(tp.failNotes!)).toEqual(["AUTH-07"]);
    expect(tp.failNotes!["AUTH-07"]![0]!.images).toBeUndefined();
  });

  it("a test id of __proto__ keeps its notes through the bundle without touching Object.prototype", () => {
    const text = `{"$pinta":"1","manifest":${JSON.stringify(manifest)},"session":${JSON.stringify(session)},"testPilot":{"docId":"doc-1","signoff":null,"statuses":{"__proto__":"fail"},"failNotes":{"__proto__":[{"id":"a","at":1,"description":"d"}]}}}`;
    const tp = decodePintaFile(text).testPilot!;
    expect(Object.keys(tp.failNotes!)).toEqual(["__proto__"]);
    expect(tp.failNotes!["__proto__"]![0]!.description).toBe("d");
    expect(({} as Record<string, unknown>).description).toBeUndefined();
  });

  it("omits the field when there are no notes (older bundles unchanged)", async () => {
    const blob = encodePintaFile(session, manifest, { docId: "doc-1", signoff: null, statuses: { "AUTH-06": "fail" } });
    expect("failNotes" in decodePintaFile(await blob.text()).testPilot!).toBe(false);
  });
});
