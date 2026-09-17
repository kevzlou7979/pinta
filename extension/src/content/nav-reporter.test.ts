// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// nav-reporter.ts is a side-effect content script: it registers one
// window "message" listener at import. Loaded once with a stubbed
// chrome.runtime and a fake parent/top (so it believes it's framed).
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let parent: { postMessage: ReturnType<typeof vi.fn> };
let originals: { parent: PropertyDescriptor | undefined; top: PropertyDescriptor | undefined };

function send(data: unknown, origin = EXT_ORIGIN, source: unknown = parent): void {
  const ev = new MessageEvent("message", { data, origin });
  Object.defineProperty(ev, "source", { value: source });
  window.dispatchEvent(ev);
}

const navReports = () => parent.postMessage.mock.calls.filter((c) => (c[0] as { type?: string })?.type === "pinta-nav");

// Imported ONCE: every import adds another window listener, so re-importing
// per test would stack reporters.
beforeAll(async () => {
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (p: string) => `${EXT_ORIGIN}/${p}`,
      getManifest: () => ({ web_accessible_resources: [] }),
    },
  });
  parent = { postMessage: vi.fn() };
  originals = {
    parent: Object.getOwnPropertyDescriptor(window, "parent"),
    top: Object.getOwnPropertyDescriptor(window, "top"),
  };
  Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
  Object.defineProperty(window, "top", { configurable: true, get: () => parent });
  // Node's WHATWG URL gives non-special schemes an opaque "null" origin;
  // Chrome reports chrome-extension://<id>. Match Chrome for the import.
  class ChromeURL extends URL {
    override get origin(): string {
      return this.protocol === "chrome-extension:" ? `${this.protocol}//${this.host}` : super.origin;
    }
  }
  const RealURL = globalThis.URL;
  globalThis.URL = ChromeURL as typeof URL;
  try {
    await import("./nav-reporter.js");
  } finally {
    globalThis.URL = RealURL;
  }
});

afterAll(() => {
  if (originals.parent) Object.defineProperty(window, "parent", originals.parent);
  else delete (window as { parent?: unknown }).parent;
  if (originals.top) Object.defineProperty(window, "top", originals.top);
  else delete (window as { top?: unknown }).top;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.useFakeTimers();
  parent.postMessage.mockClear();
});

afterEach(() => {
  // Stop any reporter the test left running (module state is shared).
  send({ type: "pinta-nav-stop" });
  vi.useRealTimers();
});

describe("nav-reporter start/stop (P7)", () => {
  it("starts on pinta-nav-start from the extension origin + parent, reporting to the extension origin only", () => {
    send({ type: "pinta-nav-start" });
    expect(navReports()).toHaveLength(1);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: "pinta-nav", url: location.href }, EXT_ORIGIN);
  });

  it("pinta-nav-stop from the extension origin + parent stops polling; a later start resumes", () => {
    send({ type: "pinta-nav-start" });
    expect(vi.getTimerCount()).toBe(1);
    send({ type: "pinta-nav-stop" });
    expect(vi.getTimerCount()).toBe(0);

    parent.postMessage.mockClear();
    history.pushState({}, "", "/after-stop");
    vi.advanceTimersByTime(3000);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(navReports()).toHaveLength(0);

    // Restart re-reports the current URL (lastReported was reset).
    send({ type: "pinta-nav-start" });
    expect(navReports()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("polling reports SPA route changes while started", () => {
    send({ type: "pinta-nav-start" });
    parent.postMessage.mockClear();
    history.pushState({}, "", "/spa-route");
    vi.advanceTimersByTime(700);
    expect(navReports().map((c) => (c[0] as { url: string }).url)).toEqual([location.href]);
  });

  it("ignores a stop from a foreign origin or a non-parent source", () => {
    send({ type: "pinta-nav-start" });
    send({ type: "pinta-nav-stop" }, "http://localhost:5173");
    send({ type: "pinta-nav-stop" }, "chrome-extension://otherotherotherotherotherotherot");
    send({ type: "pinta-nav-stop" }, EXT_ORIGIN, {});
    expect(vi.getTimerCount()).toBe(1);

    parent.postMessage.mockClear();
    history.pushState({}, "", "/still-reporting");
    vi.advanceTimersByTime(700);
    expect(navReports()).toHaveLength(1);
  });

  it("ignores a start from a foreign origin", () => {
    send({ type: "pinta-nav-start" }, "https://evil.example");
    expect(vi.getTimerCount()).toBe(0);
    expect(navReports()).toHaveLength(0);
  });

  it("ignores an opaque \"null\" origin (sandboxed / data: frames)", () => {
    send({ type: "pinta-nav-start" }, "null");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stop before any start is a no-op", () => {
    send({ type: "pinta-nav-stop" });
    expect(vi.getTimerCount()).toBe(0);
    send({ type: "pinta-nav-start" });
    expect(vi.getTimerCount()).toBe(1);
  });
});
