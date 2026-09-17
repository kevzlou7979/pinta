import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { Session } from "@pinta/shared";
import { SessionStore } from "./store.js";
import { startServer, type StartedServer } from "./server.js";
import { attachWebSocket } from "./ws.js";
import { HttpBackend } from "./mcp/backend.js";
import {
  ExtensionTrust,
  WEB_STORE_EXTENSION_ID,
  extensionIdFromOrigin,
  imageMediaTypeForPath,
  isLoopbackHost,
  isSafeSessionId,
  isWritingQueryComment,
  parseImageDataUrl,
  resolveInside,
} from "./security.js";

const OTHER_EXT = "abcdefghijklmnopabcdefghijklmnop"; // 32 chars a-p
const THIRD_EXT = "ponmlkjihgfedcbaponmlkjihgfedcba";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: "test-123",
    url: "http://localhost:5173/",
    projectRoot: "",
    startedAt: Date.now(),
    annotations: [],
    status: "submitted",
    producer: "test",
    ...over,
  } as Session;
}

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function http(
  port: number,
  method: string,
  path: string,
  opts: { origin?: string; host?: string; body?: unknown } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (opts.origin) headers.Origin = opts.origin;
    if (opts.host) headers.Host = opts.host;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function wsConnect(
  port: number,
  origin?: string,
): Promise<{ ok: true; socket: WebSocket } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`, origin ? { origin } : {});
    socket.once("open", () => resolve({ ok: true, socket }));
    socket.once("unexpected-response", (_req, res) => {
      resolve({ ok: false, status: res.statusCode ?? 0 });
      socket.terminate();
    });
    socket.once("error", () => {});
  });
}

function nextMessage(socket: WebSocket, type: string): Promise<{ type: string; [k: string]: unknown }> {
  return new Promise((resolve) => {
    const onMsg = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { type: string };
      if (msg.type === type) {
        socket.off("message", onMsg);
        resolve(msg);
      }
    };
    socket.on("message", onMsg);
  });
}

describe("security primitives", () => {
  it("accepts only path-safe session ids", () => {
    for (const ok of ["test-1", "3f1c2e9a-1b2c-4d5e-8f90-123456789abc", "a_B-9"]) {
      expect(isSafeSessionId(ok)).toBe(true);
    }
    for (const bad of ["../../package", "a/b", "a\\b", "..", "a.b", "", "x".repeat(65), 5]) {
      expect(isSafeSessionId(bad)).toBe(false);
    }
  });

  it("resolveInside refuses escapes", () => {
    const base = join(tmpdir(), "pinta-base");
    expect(resolveInside(base, "ok.json")).toBe(join(base, "ok.json"));
    expect(() => resolveInside(base, "../x.json")).toThrow();
    expect(() => resolveInside(base, "..")).toThrow();
  });

  it("parses PNG/JPEG data URLs and rejects other formats", () => {
    expect(parseImageDataUrl(PNG)).toMatchObject({ ext: "png", mediaType: "image/png" });
    expect(parseImageDataUrl(JPEG)).toMatchObject({ ext: "jpg", mediaType: "image/jpeg" });
    expect(parseImageDataUrl("data:image/jpg;base64,AAAA")).toMatchObject({ ext: "jpg" });
    expect(parseImageDataUrl(GIF)).toBeNull();
    expect(parseImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(imageMediaTypeForPath(".pinta/sessions/a.jpg")).toBe("image/jpeg");
    expect(imageMediaTypeForPath(".pinta/sessions/a.png")).toBe("image/png");
    expect(imageMediaTypeForPath("/etc/passwd")).toBeNull();
  });

  it("extracts extension ids only from well-formed chrome-extension origins", () => {
    expect(extensionIdFromOrigin(`chrome-extension://${WEB_STORE_EXTENSION_ID}`)).toBe(WEB_STORE_EXTENSION_ID);
    expect(extensionIdFromOrigin("https://evil.example")).toBeNull();
    expect(extensionIdFromOrigin("chrome-extension://short")).toBeNull();
    expect(extensionIdFromOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop.evil.com")).toBeNull();
  });

  it("isLoopbackHost blocks DNS-rebinding hosts", () => {
    expect(isLoopbackHost("127.0.0.1:7878")).toBe(true);
    expect(isLoopbackHost("localhost:7878")).toBe(true);
    expect(isLoopbackHost("[::1]:7878")).toBe(true);
    expect(isLoopbackHost("evil.example:7878")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
  });

  it("classifies writing ops", () => {
    for (const op of ["audit-fix", "variants-apply", "review-fix", "git-commit", "test-file-issues", "audit-file-issue"]) {
      expect(isWritingQueryComment(JSON.stringify({ op }))).toBe(true);
    }
    expect(isWritingQueryComment(JSON.stringify({ op: "chat" }))).toBe(false);
    expect(isWritingQueryComment("plain text")).toBe(false);
  });
});

