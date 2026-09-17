import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCompanionHttpForTests,
  acquireCompanionToken,
  cachedCompanionToken,
  companionBaseOf,
  companionFetch,
  onCompanionToken,
  onCompanionUntrusted,
  withCompanionToken,
} from "./companion-http.js";
import { applyTokenResult } from "./companions.js";

const BASE = "http://127.0.0.1:7890";
const UNTRUSTED = {
  error: "untrusted-extension",
  extensionId: "abcdefghijklmnopabcdefghijklmnop",
  fix: "npx pinta-companion trust abcdefghijklmnopabcdefghijklmnop",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; method: string; auth: string | null };

/** Fake companion: issues tokens from `tokens` in order; gated GETs need the current one. */
function fakeCompanion(opts: { tokens?: string[]; untrusted?: boolean } = {}) {
  const tokens = [...(opts.tokens ?? ["t1"])];
  let current: string | null = null;
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("Authorization");
    calls.push({ url, method, auth });
    if (url.endsWith("/v1/auth/token")) {
      if (opts.untrusted) return json(403, UNTRUSTED);
      current = tokens.shift() ?? current;
      return json(200, { token: current });
    }
    if (auth !== `Bearer ${current}` || current === null) return json(401, { error: "auth-required" });
    return json(200, { ok: true });
  });
  return {
    fetchMock,
    calls,
    /** Simulate a companion restart: the old token stops working. */
    restart: () => {
      current = tokens.shift() ?? null;
    },
  };
}

beforeEach(() => {
  __resetCompanionHttpForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("companion-http", () => {
  it("companionBaseOf / withCompanionToken", () => {
    expect(companionBaseOf(`${BASE}/v1/report-shot?key=a`)).toBe(BASE);
    expect(companionBaseOf("chrome-extension://x/y")).toBeNull();
    expect(withCompanionToken(`${BASE}/v1/report-shot?key=a`, "a b")).toBe(`${BASE}/v1/report-shot?key=a&token=a%20b`);
    expect(withCompanionToken(`${BASE}/v1/sessions`, "t")).toBe(`${BASE}/v1/sessions?token=t`);
    // Nothing cached → URL unchanged.
    expect(withCompanionToken(`${BASE}/v1/sessions`)).toBe(`${BASE}/v1/sessions`);
  });

  it("acquires the token once (POST), caches it and attaches Authorization", async () => {
    const c = fakeCompanion();
    vi.stubGlobal("fetch", c.fetchMock);
    const seen: (string | null)[] = [];
    onCompanionToken((_b, t) => seen.push(t));
    const [a, b] = await Promise.all([companionFetch(`${BASE}/v1/sessions`), companionFetch(`${BASE}/v1/modules`)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.calls.filter((x) => x.url.endsWith("/v1/auth/token"))).toHaveLength(1);
    expect(c.calls.find((x) => x.url.endsWith("/v1/auth/token"))!.method).toBe("POST");
    expect(c.calls.filter((x) => !x.url.endsWith("/v1/auth/token")).every((x) => x.auth === "Bearer t1")).toBe(true);
    expect(cachedCompanionToken(BASE)).toBe("t1");
    expect(withCompanionToken(`${BASE}/v1/report-shot?key=k`)).toBe(`${BASE}/v1/report-shot?key=k&token=t1`);
    expect(seen).toEqual(["t1"]);
  });

  it("on 401 refreshes the token once and retries", async () => {
    const c = fakeCompanion({ tokens: ["t1", "t2"] });
    vi.stubGlobal("fetch", c.fetchMock);
    expect((await companionFetch(`${BASE}/v1/sessions`)).status).toBe(200);
    c.restart(); // companion restarted: "t2" is now valid, the cached "t1" isn't
    c.calls.length = 0;
    // restart() consumed t2 as current; the refresh POST hands back the same current token.
    const res = await companionFetch(`${BASE}/v1/sessions`);
    expect(res.status).toBe(200);
    expect(c.calls.map((x) => `${x.method} ${x.url.replace(BASE, "")} ${x.auth ?? "-"}`)).toEqual([
      "GET /v1/sessions Bearer t1",
      "POST /v1/auth/token -",
      "GET /v1/sessions Bearer t2",
    ]);
    expect(cachedCompanionToken(BASE)).toBe("t2");
  });

  it("retries only once — a second 401 is returned to the caller", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/v1/auth/token") ? json(200, { token: "bad" }) : json(401, { error: "auth-required" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await companionFetch(`${BASE}/v1/sessions`);
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(4); // token, GET, token (refresh), GET
  });

  it("an untrusted-extension 403 on the token endpoint is a typed result + listener signal, no token cached", async () => {
    const c = fakeCompanion({ untrusted: true });
    vi.stubGlobal("fetch", c.fetchMock);
    const refusals: unknown[] = [];
    onCompanionUntrusted((base, r) => refusals.push({ base, ...r }));
    const r = await acquireCompanionToken(BASE);
    expect(r).toEqual({ kind: "untrusted", refusal: { extensionId: UNTRUSTED.extensionId, fix: UNTRUSTED.fix } });
    expect(refusals).toEqual([{ base: BASE, extensionId: UNTRUSTED.extensionId, fix: UNTRUSTED.fix }]);
    expect(cachedCompanionToken(BASE)).toBeNull();
    // companionFetch doesn't loop: token refused → request sent bare → 401 returned.
    const res = await companionFetch(`${BASE}/v1/sessions`);
    expect(res.status).toBe(401);
  });

  it("an untrusted-extension 403 from a gated call (token revoked by untrust) signals and drops the token", async () => {
    let revoked = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/auth/token")) return json(200, { token: "t1" });
      return revoked ? json(403, UNTRUSTED) : json(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);
    const refusals: string[] = [];
    onCompanionUntrusted((base) => refusals.push(base));
    expect((await companionFetch(`${BASE}/v1/sessions`)).status).toBe(200);
    revoked = true;
    expect((await companionFetch(`${BASE}/v1/sessions`)).status).toBe(403);
    expect(refusals).toEqual([BASE]);
    expect(cachedCompanionToken(BASE)).toBeNull();
  });

  it("network failure / old companion without the route → unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { error: "not found" })));
    expect(await acquireCompanionToken(BASE)).toEqual({ kind: "unavailable" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    expect(await acquireCompanionToken(BASE, { refresh: true })).toEqual({ kind: "unavailable" });
  });

  it("discovery: a healthy companion that refuses the token becomes an untrusted result", () => {
    const healthy = { kind: "companion" as const, companion: { port: 7890, projectRoot: "/p", urlPatterns: [] } };
    expect(applyTokenResult(healthy, { kind: "token", token: "t" })).toBe(healthy);
    expect(applyTokenResult(healthy, { kind: "unavailable" })).toBe(healthy);
    expect(
      applyTokenResult(healthy, { kind: "untrusted", refusal: { extensionId: "x", fix: "npx pinta-companion trust x" } }),
    ).toEqual({ kind: "untrusted", untrusted: { port: 7890, extensionId: "x", fix: "npx pinta-companion trust x" } });
  });
});
