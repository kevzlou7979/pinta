import { describe, expect, it } from "vitest";
import type { Session, SessionManifest } from "@pinta/shared";
import {
  decodePintaFile,
  encodePintaFile,
  pintaFilename,
  PintaFileError,
  MAX_PINTA_FILE_BYTES,
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