describe("ExtensionTrust (I4 — trust-on-first-use)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinta-trust-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("always trusts the Web Store id and env-listed ids; an explicit list disables TOFU", () => {
    const trust = new ExtensionTrust(dir, { allowIds: [OTHER_EXT] });
    expect(trust.check(WEB_STORE_EXTENSION_ID)).toBe("trusted");
    expect(trust.check(OTHER_EXT)).toBe("trusted");
    expect(trust.check(THIRD_EXT)).toBe("untrusted");
    expect(trust.pinOrCheck(THIRD_EXT)).toBe(false);
    expect(new ExtensionTrust(dir, { allowIds: [] }).check(THIRD_EXT)).toBe("unpinned");
  });

  it("the Web Store build takes the TOFU slot so a rogue extension can't claim it later", () => {
    const trust = new ExtensionTrust(dir, { allowIds: [] });
    expect(trust.pinOrCheck(WEB_STORE_EXTENSION_ID)).toBe(true);
    expect(trust.check(OTHER_EXT)).toBe("untrusted");
    expect(trust.pinOrCheck(OTHER_EXT)).toBe(false);
  });

  it("pins the first extension, refuses a different one, and re-opens when the pin file is deleted", async () => {
    const logs: string[] = [];
    const trust = new ExtensionTrust(dir, { allowIds: [], log: (m) => logs.push(m) });
    expect(trust.pinOrCheck(OTHER_EXT)).toBe(true);
    expect(logs.some((l) => l.includes(`trusted extension ${OTHER_EXT}`))).toBe(true);
    const pin = JSON.parse(await readFile(join(dir, ".pinta", "trusted-extension.json"), "utf8"));
    expect(pin.id).toBe(OTHER_EXT);

    expect(trust.pinOrCheck(THIRD_EXT)).toBe(false);
    expect(trust.check(THIRD_EXT)).toBe("untrusted");
    expect(logs.some((l) => l.includes("trusted-extension.json") && l.includes("PINTA_EXTENSION_IDS"))).toBe(true);

    // A fresh instance (companion restart) honors the pin on disk.
    expect(new ExtensionTrust(dir, { allowIds: [] }).check(THIRD_EXT)).toBe("untrusted");

    await unlink(join(dir, ".pinta", "trusted-extension.json"));
    expect(trust.check(THIRD_EXT)).toBe("unpinned");
  });
});

