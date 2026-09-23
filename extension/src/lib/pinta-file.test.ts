import { describe, expect, it } from "vitest";
import type { Session, SessionManifest } from "@pinta/shared";
import {
  decodePintaFile,
  encodePintaFile,
  pintaFilename,
  PintaFileError,
  MAX_PINTA_FILE_BYTES,
  filterShareableAnnotations,
  isShareableAnnotation,
} from "./pinta-file.js";

function makeSession(): Session {
  return {
    id: "sess-123",
    url: "https://staging.example.com/dashboard",
    projectRoot: "/Users/me/proj",
    startedAt: 1746360000000,
    submittedAt: 1746360060000,
    annotations: [
      {
        id: "ann-a",
        createdAt: 1746360010000,
        kind: "select",
        strokes: [],
        color: "#FF3D6E",
        comment: "tighten spacing",
        targets: [
          {
            selector: "header > nav",
            outerHTML: "<nav>...</nav>",
            computedStyles: { padding: "12px" },
            nearbyText: ["Dashboard"],
            boundingRect: { x: 0, y: 0, width: 320, height: 56 },
          },
        ],
      },
      {
        id: "ann-b",
        createdAt: 1746360020000,
        kind: "arrow",
        strokes: [
          { x: 10, y: 10 },
          { x: 100, y: 100 },
        ],
        color: "#7C3AED",
        comment: "make this tonal",
      },
      {
        id: "ann-c",
        createdAt: 1746360030000,
        kind: "image",
        strokes: [],
        color: "#10B981",
        comment: "match [image1]",
        images: [
          {
            id: "image1",
            mediaType: "image/png",
            // 1×1 transparent PNG
            dataUrl:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          },
        ],
      },
    ],
    fullPageScreenshot:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    fullPageScreenshotPath: ".pinta/sessions/sess-123.png",
    status: "submitted",
    producer: "extension",
    claimedBy: "claude-code-1",
    claimedAt: 1746360045000,
  };
}

function makeManifest(): SessionManifest {
  return {
    title: "Header redesign",
    author: "Mark",
    description: "Spacing pass",
    accentColor: "#7C3AED",
    exportedAt: 1746400000000,
  };
}

