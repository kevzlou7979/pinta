import { describe, expect, it } from "vitest";
import { isSensitiveParamKey, safeExternalUrl, scrubInlineSecrets, scrubUrl } from "./capture.js";

// Pure-logic tests for the Phase 14.5 chat-hardening inline secret
// scrubber. Patterns are tested in isolation so we don't have to
// stand up a DOM to cover them. The DOM-touching parts of capture.ts
// (sanitizeOuterHtml, collectNearbyText) are exercised via the
// extension's runtime — Vitest's node env can't reach them.

describe("scrubInlineSecrets", () => {
  it("passes ordinary prose through unchanged", () => {
    const s =
      "Hello — this is the email step. Click the Submit button " +
      "and verify the confirmation page appears.";
    expect(scrubInlineSecrets(s)).toBe(s);
  });

  it("redacts Bearer tokens", () => {
    const s = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz";
    expect(scrubInlineSecrets(s)).toContain("[REDACTED:bearer]");
    expect(scrubInlineSecrets(s)).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts JWTs even without a Bearer prefix", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYiLCJuYW1lIjoiSiJ9.abc123def";
    const out = scrubInlineSecrets(`stored at ${jwt} in localStorage`);
    expect(out).toContain("[REDACTED:");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts GitHub personal access tokens", () => {
    const out = scrubInlineSecrets(
      "leaked: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd in the slack thread",
    );
    expect(out).toContain("[REDACTED:gh-pat]");
    expect(out).not.toContain("ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ");
  });

  it("redacts GitLab PATs", () => {
    const out = scrubInlineSecrets("token=glpat-aBcDeFgHiJkLmNoPqRsT");
    expect(out).toContain("[REDACTED:gl-pat]");
  });

  it("redacts Anthropic + OpenAI keys distinctly", () => {
    const ant = scrubInlineSecrets("sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345");
    expect(ant).toContain("[REDACTED:ant-key]");
    const oai = scrubInlineSecrets("sk-aBcDeFgHiJkLmNoPqRsTuVw0123");
    expect(oai).toContain("[REDACTED:openai-key]");
  });

  it("redacts AWS access key ids", () => {
    expect(scrubInlineSecrets("AKIAIOSFODNN7EXAMPLE")).toContain(
      "[REDACTED:aws-akia]",
    );
  });

  it("redacts Google API keys", () => {
    // Real Google API keys are exactly 39 chars: `AIza` + 35 char body.
    // Pad with a trailing space so the `\b` end-boundary forms.
    expect(
      scrubInlineSecrets("key: AIzaSyB-aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123 here"),
    ).toContain("[REDACTED:google-key]");
  });

  it("redacts long high-entropy base64-ish strings (uppercase + digit + 40+ chars)", () => {
    const blob = "aGVsbG8gd29ybGQTHISisaVERY1234XYZabcdef987zzz";
    expect(scrubInlineSecrets(blob)).toContain("[REDACTED:high-entropy]");
  });

  it("does NOT redact 40+ char lowercase prose (no uppercase/digit)", () => {
    // A long all-lowercase sentence has no uppercase + digit → not entropy.
    const s = "this is a long lowercase sentence with no secrets at all";
    expect(scrubInlineSecrets(s)).toBe(s);
  });

  it("handles multiple secrets in one string", () => {
    const out = scrubInlineSecrets(
      "Bearer abc123XYZ and also ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd here",
    );
    expect(out).toContain("[REDACTED:bearer]");
    expect(out).toContain("[REDACTED:gh-pat]");
  });

  it("returns empty string unchanged", () => {
    expect(scrubInlineSecrets("")).toBe("");
  });
});