describe("SessionStore hardening (C1 + I9)", () => {
  let dir: string;
  let store: SessionStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinta-sec-store-"));
    store = new SessionStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a traversal session id and writes nothing outside .pinta/sessions", async () => {
    await writeFile(join(dir, "package.json"), "{\"name\":\"victim\"}", "utf8");
    await expect(
      store.ingestSession(fakeSession({ id: "../../package", fullPageScreenshot: PNG })),
    ).rejects.toThrow(/invalid session id/);
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe("{\"name\":\"victim\"}");
    await expect(stat(join(dir, ".pinta", "package.json"))).rejects.toThrow();
    expect(store.list()).toHaveLength(0);
  });

  it("ignores client projectRoot / autoApply / screenshot path on ingest", async () => {
    const stored = await store.ingestSession(
      fakeSession({
        projectRoot: "C:/somewhere/else",
        autoApply: true,
        fullPageScreenshotPath: "/etc/passwd",
      }),
    );
    expect(stored.projectRoot).toBe(dir);
    expect(stored.autoApply).toBe(false);
    expect(stored.fullPageScreenshotPath).toBeUndefined();
  });

  it("restore skips persisted sessions with unsafe ids", async () => {
    const sessionsDir = join(dir, ".pinta", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "evil.json"), JSON.stringify(fakeSession({ id: "../evil" })), "utf8");
    await writeFile(join(sessionsDir, "good.json"), JSON.stringify(fakeSession({ id: "good" })), "utf8");
    await store.restore();
    expect(store.list().map((s) => s.id)).toEqual(["good"]);
  });

  it("does not write a doc-parse test doc for a traversal docId", async () => {
    const draft = store.createSession({ url: "http://x/", ephemeral: true });
    store.addAnnotation(draft.id, {
      id: "q",
      createdAt: 0,
      kind: "query",
      strokes: [],
      color: "#000",
      comment: JSON.stringify({ op: "doc-parse", docId: "../../pwn", filename: "a.md", content: "x" }),
    } as never);
    const s = await store.submit(draft.id, undefined, true, [{ id: "test-pilot", settings: {} }]);
    await expect(stat(join(dir, "pwn.md"))).rejects.toThrow();
    expect(s.annotations[0]!.comment).not.toContain("\"content\"");
    await expect(store.writeTestDoc("../x", "y")).rejects.toThrow(/invalid docId/);
  });

  it("writes JPEG screenshots as .jpg, PNG as .png, and rejects other formats", async () => {
    const a = store.createSession({ url: "http://x/", ephemeral: true });
    const sa = await store.submit(a.id, JPEG);
    expect(sa.fullPageScreenshotPath).toBe(`.pinta/sessions/${a.id}.jpg`);
    expect((await stat(join(dir, sa.fullPageScreenshotPath!))).isFile()).toBe(true);

    const b = store.createSession({ url: "http://x/", ephemeral: true });
    const sb = await store.submit(b.id, PNG);
    expect(sb.fullPageScreenshotPath).toBe(`.pinta/sessions/${b.id}.png`);

    const c = store.createSession({ url: "http://x/", ephemeral: true });
    await expect(store.submit(c.id, GIF)).rejects.toThrow(/PNG or JPEG/);
    expect(store.get(c.id)!.status).toBe("drafting");
    await expect(store.ingestSession(fakeSession({ id: "gif", fullPageScreenshot: GIF }))).rejects.toThrow(/PNG or JPEG/);
  });

  it("purgeAllSessions keeps the drafting session's .jpg as well as .png", async () => {
    const other = store.createSession({ url: "http://x/", ephemeral: true });
    await store.submit(other.id, JPEG);
    const draft = store.createSession({ url: "http://x/" });
    const sessionsDir = join(dir, ".pinta", "sessions");
    await writeFile(join(sessionsDir, `${draft.id}.jpg`), "x");
    await writeFile(join(sessionsDir, `${draft.id}.json`), "{}");
    await store.purgeAllSessions();
    expect((await readdir(sessionsDir)).sort()).toEqual([`${draft.id}.jpg`, `${draft.id}.json`].sort());
  });
});