describe("encode/decode pinta file", () => {
  it("round-trips a session with mixed annotation kinds", async () => {
    const session = makeSession();
    const manifest = makeManifest();
    const blob = encodePintaFile(session, manifest);
    const text = await blob.text();
    const imported = decodePintaFile(text);

    expect(imported.manifest).toEqual(manifest);
    expect(imported.session.id).toBe(session.id);
    expect(imported.session.annotations).toHaveLength(3);
    expect(imported.session.annotations[0]?.kind).toBe("select");
    expect(imported.session.annotations[1]?.kind).toBe("arrow");
    expect(imported.session.annotations[2]?.kind).toBe("image");
    // Image dataUrls survive verbatim — they're the only way recipients
    // see what the author was pointing at.
    expect(imported.session.annotations[2]?.images?.[0]?.dataUrl).toBe(
      session.annotations[2]!.images![0]!.dataUrl,
    );
    expect(imported.session.fullPageScreenshot).toBe(session.fullPageScreenshot);
  });

  it("strips disk-only / claim metadata that can't travel", async () => {
    const blob = encodePintaFile(makeSession(), makeManifest());
    const imported = decodePintaFile(await blob.text());
    expect(imported.session.fullPageScreenshotPath).toBeUndefined();
    expect(imported.session.claimedBy).toBeUndefined();
    expect(imported.session.claimedAt).toBeUndefined();
  });

  it("assigns a fresh local id on import so duplicate imports stay distinct", async () => {
    const blob = encodePintaFile(makeSession(), makeManifest());
    const text = await blob.text();
    const a = decodePintaFile(text);
    const b = decodePintaFile(text);
    expect(a.id).not.toBe(b.id);
    expect(a.importedAt).toBeTypeOf("number");
  });

  it("rejects unknown $pinta schema versions", () => {
    const bad = JSON.stringify({
      $pinta: "999",
      manifest: makeManifest(),
      session: makeSession(),
    });
    expect(() => decodePintaFile(bad)).toThrowError(PintaFileError);
  });

  it("rejects malformed JSON", () => {
    expect(() => decodePintaFile("{not json")).toThrowError(PintaFileError);
  });

  it("rejects payloads missing the manifest", () => {
    const bad = JSON.stringify({ $pinta: "1", session: makeSession() });
    expect(() => decodePintaFile(bad)).toThrowError(/manifest/);
  });

  it("rejects payloads missing the session", () => {
    const bad = JSON.stringify({ $pinta: "1", manifest: makeManifest() });
    expect(() => decodePintaFile(bad)).toThrowError(/session/);
  });

  it("rejects oversized payloads to protect IndexedDB", () => {
    const huge = "x".repeat(MAX_PINTA_FILE_BYTES + 1);
    expect(() => decodePintaFile(huge)).toThrowError(/too large/);
  });

  // ── WS2b — optional testPilot block (ONE .pinta bundle) ───────────
  it("round-trips the optional testPilot results block", async () => {
    const testPilot = {
      docId: "doc-abc",
      signoff: {
        tester: "Jess Reyes",
        email: "jess@example.com",
        date: "2026-09-23",
        environment: "UAT",
        runType: "Regression",
        notes: "blocked on claims",
      },
      statuses: { "AUTH-01": "pass", "AUTH-02": "fail", "CLM-01": "untested" },
    } as const;
    const blob = encodePintaFile(makeSession(), makeManifest(), {
      ...testPilot,
      statuses: { ...testPilot.statuses },
    });
    const imported = decodePintaFile(await blob.text());
    expect(imported.testPilot).toEqual(testPilot);
  });

  it("omits testPilot when not passed to encode", async () => {
    const blob = encodePintaFile(makeSession(), makeManifest());
    const text = await blob.text();
    expect(JSON.parse(text).testPilot).toBeUndefined();
    expect(decodePintaFile(text).testPilot).toBeUndefined();
  });

  it("drops a malformed testPilot block without failing the file", () => {
    const cases: unknown[] = [
      "not an object",
      { signoff: null, statuses: {} }, // missing docId
      { docId: "d", signoff: null, statuses: [] }, // statuses not a record
      { docId: "", signoff: null, statuses: {} }, // empty docId
    ];
    for (const testPilot of cases) {
      const text = JSON.stringify({
        $pinta: "1",
        manifest: makeManifest(),
        session: makeSession(),
        testPilot,
      });
      const imported = decodePintaFile(text);
      expect(imported.testPilot).toBeUndefined();
      expect(imported.session.id).toBe("sess-123");
    }
  });

  it("discards unknown status values and keeps the valid ones", () => {
    const text = JSON.stringify({
      $pinta: "1",
      manifest: makeManifest(),
      session: makeSession(),
      testPilot: {
        docId: "doc-abc",
        signoff: { tester: "" }, // blank tester → treated as unsigned
        statuses: { "AUTH-01": "pass", "AUTH-02": "exploded", "CLM-01": 42 },
      },
    });
    const imported = decodePintaFile(text);
    expect(imported.testPilot).toEqual({
      docId: "doc-abc",
      signoff: null,
      statuses: { "AUTH-01": "pass" },
    });
  });
});

// ── Tester gap tests (feat/tester-roundtrip QA pass) ──────────────────

