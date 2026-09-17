import { describe, expect, it } from "vitest";
import { collectProbeResults, parseHealthResponse } from "./companions.js";

describe("parseHealthResponse", () => {
  it("returns a companion for a healthy 200", () => {
    const r = parseHealthResponse(7878, 200, {
      ok: true,
      projectRoot: "/p",
      urlPatterns: ["http://localhost:5173/*", 5],
      registryId: "abc",
      version: "0.5.0",
    });
    expect(r).toEqual({
      kind: "companion",
      companion: { port: 7878, projectRoot: "/p", urlPatterns: ["http://localhost:5173/*"], registryId: "abc", version: "0.5.0" },
    });
  });

  it("recognises the untrusted-extension 403", () => {
    const r = parseHealthResponse(7880, 403, {
      error: "untrusted-extension",
      extensionId: "abcdefghijklmnop",
      fix: "npx pinta-companion trust abcdefghijklmnop",
    });
    expect(r).toEqual({
      kind: "untrusted",
      untrusted: { port: 7880, extensionId: "abcdefghijklmnop", fix: "npx pinta-companion trust abcdefghijklmnop" },
    });
  });

  it("tolerates a 403 refusal missing optional fields", () => {
    expect(parseHealthResponse(7881, 403, { error: "untrusted-extension" })).toEqual({
      kind: "untrusted",
      untrusted: { port: 7881, extensionId: null, fix: null },
    });
  });

  it("ignores other 403s, non-2xx, non-JSON and non-Pinta bodies", () => {
    expect(parseHealthResponse(7878, 403, { error: "forbidden" })).toEqual({ kind: "none" });
    expect(parseHealthResponse(7878, 403, null)).toEqual({ kind: "none" });
    expect(parseHealthResponse(7878, 500, { ok: true, projectRoot: "/p" })).toEqual({ kind: "none" });
    expect(parseHealthResponse(7878, 200, null)).toEqual({ kind: "none" });
    expect(parseHealthResponse(7878, 200, { ok: true })).toEqual({ kind: "none" });
    expect(parseHealthResponse(7878, 200, { error: "untrusted-extension" })).toEqual({ kind: "none" });
  });
});

describe("collectProbeResults", () => {
  it("splits companions from untrusted refusals, preserving order", () => {
    const out = collectProbeResults([
      { kind: "none" },
      { kind: "companion", companion: { port: 7879, projectRoot: "/a", urlPatterns: [] } },
      { kind: "untrusted", untrusted: { port: 7880, extensionId: "x", fix: null } },
      { kind: "companion", companion: { port: 7881, projectRoot: "/b", urlPatterns: [] } },
    ]);
    expect(out.companions.map((c) => c.port)).toEqual([7879, 7881]);
    expect(out.untrusted).toEqual([{ port: 7880, extensionId: "x", fix: null }]);
  });
});
