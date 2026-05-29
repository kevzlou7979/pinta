import { describe, expect, it } from "vitest";
import { scrubInlineSecrets } from "./capture.js";

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