describe("testPilot block hygiene", () => {
  it("emits exactly $pinta/manifest/session/testPilot — never filedIssues", async () => {
    const blob = encodePintaFile(makeSession(), makeManifest(), {
      docId: "doc-abc",
      signoff: null,
      statuses: { "AUTH-01": "pass" },
    });
    const text = await blob.text();
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["$pinta", "manifest", "session", "testPilot"]);
    expect(Object.keys(payload.testPilot as object).sort()).toEqual(["docId", "signoff", "statuses"]);
    // Filed-issue markers live only in the local IndexedDB record
    // (shared/types.ts ImportedSession.filedIssues) — never in a share.
    expect(text).not.toContain("filedIssues");
  });

  it("still strips modules (secrets) and claim metadata when testPilot rides along", async () => {
    const session = {
      ...makeSession(),
      modules: [{ id: "gitlab-issues", settings: { token: "SECRET-PAT-123" } }],
    } as Session;
    const blob = encodePintaFile(session, makeManifest(), {
      docId: "doc-abc",
      signoff: null,
      statuses: { "AUTH-01": "fail" },
    });
    const text = await blob.text();
    expect(text).not.toContain("SECRET-PAT-123");
    const imported = decodePintaFile(text);
    expect(imported.session.modules).toBeUndefined();
    expect(imported.session.claimedBy).toBeUndefined();
    expect(imported.testPilot?.statuses).toEqual({ "AUTH-01": "fail" });
  });

  it("unicode test ids survive the byte round-trip", async () => {
    const statuses = { "AUTH-Ω": "pass", "試験-01": "fail" } as const;
    const blob = encodePintaFile(makeSession(), makeManifest(), {
      docId: "doc-abc",
      signoff: null,
      statuses: { ...statuses },
    });
    const imported = decodePintaFile(await blob.text());
    expect(imported.testPilot?.statuses).toEqual(statuses);
  });

  it("a __proto__ status entry neither pollutes nor survives sanitize", () => {
    const text = JSON.stringify({
      $pinta: "1",
      manifest: makeManifest(),
      session: makeSession(),
      testPilot: {
        docId: "doc-abc",
        signoff: null,
        statuses: JSON.parse('{"__proto__": "pass", "AUTH-01": "fail"}'),
      },
    });
    const imported = decodePintaFile(text);
    expect(Object.keys(imported.testPilot!.statuses)).toEqual(["AUTH-01"]);
    expect(Object.prototype.hasOwnProperty.call(imported.testPilot!.statuses, "__proto__")).toBe(false);
    // No prototype pollution leaked out of the sanitize pass.
    expect(({} as Record<string, unknown>)["AUTH-01"]).toBeUndefined();
  });

  it("treats a non-object signoff as unsigned but keeps the statuses", () => {
    for (const signoff of ["Jess", 5, true]) {
      const text = JSON.stringify({
        $pinta: "1",
        manifest: makeManifest(),
        session: makeSession(),
        testPilot: { docId: "doc-abc", signoff, statuses: { "AUTH-01": "pass" } },
      });
      const imported = decodePintaFile(text);
      expect(imported.testPilot, String(signoff)).toEqual({
        docId: "doc-abc",
        signoff: null,
        statuses: { "AUTH-01": "pass" },
      });
    }
  });

  it("coerces wrong-typed sign-off fields instead of failing the file", () => {
    const text = JSON.stringify({
      $pinta: "1",
      manifest: makeManifest(),
      session: makeSession(),
      testPilot: {
        docId: "doc-abc",
        signoff: {
          tester: "Jess",
          email: 5,
          date: null,
          environment: {},
          runType: 7,
          notes: ["a"],
          extraField: "dropped",
        },
        statuses: {},
      },
    });
    const imported = decodePintaFile(text);
    expect(imported.testPilot?.signoff).toEqual({
      tester: "Jess",
      email: undefined,
      date: "",
      environment: "",
      runType: undefined,
      notes: undefined,
    });
    expect(imported.testPilot?.signoff).not.toHaveProperty("extraField");
  });

  it("drops a null-statuses testPilot block without failing the file", () => {
    const text = JSON.stringify({
      $pinta: "1",
      manifest: makeManifest(),
      session: makeSession(),
      testPilot: { docId: "doc-abc", signoff: null, statuses: null },
    });
    const imported = decodePintaFile(text);
    expect(imported.testPilot).toBeUndefined();
    expect(imported.session.id).toBe("sess-123");
  });
});

describe("pintaFilename", () => {
  it("slugifies the manifest title", () => {
    const name = pintaFilename(
      { ...makeManifest(), title: "Header Redesign — Round 2!" },
      "https://staging.example.com",
    );
    expect(name).toBe("header-redesign-round-2.pinta");
  });

  it("falls back to host + timestamp when title is empty", () => {
    const name = pintaFilename(
      { ...makeManifest(), title: "   " },
      "https://staging.example.com/x",
    );
    expect(name).toMatch(/^pinta-staging\.example\.com-/);
    expect(name.endsWith(".pinta")).toBe(true);
  });
});

describe("filterShareableAnnotations", () => {
  const ann = (kind: string, id = kind) =>
    ({ id, createdAt: 0, kind, strokes: [], color: "#f0f", comment: "" }) as unknown as Session["annotations"][number];

  it("keeps every normal user-authored kind", () => {
    const kinds = ["arrow", "rect", "circle", "freehand", "pin", "select", "image", "note", "move", "text-insert", "delete"];
    const { kept, dropped } = filterShareableAnnotations(kinds.map((k) => ann(k)));
    expect(kept.map((a) => a.kind)).toEqual(kinds);
    expect(dropped).toBe(0);
  });

  it("drops query-kind annotations (module RPCs) and unknown kinds", () => {
    const { kept, dropped } = filterShareableAnnotations([
      ann("select", "a"),
      ann("query", "b"),
      ann("exec-shell", "c"),
      { id: "d" } as unknown as Session["annotations"][number],
    ]);
    expect(kept.map((a) => a.id)).toEqual(["a"]);
    expect(dropped).toBe(3);
  });

  it("reports zero kept for a share made only of queries", () => {
    const { kept, dropped } = filterShareableAnnotations([ann("query")]);
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("tolerates a missing annotations array", () => {
    expect(filterShareableAnnotations(undefined)).toEqual({ kept: [], dropped: 0 });
    expect(isShareableAnnotation(null)).toBe(false);
  });
});
