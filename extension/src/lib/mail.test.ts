import { describe, expect, it, vi } from "vitest";
import { mailDraftUrl } from "./mail.js";

describe("mailDraftUrl", () => {
  const draft = {
    to: " dev@example.com ",
    subject: "[Pinta] hero & nav",
    body: "Hi,\nline two",
  };

  it("builds a Gmail compose URL with the address trimmed", () => {
    const url = mailDraftUrl(draft, "gmail");
    expect(url.startsWith("https://mail.google.com/mail/?view=cm&fs=1&tf=1")).toBe(true);
    expect(url).toContain("to=dev%40example.com");
    expect(url).toContain("su=%5BPinta%5D%20hero%20%26%20nav");
    expect(url).toContain("body=Hi%2C%0Aline%20two");
  });

  it("falls back to mailto for the OS mail client", () => {
    const url = mailDraftUrl(draft, "mailto");
    expect(url.startsWith("mailto:dev%40example.com?subject=")).toBe(true);
    expect(url).toContain("&body=Hi%2C%0Aline%20two");
  });

  it("defaults to Gmail", () => {
    expect(mailDraftUrl(draft)).toBe(mailDraftUrl(draft, "gmail"));
  });
});

describe("mailDraftUrl — edge cases", () => {
  it("handles an empty recipient without producing a malformed URL", () => {
    const d = { to: "", subject: "S", body: "B" };
    expect(mailDraftUrl(d, "gmail")).toContain("&to=&su=S");
    // mailto with no address is still a legal, openable draft URL.
    expect(mailDraftUrl(d, "mailto")).toBe("mailto:?subject=S&body=B");
  });

  it("treats a whitespace-only recipient as empty", () => {
    const d = { to: "   \t \n ", subject: "S", body: "B" };
    expect(mailDraftUrl(d, "gmail")).toContain("&to=&su=");
    expect(mailDraftUrl(d, "mailto")).toBe("mailto:?subject=S&body=B");
  });

  it("escapes separators in the recipient so extra params cannot be injected", () => {
    // A pasted value like this must not smuggle its own su=/subject=.
    const d = { to: "dev@example.com&su=spoofed?x=1", subject: "real", body: "b" };
    const g = mailDraftUrl(d, "gmail");
    expect(g).toContain("to=dev%40example.com%26su%3Dspoofed%3Fx%3D1");
    expect(g).toContain("&su=real");
    expect(g.match(/[?&]su=/g)).toHaveLength(1);
    const m = mailDraftUrl(d, "mailto");
    expect(m).toBe("mailto:dev%40example.com%26su%3Dspoofed%3Fx%3D1?subject=real&body=b");
    expect(m.match(/[?&]subject=/g)).toHaveLength(1);
  });

  it("percent-encodes a unicode subject and body losslessly", () => {
    const subject = "[Pinta] ✅ Ünïcøde — 日本語 🎨 50% done";
    const body = "Line ✓\nSecond — “quoted” • ✨\tTabbed";
    const url = new URL(mailDraftUrl({ to: "a@b.co", subject, body }, "gmail"));
    expect(url.searchParams.get("su")).toBe(subject);
    expect(url.searchParams.get("body")).toBe(body);
    // No raw non-ASCII leaks into the URL string.
    expect(/[^\x00-\x7F]/.test(url.toString())).toBe(false);
  });

  it("round-trips a unicode subject through mailto too", () => {
    const subject = "Ünïcøde 🎨";
    const url = mailDraftUrl({ to: "a@b.co", subject, body: "x" }, "mailto");
    const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(qs.get("subject")).toBe(subject);
  });

  it("encodes reserved characters in the body rather than ending the query", () => {
    const body = "a&b=c?d#e+f/g%h";
    const url = mailDraftUrl({ to: "a@b.co", subject: "s", body }, "gmail");
    expect(url.endsWith(encodeURIComponent(body))).toBe(true);
    expect(new URL(url).searchParams.get("body")).toBe(body);
  });

  it("keeps a very long body intact (no truncation, no throw)", () => {
    // The real send-back body is ~400 chars; this guards the helper itself
    // against silently clipping when a caller hands it a large draft.
    const body = "x".repeat(20_000) + "\nend";
    const url = mailDraftUrl({ to: "a@b.co", subject: "s", body }, "gmail");
    expect(url.length).toBeGreaterThan(20_000);
    expect(new URL(url).searchParams.get("body")).toBe(body);
  });

  it("does not guard the practical mailto: length limit (documents the risk)", () => {
    // Windows' shell mailto handler truncates around 2 KB. The helper has
    // no length check, so an oversized draft is the caller's problem.
    const url = mailDraftUrl(
      { to: "a@b.co", subject: "s", body: "y".repeat(5000) },
      "mailto",
    );
    expect(url.length).toBeGreaterThan(2048);
  });

  it("encodes newlines as %0A (not CRLF)", () => {
    const url = mailDraftUrl({ to: "a@b.co", subject: "s", body: "a\nb" }, "mailto");
    expect(url).toContain("body=a%0Ab");
    expect(url).not.toContain("%0D");
  });
});

