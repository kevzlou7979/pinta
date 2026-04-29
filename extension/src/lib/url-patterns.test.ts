import { describe, expect, it } from "vitest";
import {
  findCompanionForUrl,
  matchAny,
  matchPattern,
  suggestPattern,
} from "./url-patterns.js";
import type { Companion } from "./companions.js";

describe("matchPattern", () => {
  it("matches a simple host+path glob", () => {
    expect(matchPattern("http://localhost:5173/", "http://localhost:5173/*")).toBe(true);
  });

  it("matches nested paths under a single * (URL globs are greedy)", () => {
    expect(
      matchPattern("http://localhost:5173/foo/bar/baz", "http://localhost:5173/*"),
    ).toBe(true);
  });

  it("treats ** as a synonym for *", () => {
    expect(
      matchPattern("http://localhost:5173/a/b", "http://localhost:5173/**"),
    ).toBe(true);
  });

  it("ignores query string and hash on the candidate URL", () => {
    expect(
      matchPattern("http://localhost:5173/foo?x=1#y", "http://localhost:5173/*"),
    ).toBe(true);
  });

  it("rejects a different host", () => {
    expect(
      matchPattern("http://example.com/", "http://localhost:5173/*"),
    ).toBe(false);
  });

  it("matches subdomain wildcards", () => {
    expect(
      matchPattern(
        "https://app.staging.example.com/dashboard",
        "https://*.staging.example.com/*",
      ),
    ).toBe(true);
  });
});

describe("matchAny", () => {
  it("returns true if any pattern matches", () => {
    expect(
      matchAny("http://localhost:5173/", [
        "https://example.com/*",
        "http://localhost:5173/*",
      ]),
    ).toBe(true);
  });

  it("returns false when no pattern matches", () => {
    expect(matchAny("http://localhost:5173/", ["https://example.com/*"])).toBe(
      false,
    );
  });
});

describe("findCompanionForUrl", () => {
  const a: Companion = {
    port: 7878,
    projectRoot: "/a",
    urlPatterns: ["http://localhost:5173/*"],
  };
  const b: Companion = {
    port: 7879,
    projectRoot: "/b",
    urlPatterns: ["http://localhost:6000/*"],
  };

  it("returns the unique match", () => {
    expect(findCompanionForUrl([a, b], "http://localhost:5173/x")).toBe(a);
  });

  it("returns null when no companion matches", () => {
    expect(findCompanionForUrl([a, b], "http://example.com/")).toBeNull();
  });

  it("returns null on ambiguous matches (>1 companion claims the URL)", () => {
    const overlap: Companion = { ...a, port: 7880 };
    expect(
      findCompanionForUrl([a, overlap], "http://localhost:5173/x"),
    ).toBeNull();
  });
});

describe("suggestPattern", () => {
  it("wildcards the first path segment for http URLs", () => {
    expect(suggestPattern("http://localhost:5173/claims/123")).toBe(
      "http://localhost:5173/claims/*",
    );
  });

  it("falls back to host/* for root paths", () => {
    expect(suggestPattern("https://example.com/")).toBe("https://example.com/*");
  });

  it("drops the filename for file:// URLs", () => {
    expect(suggestPattern("file:///c/work/project/index.html")).toBe(
      "file:///c/work/project/*",
    );
  });
});