describe("HTTP origin gate + ingest (C1, I2, I4, I9) — live server", () => {
  let dir: string;
  let store: SessionStore;
  let started: StartedServer;
  let port: number;
  let trust: ExtensionTrust;
  const ext = (id: string) => `chrome-extension://${id}`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinta-sec-http-"));
    store = new SessionStore(dir);
    trust = new ExtensionTrust(dir, { allowIds: [] });
    started = await startServer({ port: 0, store, trust });
    port = (started.server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await started.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("POST /v1/sessions rejects traversal ids with 400 and forces projectRoot/autoApply", async () => {
    const bad = await http(port, "POST", "/v1/sessions", { body: fakeSession({ id: "../../package" }) });
    expect(bad.status).toBe(400);
    const good = await http(port, "POST", "/v1/sessions", {
      body: fakeSession({ projectRoot: "/elsewhere", autoApply: true }),
    });
    expect(good.status).toBe(201);
    const body = JSON.parse(good.body) as Session;
    expect(body.projectRoot).toBe(dir);
    expect(body.autoApply).toBe(false);
    expect((await http(port, "GET", "/v1/sessions/..%2F..%2Fpackage")).status).toBe(400);
  });

  it("web origins get 403 everywhere except a minimal /v1/health, and never an ACAO header", async () => {
    const evil = "https://evil.example";
    for (const path of ["/v1/sessions", "/v1/sessions/stream", "/v1/registry", "/v1/sessions/active", "/v1/modules"]) {
      const r = await http(port, "GET", path, { origin: evil });
      expect(r.status, path).toBe(403);
      expect(r.headers["access-control-allow-origin"], path).toBeUndefined();
    }
    const pre = await http(port, "OPTIONS", "/v1/sessions", { origin: evil });
    expect(pre.status).toBe(403);
    const health = await http(port, "GET", "/v1/health", { origin: evil });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });
    expect(health.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("no-Origin callers (agent curl / MCP) keep full access; the extension gets ACAO echoed", async () => {
    const health = JSON.parse((await http(port, "GET", "/v1/health")).body);
    expect(health.projectRoot).toBe(dir);
    expect((await http(port, "GET", "/v1/sessions")).status).toBe(200);

    const fromExt = await http(port, "GET", "/v1/health", { origin: ext(WEB_STORE_EXTENSION_ID) });
    expect(fromExt.status).toBe(200);
    expect(JSON.parse(fromExt.body).projectRoot).toBe(dir);
    expect(fromExt.headers["access-control-allow-origin"]).toBe(ext(WEB_STORE_EXTENSION_ID));
    expect((await http(port, "GET", "/v1/sessions", { origin: ext(WEB_STORE_EXTENSION_ID) })).status).toBe(200);
  });

  it("rejects a DNS-rebound Host header", async () => {
    const r = await http(port, "GET", "/v1/sessions", { host: `evil.example:${port}` });
    expect(r.status).toBe(403);
  });

  it("module install needs the trusted extension — not no-Origin, not an unpinned or mismatched extension", async () => {
    const body = { package: {}, grantedCapabilities: [] };
    expect((await http(port, "POST", "/v1/modules", { body })).status).toBe(403);
    expect((await http(port, "POST", "/v1/modules", { body, origin: ext(OTHER_EXT) })).status).toBe(403);

    trust.pinOrCheck(OTHER_EXT);
    // Past the gate → the store's validation answers (400 empty package).
    expect((await http(port, "POST", "/v1/modules", { body, origin: ext(OTHER_EXT) })).status).toBe(400);
    expect((await http(port, "POST", "/v1/modules", { body, origin: ext(WEB_STORE_EXTENSION_ID) })).status).toBe(400);

    const rogue = await http(port, "POST", "/v1/modules", { body, origin: ext(THIRD_EXT) });
    expect(rogue.status).toBe(403);
    expect((await http(port, "GET", "/v1/sessions", { origin: ext(THIRD_EXT) })).status).toBe(403);
    expect((await http(port, "DELETE", "/v1/sessions", { origin: ext(THIRD_EXT) })).status).toBe(403);
    // …but discovery still works so the side panel can surface the problem.
    expect((await http(port, "GET", "/v1/health", { origin: ext(THIRD_EXT) })).status).toBe(200);
  });

  it("MCP get_screenshot returns image/jpeg for a .jpg screenshot (and PNG stays PNG)", async () => {
    const a = store.createSession({ url: "http://x/", ephemeral: true });
    await store.submit(a.id, JPEG);
    const b = store.createSession({ url: "http://x/", ephemeral: true });
    await store.submit(b.id, PNG);
    const backend = new HttpBackend(`http://127.0.0.1:${port}`);
    expect((await backend.getScreenshot(a.id))?.mediaType).toBe("image/jpeg");
    expect((await backend.getScreenshot(b.id))?.mediaType).toBe("image/png");
  });
});

describe("WebSocket gate (I4/AI6) — live server", () => {
  let dir: string;
  let store: SessionStore;
  let started: StartedServer;
  let port: number;
  let trust: ExtensionTrust;
  const sockets: WebSocket[] = [];

  async function boot(allowNoOriginWs: boolean) {
    started = await startServer({ port: 0, store, trust });
    attachWebSocket({ server: started.server, store, trust, allowNoOriginWs });
    port = (started.server.address() as AddressInfo).port;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinta-sec-ws-"));
    store = new SessionStore(dir);
    trust = new ExtensionTrust(dir, { allowIds: [] });
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    started.server.closeAllConnections?.();
    await started.close();
    await rm(dir, { recursive: true, force: true });
  });

  const writingQuery = (moduleId = "audit-flow") => ({
    type: "module.query.submit",
    moduleId,
    url: "http://x/",
    queryComment: JSON.stringify({ op: "audit-fix", checkId: "c1" }),
  });

  it("rejects web origins and no-Origin upgrades by default; pins the first extension and refuses a second", async () => {
    await boot(false);
    expect(await wsConnect(port)).toMatchObject({ ok: false, status: 403 });
    expect(await wsConnect(port, "https://evil.example")).toMatchObject({ ok: false, status: 403 });

    const first = await wsConnect(port, `chrome-extension://${OTHER_EXT}`);
    expect(first.ok).toBe(true);
    if (first.ok) sockets.push(first.socket);
    expect(trust.check(OTHER_EXT)).toBe("trusted");

    expect(await wsConnect(port, `chrome-extension://${THIRD_EXT}`)).toMatchObject({ ok: false, status: 403 });
    // Allow-listed Web Store id still connects even though another id holds the pin.
    const store2 = await wsConnect(port, `chrome-extension://${WEB_STORE_EXTENSION_ID}`);
    expect(store2.ok).toBe(true);
    if (store2.ok) sockets.push(store2.socket);
  });

  it("a trusted extension socket may submit writing ops (autoApply kept)", async () => {
    await boot(false);
    const c = await wsConnect(port, `chrome-extension://${WEB_STORE_EXTENSION_ID}`);
    if (!c.ok) throw new Error("connect failed");
    sockets.push(c.socket);
    const created = nextMessage(c.socket, "module.query.created");
    c.socket.send(JSON.stringify(writingQuery()));
    const msg = (await created) as { session: Session };
    expect(msg.session.autoApply).toBe(true);
    expect(msg.session.status).toBe("submitted");
  });

  it("an opted-in no-Origin socket is untrusted: writing ops refused, read-only ops pass, submits never auto-apply", async () => {
    await boot(true);
    const c = await wsConnect(port);
    if (!c.ok) throw new Error("connect failed");
    sockets.push(c.socket);

    const err = nextMessage(c.socket, "error");
    c.socket.send(JSON.stringify(writingQuery()));
    expect(String((await err).message)).toMatch(/writing ops/);
    expect(store.list().filter((s) => s.status === "submitted")).toHaveLength(0);

    const created = nextMessage(c.socket, "module.query.created");
    c.socket.send(
      JSON.stringify({ ...writingQuery("chat"), queryComment: JSON.stringify({ op: "chat", text: "hi" }) }),
    );
    expect(((await created) as { session: Session }).session.status).toBe("submitted");

    const synced = nextMessage(c.socket, "session.created");
    c.socket.send(JSON.stringify({ type: "session.create", url: "http://x/" }));
    await synced;
    const submitted = new Promise<Session>((resolve) => {
      c.socket.on("message", (raw: Buffer) => {
        const m = JSON.parse(raw.toString()) as { type: string; session?: Session };
        if (m.type === "session.synced" && m.session?.status === "submitted" && !m.session.modules) resolve(m.session);
      });
    });
    c.socket.send(JSON.stringify({ type: "session.submit", screenshot: "", autoApply: true }));
    expect((await submitted).autoApply).toBe(false);
  });
});