describe("scrubInlineSecrets", () => {
  it("does not go quadratic on a hostile text run", () => {
    // "+ / = - _" are non-word characters, so almost every position in a
    // long run of the high-entropy charset is a word boundary. With
    // unbounded lookaheads each of those positions rescanned the whole
    // run: a planted 100 KB "a/" node froze the page's main thread for
    // 18 SECONDS on one click. The lookaheads are bounded now.
    const hostile = "a/".repeat(50_000);
    const started = Date.now();
    scrubInlineSecrets(hostile);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("still redacts a real high-entropy token", () => {
    const token = `aB3${"QwErTyUiOpAsDfGhJkLzXcVbNm0123456789".repeat(2)}`;
    expect(scrubInlineSecrets(`key = ${token}`)).toContain("[REDACTED:high-entropy]");
  });

  it("keeps the branded patterns on input too large for the entropy sweep", () => {
    // Above the size cap the unbranded sweep is skipped, but a real
    // credential shape must still never survive.
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const huge = `${"lorem ipsum ".repeat(4_000)} ${jwt}`;
    expect(huge.length).toBeGreaterThan(32 * 1024);
    expect(scrubInlineSecrets(huge)).not.toContain(jwt);
  });
});

describe("scrubUrl", () => {
  it("leaves ordinary URLs byte-identical", () => {
    for (const u of [
      "http://localhost:5173/courses/12?tab=outline&design=dark#section-2",
      "https://app.example.com/a%20b?q=hello+world",
      "",
    ]) {
      expect(scrubUrl(u)).toBe(u);
    }
  });

  it("redacts credential-like query values by key word", () => {
    const out = scrubUrl(
      "https://app.example.com/cb?code=abc123&state=xyz&access_token=t0k&apiKey=k&X-Amz-Signature=s&page=2",
    );
    expect(out).not.toMatch(/abc123|t0k|=k&|=s&/);
    expect(out).toContain("code=REDACTED");
    expect(out).toContain("access_token=REDACTED");
    expect(out).toContain("apiKey=REDACTED");
    expect(out).toContain("X-Amz-Signature=REDACTED");
    expect(out).toContain("state=xyz");
    expect(out).toContain("page=2");
  });

  it("redacts inside fragments instead of dropping the route", () => {
    // OAuth implicit flow: bare pairs, no route to keep.
    expect(scrubUrl("https://a.test/cb#access_token=eyJabc&token_type=bearer")).toBe(
      "https://a.test/cb#access_token=REDACTED&token_type=REDACTED",
    );
    // Hash-routed SPA: the route is the only record of which screen the
    // annotation belongs to, so it must survive the redaction.
    expect(scrubUrl("https://a.test/#/login?session=abc")).toBe(
      "https://a.test/#/login?session=REDACTED",
    );
    expect(scrubUrl("https://a.test/#/board/42?tab=open")).toBe("https://a.test/#/board/42?tab=open");
    expect(scrubUrl("https://a.test/docs#install")).toBe("https://a.test/docs#install");
  });

  it("keeps two different hash routes distinct", () => {
    // Dropping the fragment made these compare equal, which silently
    // merged pin replay across screens.
    expect(scrubUrl("https://a.test/#/a?token=1")).not.toBe(scrubUrl("https://a.test/#/b?token=1"));
  });

  it("survives a fragment that isn't valid percent-encoding", () => {
    // Chrome leaves a bare "%" in the fragment as-is; decodeURIComponent
    // throws on it, and scrubUrl is on the annotation-capture path.
    expect(scrubUrl("https://a.test/#q=100%")).toBe("https://a.test/#q=100%");
    expect(scrubUrl("https://a.test/#a=50%off&b=1")).toBe("https://a.test/#a=50%off&b=1");
    expect(scrubUrl("https://a.test/#token=100%")).toBe("https://a.test/#token=REDACTED");
  });

  it("redacts a secret VALUE even under an innocent key", () => {
    // Key-matching alone used to be enough because the whole fragment was
    // dropped; now that the route survives, the value needs the sweep.
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(scrubUrl(`https://a.test/#u=alice&t=${jwt}`)).not.toContain(jwt);
    expect(scrubUrl(`https://a.test/?u=alice&t=${jwt}`)).not.toContain(jwt);
    expect(scrubUrl("https://a.test/?id=1&x=AKIAIOSFODNN7EXAMPLE")).not.toContain(
      "AKIAIOSFODNN7EXAMPLE",
    );
    // …and an ordinary value is still byte-identical.
    expect(scrubUrl("https://a.test/#u=alice&page=2")).toBe("https://a.test/#u=alice&page=2");
  });

  it("leaves long redirect targets alone", () => {
    // The high-entropy pattern's charset covers "/", "-" and "_", so a long
    // path matches it. Mangling a redirect_uri hands the agent a URL it
    // can't navigate to, and every real credential shape is branded.
    for (const u of [
      "https://a.test/login?redirect_uri=https%3A%2F%2Fapp.dev%2FSettings1%2FTeamMembers%2FBillingPlan",
      "https://a.test/login?next=/Dashboard1/Reports/Quarterly/Regional/Summary",
    ]) {
      expect(scrubUrl(u)).toBe(u);
    }
  });

  it("catches a percent-encoded secret in a fragment", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const out = scrubUrl(`https://a.test/#x=${encodeURIComponent(jwt)}`);
    expect(out).not.toContain("eyJzdWIiOiIxMjM0NTY3ODkwIn0");
  });

  it("is idempotent over fragments", () => {
    for (const u of [
      "https://a.test/#/login?session=abc",
      "https://a.test/cb#access_token=eyJabc&token_type=bearer",
      "https://a.test/#/board/42?tab=open",
      "https://a.test/docs#install",
    ]) {
      const once = scrubUrl(u);
      expect(scrubUrl(once)).toBe(once);
    }
  });

  it("strips userinfo and is idempotent", () => {
    const once = scrubUrl("https://user:pw@a.test/x?token=1&keyword=shoes");
    expect(once).toBe("https://a.test/x?token=REDACTED&keyword=shoes");
    expect(scrubUrl(once)).toBe(once);
  });

  it("passes non-http URLs through and scrubs inline secrets in junk", () => {
    expect(scrubUrl("chrome-extension://abc/src/devices/index.html")).toBe(
      "chrome-extension://abc/src/devices/index.html",
    );
    expect(scrubUrl("not a url ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd")).toContain("[REDACTED:gh-pat]");
  });

  it("isSensitiveParamKey matches words, not substrings", () => {
    expect(isSensitiveParamKey("accessToken")).toBe(true);
    expect(isSensitiveParamKey("id_token")).toBe(true);
    expect(isSensitiveParamKey("design")).toBe(false);
    expect(isSensitiveParamKey("monkey")).toBe(false);
  });
});

describe("safeExternalUrl", () => {
  it("accepts https and loopback http only", () => {
    expect(safeExternalUrl("https://gitlab.com/g/p/-/issues/1")).toBe("https://gitlab.com/g/p/-/issues/1");
    expect(safeExternalUrl("http://localhost:8080/issues/2")).toBe("http://localhost:8080/issues/2");
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "http://evil.test/x",
      "https://user:pw@gitlab.com/x",
      "/relative",
      "",
      42,
    ]) {
      expect(safeExternalUrl(bad)).toBeUndefined();
    }
  });
});