describe("openMailDraft", () => {
  it("opens the built URL in a new tab without the noopener feature, then severs the opener", async () => {
    const { openMailDraft } = await import("./mail.js");
    // `window.open(url, "_blank", "noopener")` returns null by spec, which
    // used to read as "Gmail blocked" even when the tab opened.
    const win = { opener: {} as unknown };
    const open = vi.fn(() => win);
    vi.stubGlobal("window", { open });
    try {
      const draft = { to: "dev@example.com", subject: "s", body: "b" };
      expect(openMailDraft(draft, "gmail")).toBe(true);
      expect(open).toHaveBeenCalledWith(mailDraftUrl(draft, "gmail"), "_blank");
      expect(open.mock.calls[0]).toHaveLength(2);
      expect(win.opener).toBeNull();
      openMailDraft(draft, "mailto");
      expect(open).toHaveBeenLastCalledWith(mailDraftUrl(draft, "mailto"), "_blank");
      openMailDraft(draft);
      expect(open).toHaveBeenLastCalledWith(mailDraftUrl(draft, "gmail"), "_blank");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a blocked Gmail tab, and trusts the OS for mailto", async () => {
    const { openMailDraft } = await import("./mail.js");
    vi.stubGlobal("window", { open: vi.fn(() => null) });
    try {
      const draft = { to: "dev@example.com", subject: "s", body: "b" };
      // Popup blocked — the Gmail tab never appeared, so say so.
      expect(openMailDraft(draft, "gmail")).toBe(false);
      // mailto legitimately returns null even when the handler fired.
      expect(openMailDraft(draft, "mailto")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("isEmailish", () => {
  it("accepts ordinary and intranet addresses", async () => {
    const { isEmailish } = await import("./mail.js");
    expect(isEmailish("dev@example.com")).toBe(true);
    expect(isEmailish("  dev@example.com  ")).toBe(true);
    expect(isEmailish("qa@intranet")).toBe(true);
    expect(isEmailish("first.last+tag@sub.example.co.uk")).toBe(true);
  });

  it("rejects what would sail into the compose URL as a typo", async () => {
    const { isEmailish } = await import("./mail.js");
    expect(isEmailish("")).toBe(false);
    expect(isEmailish("   ")).toBe(false);
    expect(isEmailish("asdf")).toBe(false);
    expect(isEmailish("@example.com")).toBe(false);
    expect(isEmailish("dev@")).toBe(false);
    expect(isEmailish("dev@exa mple.com")).toBe(false);
    expect(isEmailish("dev@example..com")).toBe(false);
  });
});

describe("openMailDraftTab", () => {
  it("opens Gmail through chrome.tabs.create so no user gesture is needed", async () => {
    const { openMailDraftTab } = await import("./mail.js");
    const create = vi.fn(async () => ({ id: 1 }));
    const open = vi.fn(() => null);
    vi.stubGlobal("chrome", { tabs: { create } });
    vi.stubGlobal("window", { open });
    try {
      const draft = { to: "dev@example.com", subject: "s", body: "b" };
      await expect(openMailDraftTab(draft, "gmail")).resolves.toBe(true);
      expect(create).toHaveBeenCalledWith({ url: mailDraftUrl(draft, "gmail") });
      // A blocked window.open never enters the picture on this path.
      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps mailto on window.open (a mailto tab would leave a blank tab behind)", async () => {
    const { openMailDraftTab } = await import("./mail.js");
    const create = vi.fn(async () => ({ id: 1 }));
    const open = vi.fn(() => null);
    vi.stubGlobal("chrome", { tabs: { create } });
    vi.stubGlobal("window", { open });
    try {
      const draft = { to: "dev@example.com", subject: "s", body: "b" };
      await expect(openMailDraftTab(draft, "mailto")).resolves.toBe(true);
      expect(create).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith(mailDraftUrl(draft, "mailto"), "_blank");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to window.open outside an extension context, and reports a blocked tab", async () => {
    const { openMailDraftTab } = await import("./mail.js");
    const open = vi.fn(() => null);
    vi.stubGlobal("chrome", undefined);
    vi.stubGlobal("window", { open });
    try {
      const draft = { to: "dev@example.com", subject: "s", body: "b" };
      await expect(openMailDraftTab(draft, "gmail")).resolves.toBe(false);
      expect(open).toHaveBeenCalledWith(mailDraftUrl(draft, "gmail"), "_blank");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to window.open when tabs.create throws", async () => {
    const { openMailDraftTab } = await import("./mail.js");
    const create = vi.fn(async () => { throw new Error("no tabs permission"); });
    const open = vi.fn(() => ({}));
    vi.stubGlobal("chrome", { tabs: { create } });
    vi.stubGlobal("window", { open });
    try {
      const draft = { to: "dev@example.com", subject: "s", body: "b" };
      await expect(openMailDraftTab(draft, "gmail")).resolves.toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
