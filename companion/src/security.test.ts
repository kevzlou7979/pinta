import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { Session } from "@pinta/shared";
import { SessionStore } from "./store.js";
import { startServer, type StartedServer } from "./server.js";
import { attachWebSocket } from "./ws.js";
import { HttpBackend } from "./mcp/backend.js";
import { runTrustCommand } from "./trust-cli.js";
import {
  ExtensionTrust,
  WEB_STORE_EXTENSION_ID,
  WRITING_QUERY_OPS,
  TrustStoreCorruptError,
  addTrustedId,
  gitTrackState,
  migrateLegacyPin,
  readTrustStore,
  removeTrustedId,
  extensionIdFromOrigin,
  imageMediaTypeForPath,
  isLoopbackHost,
  isSafeSessionId,
  isWritingQueryComment,
  queryOpOf,
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
  opts: { origin?: string; host?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...opts.headers };
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
    for (const op of ["audit-fix", "variants-apply", "review-fix", "git-commit", "test-file-issues", "audit-file-issue", "import-file-issues"]) {
      expect(isWritingQueryComment(JSON.stringify({ op }))).toBe(true);
    }
    expect(isWritingQueryComment(JSON.stringify({ op: "chat" }))).toBe(false);
    expect(isWritingQueryComment("plain text")).toBe(false);
  });

  it("queryOpOf tolerates malformed / adversarial op JSON", () => {
    // Leading whitespace before the JSON object still parses.
    expect(queryOpOf('  {"op":"import-file-issues"}')).toBe("import-file-issues");
    expect(isWritingQueryComment('  {"op":"import-file-issues","importedId":"x"}')).toBe(true);
    // Non-string op, empty object, truncated JSON → null, never a throw.
    expect(queryOpOf('{"op":5}')).toBeNull();
    expect(queryOpOf('{"op":null}')).toBeNull();
    expect(queryOpOf("{}")).toBeNull();
    expect(queryOpOf('{"op":"import-file-issues"')).toBeNull();
    // JSON that isn't an object literal at the top level → null.
    expect(queryOpOf('[{"op":"import-file-issues"}]')).toBeNull();
    expect(queryOpOf('"import-file-issues"')).toBeNull();
    // Non-string comments → null.
    expect(queryOpOf(5)).toBeNull();
    expect(queryOpOf(null)).toBeNull();
    expect(queryOpOf(undefined)).toBeNull();
    expect(queryOpOf({ op: "import-file-issues" })).toBeNull();
    // Only the TOP-LEVEL op counts — a nested writing op can't smuggle in.
    expect(isWritingQueryComment('{"op":"chat","inner":{"op":"import-file-issues"}}')).toBe(false);
    for (const c of [5, null, undefined, "{}", '{"op":"import-file-issues"']) {
      expect(isWritingQueryComment(c), String(c)).toBe(false);
    }
  });

  it("import-file-issues is registered as a writing op", () => {
    expect(WRITING_QUERY_OPS.has("import-file-issues")).toBe(true);
    expect(
      isWritingQueryComment(
        JSON.stringify({ op: "import-file-issues", importedId: "imp-1", items: [], fallbackToLocal: true }),
      ),
    ).toBe(true);
  });
});

describe("ExtensionTrust (AI2 — out-of-band trust, no silent pin)", () => {
  let dir: string;
  let userStorePath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinta-trust-"));
    userStorePath = join(dir, "home", ".pinta", "trusted-extensions.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("trusts the Web Store id, env-listed ids and user-store ids — nothing else", () => {
    const trust = new ExtensionTrust(dir, { allowIds: [OTHER_EXT], userStorePath });
    expect(trust.check(WEB_STORE_EXTENSION_ID)).toBe("trusted");
    expect(trust.check(OTHER_EXT)).toBe("trusted");
    expect(trust.check(THIRD_EXT)).toBe("untrusted");
    expect(trust.verify(THIRD_EXT)).toBe(false);
    expect(trust.check(null)).toBe("untrusted");
  });

  it("never pins: the first unknown extension to connect is refused and nothing is written", async () => {
    const logs: string[] = [];
    const trust = new ExtensionTrust(dir, { allowIds: [], userStorePath, log: (m) => logs.push(m) });
    expect(trust.verify(OTHER_EXT)).toBe(false);
    expect(trust.verify(OTHER_EXT)).toBe(false);
    expect(trust.verify(WEB_STORE_EXTENSION_ID)).toBe(true);
    expect(trust.check(OTHER_EXT)).toBe("untrusted");
    await expect(stat(userStorePath)).rejects.toThrow();
    await expect(stat(join(dir, ".pinta"))).rejects.toThrow();
    // One log line per refused id, naming the CLI fix.
    expect(logs.filter((l) => l.includes(`npx pinta-companion trust ${OTHER_EXT}`))).toHaveLength(1);
  });

  it("trust/untrust in the user store take effect without a restart", () => {
    const trust = new ExtensionTrust(dir, { allowIds: [], userStorePath });
    expect(trust.check(OTHER_EXT)).toBe("untrusted");
    expect(addTrustedId(userStorePath, OTHER_EXT)).toBe(true);
    expect(trust.check(OTHER_EXT)).toBe("trusted");
    expect(trust.check(THIRD_EXT)).toBe("untrusted");
    expect(removeTrustedId(userStorePath, OTHER_EXT)).toBe(true);
    expect(trust.check(OTHER_EXT)).toBe("untrusted");
  });

  it("trust store read/write: idempotent add, remove, malformed file and ids ignored", async () => {
    expect(readTrustStore(userStorePath)).toEqual({ ids: [] });
    expect(addTrustedId(userStorePath, ` ${OTHER_EXT.toUpperCase()} `)).toBe(true);
    expect(addTrustedId(userStorePath, OTHER_EXT)).toBe(false);
    expect(addTrustedId(userStorePath, THIRD_EXT)).toBe(true);
    const file = readTrustStore(userStorePath);
    expect(file.ids.map((e) => e.id)).toEqual([OTHER_EXT, THIRD_EXT]);
    expect(file.ids[0]!.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(removeTrustedId(userStorePath, OTHER_EXT)).toBe(true);
    expect(removeTrustedId(userStorePath, OTHER_EXT)).toBe(false);
    expect(readTrustStore(userStorePath).ids.map((e) => e.id)).toEqual([THIRD_EXT]);
    expect(() => addTrustedId(userStorePath, "not-an-id")).toThrow(/invalid extension id/);
    expect(() => removeTrustedId(userStorePath, "../../etc")).toThrow(/invalid extension id/);

    await writeFile(userStorePath, JSON.stringify({ ids: [{ id: "bad" }, { id: OTHER_EXT, addedAt: 5 }, null] }));
    expect(readTrustStore(userStorePath)).toEqual({ ids: [{ id: OTHER_EXT, addedAt: "" }] });
    await writeFile(userStorePath, "{not json");
    expect(readTrustStore(userStorePath)).toEqual({ ids: [] });
  });

  it("refuses to overwrite a corrupt store (F72) and writes atomically", async () => {
    await mkdir(join(dir, "home", ".pinta"), { recursive: true });
    for (const bad of ["{not json", JSON.stringify({ other: 1 }), "[]"]) {
      await writeFile(userStorePath, bad);
      expect(() => addTrustedId(userStorePath, OTHER_EXT), bad).toThrow(TrustStoreCorruptError);
      expect(() => removeTrustedId(userStorePath, OTHER_EXT), bad).toThrow(/refusing to overwrite/);
      expect(await readFile(userStorePath, "utf8"), bad).toBe(bad);
    }
    await unlink(userStorePath);
    expect(addTrustedId(userStorePath, OTHER_EXT)).toBe(true);
    expect(addTrustedId(userStorePath, THIRD_EXT)).toBe(true);
    // No temp files left beside the store.
    expect((await readdir(join(dir, "home", ".pinta"))).sort()).toEqual(["trusted-extensions.json"]);
    expect(readTrustStore(userStorePath).ids.map((e) => e.id)).toEqual([OTHER_EXT, THIRD_EXT]);
  });
});

describe("legacy per-project pin migration", () => {
  let dir: string;
  let userStorePath: string;
  const legacy = () => join(dir, ".pinta", "trusted-extension.json");
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinta-migrate-"));
    userStorePath = join(dir, "home", "trusted-extensions.json");
    await mkdir(join(dir, ".pinta"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does nothing when there is no legacy pin", async () => {
    expect(migrateLegacyPin(dir, userStorePath, () => {}, () => "untracked")).toBe("none");
    await expect(stat(userStorePath)).rejects.toThrow();
  });

  it("merges an untracked pin into the user store once and renames the file", async () => {
    await writeFile(legacy(), JSON.stringify({ id: OTHER_EXT, pinnedAt: "x" }));
    const logs: string[] = [];
    expect(migrateLegacyPin(dir, userStorePath, (m) => logs.push(m), () => "untracked")).toBe("migrated");
    expect(readTrustStore(userStorePath).ids.map((e) => e.id)).toEqual([OTHER_EXT]);
    expect(logs.some((l) => l.includes(`migrated trusted extension ${OTHER_EXT}`))).toBe(true);
    await expect(stat(legacy())).rejects.toThrow();
    expect((await stat(`${legacy()}.migrated`)).isFile()).toBe(true);
    // A later untrust sticks: the next startup finds nothing to migrate.
    removeTrustedId(userStorePath, OTHER_EXT);
    expect(migrateLegacyPin(dir, userStorePath, () => {}, () => "untracked")).toBe("none");
    expect(readTrustStore(userStorePath).ids).toEqual([]);
  });

  it("F70: a pin git can't vouch for (not a work tree / no git) is ignored and the trust command logged", async () => {
    await writeFile(legacy(), JSON.stringify({ id: OTHER_EXT }));
    const logs: string[] = [];
    expect(gitTrackState(dir, ".pinta/trusted-extension.json")).toBe("unknown");
    expect(migrateLegacyPin(dir, userStorePath, (m) => logs.push(m))).toBe("ignored-no-git");
    expect(migrateLegacyPin(dir, userStorePath, () => {}, () => "unknown")).toBe("ignored-no-git");
    expect(readTrustStore(userStorePath).ids).toEqual([]);
    expect((await stat(legacy())).isFile()).toBe(true);
    expect(logs.some((l) => l.includes("npx pinta-companion trust <extension-id>"))).toBe(true);
  });

  it("F70: uses the real git check — an untracked pin in a work tree migrates, a committed one doesn't", async () => {
    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    await writeFile(legacy(), JSON.stringify({ id: OTHER_EXT }));
    expect(gitTrackState(dir, ".pinta/trusted-extension.json")).toBe("untracked");
    git("add", ".pinta/trusted-extension.json");
    git("commit", "-q", "-m", "pin");
    expect(gitTrackState(dir, ".pinta/trusted-extension.json")).toBe("tracked");
    expect(migrateLegacyPin(dir, userStorePath, () => {})).toBe("ignored-tracked");
    git("rm", "-q", "--cached", ".pinta/trusted-extension.json");
    expect(migrateLegacyPin(dir, userStorePath, () => {})).toBe("migrated");
    expect(readTrustStore(userStorePath).ids.map((e) => e.id)).toEqual([OTHER_EXT]);
  });

  it("F71: nothing is trusted when the pin can't be renamed", async () => {
    await writeFile(legacy(), JSON.stringify({ id: OTHER_EXT }));
    // A non-empty directory at the *.migrated path makes the rename fail on every OS.
    await mkdir(join(`${legacy()}.migrated`, "block"), { recursive: true });
    const logs: string[] = [];
    expect(migrateLegacyPin(dir, userStorePath, (m) => logs.push(m), () => "untracked")).toBe("rename-failed");
    expect(readTrustStore(userStorePath).ids).toEqual([]);
    expect((await stat(legacy())).isFile()).toBe(true);
    expect(logs.some((l) => l.includes(`npx pinta-companion trust ${OTHER_EXT}`))).toBe(true);
  });

  it("F71/F72: a corrupt user store leaves the pin in place and the store untouched", async () => {
    await writeFile(legacy(), JSON.stringify({ id: OTHER_EXT }));
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(userStorePath, "{oops");
    expect(migrateLegacyPin(dir, userStorePath, () => {}, () => "untracked")).toBe("invalid");
    expect(await readFile(userStorePath, "utf8")).toBe("{oops");
    expect((await stat(legacy())).isFile()).toBe(true);
  });

  it("ignores a git-tracked pin with a warning and trusts nothing", async () => {
    await writeFile(legacy(), JSON.stringify({ id: OTHER_EXT }));
    const logs: string[] = [];
    const tracked = (root: string, rel: string) =>
      root === dir && rel === ".pinta/trusted-extension.json" ? ("tracked" as const) : ("untracked" as const);
    expect(migrateLegacyPin(dir, userStorePath, (m) => logs.push(m), tracked)).toBe("ignored-tracked");
    expect(readTrustStore(userStorePath).ids).toEqual([]);
    expect((await stat(legacy())).isFile()).toBe(true);
    expect(logs.some((l) => l.includes("git-tracked"))).toBe(true);
    expect(new ExtensionTrust(dir, { allowIds: [], userStorePath }).check(OTHER_EXT)).toBe("untrusted");
  });

  it("ignores a malformed pin", async () => {
    await writeFile(legacy(), JSON.stringify({ id: "../../nope" }));
    expect(migrateLegacyPin(dir, userStorePath, () => {}, () => "untracked")).toBe("invalid");
    expect(readTrustStore(userStorePath).ids).toEqual([]);
  });
});

describe("pinta-companion trust / untrust CLI", () => {
  let dir: string;
  let storePath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinta-trust-cli-"));
    storePath = join(dir, "trusted-extensions.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("validates arguments and ids", () => {
    for (const argv of [["trust"], ["untrust"], ["trust", OTHER_EXT, "extra"], ["trust", "--bogus"], ["untrust", "--list"]]) {
      const r = runTrustCommand(argv, storePath, undefined);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.out).toMatch(/Usage:/);
    }
    const bad = runTrustCommand(["trust", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"], storePath, undefined);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/Invalid extension id/);
    expect(runTrustCommand(["trust", "abc"], storePath, undefined).code).toBe(1);
    expect(readTrustStore(storePath).ids).toEqual([]);
  });

  it("trust, list, untrust — printing what changed", () => {
    const t = runTrustCommand(["trust", OTHER_EXT], storePath, undefined);
    expect(t).toMatchObject({ code: 0 });
    expect(t.out).toContain(`Trusted extension ${OTHER_EXT}`);
    expect(runTrustCommand(["trust", OTHER_EXT], storePath, undefined).out).toContain("already trusted");

    const list = runTrustCommand(["trust", "--list"], storePath, THIRD_EXT);
    expect(list.code).toBe(0);
    expect(list.out).toContain(WEB_STORE_EXTENSION_ID);
    expect(list.out).toContain(OTHER_EXT);
    expect(list.out).toContain(`PINTA_EXTENSION_IDS: ${THIRD_EXT}`);

    const u = runTrustCommand(["untrust", OTHER_EXT], storePath, undefined);
    expect(u.out).toContain(`Untrusted extension ${OTHER_EXT}`);
    expect(runTrustCommand(["untrust", OTHER_EXT], storePath, undefined).out).toContain("nothing changed");
    expect(runTrustCommand(["trust", "--list"], storePath, undefined).out).toContain("(none)");
  });

  it("F72: exits 1 with a clear error and leaves a corrupt store untouched", async () => {
    await writeFile(storePath, "{hand-edited");
    for (const argv of [["trust", OTHER_EXT], ["untrust", OTHER_EXT], ["trust", "--list"]]) {
      const res = runTrustCommand(argv, storePath, undefined);
      expect(res.code, argv.join(" ")).toBe(1);
      expect(res.out, argv.join(" ")).toMatch(/not a valid trust store.*refusing to overwrite/);
    }
    expect(await readFile(storePath, "utf8")).toBe("{hand-edited");
  });
});

describe("WRITING_QUERY_OPS matches the SKILL.md §7.9 Writing-ops column", () => {
  it("has set parity with the table", async () => {
    const skill = await readFile(fileURLToPath(new URL("../../skill/pinta/SKILL.md", import.meta.url)), "utf8");
    const start = skill.indexOf("| Module id | § | Read-only ops | Writing ops");
    expect(start).toBeGreaterThan(-1);
    const rows = skill
      .slice(start)
      .split(/\r?\n/)
      .map((l) => l.replace(/^>\s?/, "").trim())
      .filter((l, i, all) => l.startsWith("|") && all.slice(0, i + 1).every((x) => x.startsWith("|")))
      .slice(2); // header + separator
    expect(rows.length).toBeGreaterThan(5);
    const ops = new Set<string>();
    for (const row of rows) {
      const cells = row.split("|").slice(1, -1).map((c) => c.trim());
      const writing = cells[3] ?? "";
      // Each op is a leading backticked token of a comma-separated entry;
      // the parenthesised notes after it (`glab`, paths) are not ops.
      for (const entry of writing.replace(/\([^)]*\)/g, "").split(",")) {
        const m = /^`?([a-z][a-z0-9-]*)`?$/.exec(entry.trim());
        if (m) ops.add(m[1]!);
      }
    }
    expect([...ops].sort()).toEqual([...WRITING_QUERY_OPS].sort());
  });
});

describe("SKILL.md security rules the companion relies on (AI1, AI4, AI6)", () => {
  const skillPath = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
  const flat = (s: string) => s.replace(/^>\s?/gm, "").replace(/\s+/g, " ");

  it("§7.9 gates writing ops on the companion-only ws-query origin marker", async () => {
    const skill = flat(await readFile(skillPath("skill/pinta/SKILL.md"), "utf8"));
    expect(skill).toMatch(/session\.origin` is `"ws-query"`/);
    expect(skill).toMatch(/modules\[0\]\.id` owns the op/);
    expect(skill).toMatch(/else `mark_session_error`/);
  });

  it("§3.6 protected paths include the Pinta trust/module files and Claude config", async () => {
    const skill = await readFile(skillPath("skill/pinta/SKILL.md"), "utf8");
    const start = skill.indexOf("### Writing-op preflight");
    expect(start).toBeGreaterThan(-1);
    const section = flat(skill.slice(start, skill.indexOf("\n## ", start)));
    for (const p of ["`.claude/**`", "`CLAUDE.md`", "`.pinta/modules/**`", "`.pinta/trusted-extension*`", "`.git/`", "`.env*`"]) {
      expect(section, p).toContain(p);
    }
  });

  it("§7.12 write-files, git-commit and test-file-issues all cite the §3.6 preflight", async () => {
    const skill = flat(await readFile(skillPath("skill/pinta/SKILL.md"), "utf8"));
    expect(skill).toMatch(/`write-files` \| [^|]*always after the §3\.6 preflight/);
    expect(skill).toMatch(/refuse `"all"`[^.]*dirty §3\.6 protected path/);
    expect(skill).toMatch(/`glab` \(§3\.6 writing-op preflight/);
    expect(skill).toMatch(/body's LAST line/);
  });

  it("the plugin copy of SKILL.md is in sync", async () => {
    const [a, b] = await Promise.all([
      readFile(skillPath("skill/pinta/SKILL.md"), "utf8"),
      readFile(skillPath("pinta-plugin/skills/pinta/SKILL.md"), "utf8"),
    ]);
    expect(b === a).toBe(true);
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
    trust = new ExtensionTrust(dir, { allowIds: [], userStorePath: join(dir, "user-trust.json") });
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

  it("module install needs the trusted extension — not no-Origin, not an unknown extension", async () => {
    const body = { package: {}, grantedCapabilities: [] };
    expect((await http(port, "POST", "/v1/modules", { body })).status).toBe(403);
    expect((await http(port, "POST", "/v1/modules", { body, origin: ext(OTHER_EXT) })).status).toBe(403);

    addTrustedId(join(dir, "user-trust.json"), OTHER_EXT); // `pinta-companion trust <id>`
    // Past the gate → the store's validation answers (400 empty package).
    expect((await http(port, "POST", "/v1/modules", { body, origin: ext(OTHER_EXT) })).status).toBe(400);
    expect((await http(port, "POST", "/v1/modules", { body, origin: ext(WEB_STORE_EXTENSION_ID) })).status).toBe(400);

    const rogue = await http(port, "POST", "/v1/modules", { body, origin: ext(THIRD_EXT) });
    expect(rogue.status).toBe(403);
    expect((await http(port, "GET", "/v1/sessions", { origin: ext(THIRD_EXT) })).status).toBe(403);
    expect((await http(port, "DELETE", "/v1/sessions", { origin: ext(THIRD_EXT) })).status).toBe(403);
  });

  it("an untrusted extension gets 403 + a machine-readable fix on every route, /v1/health included", async () => {
    for (const [method, path] of [["GET", "/v1/health"], ["GET", "/v1/sessions"], ["POST", "/v1/url-patterns"]] as const) {
      const r = await http(port, method, path, { origin: ext(THIRD_EXT), body: method === "POST" ? { pattern: "x" } : undefined });
      expect(r.status, path).toBe(403);
      expect(JSON.parse(r.body), path).toEqual({
        error: "untrusted-extension",
        extensionId: THIRD_EXT,
        fix: `npx pinta-companion trust ${THIRD_EXT}`,
      });
    }
    await expect(stat(join(dir, ".pinta", "trusted-extension.json"))).rejects.toThrow();
    addTrustedId(join(dir, "user-trust.json"), THIRD_EXT);
    const ok = await http(port, "GET", "/v1/health", { origin: ext(THIRD_EXT) });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).projectRoot).toBe(dir);
  });

  // F40/F41: Chromium sends no Origin on GET/HEAD from extension pages (only
  // Sec-Fetch-Site), so reads from browser contexts need the bearer token.
  const browserGet = (path: string, headers: Record<string, string> = {}) =>
    http(port, "GET", path, { headers: { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "cors", ...headers } });
  const tokenFor = async (id: string) =>
    (JSON.parse((await http(port, "POST", "/v1/auth/token", { origin: ext(id) })).body) as { token: string }).token;

  it("POST /v1/auth/token: trusted extension → token; untrusted → untrusted-extension 403; no/foreign Origin → 403", async () => {
    const ok = await http(port, "POST", "/v1/auth/token", { origin: ext(WEB_STORE_EXTENSION_ID) });
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-headers"]).toMatch(/Authorization/);
    const { token } = JSON.parse(ok.body) as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Stable for the process lifetime.
    expect(await tokenFor(WEB_STORE_EXTENSION_ID)).toBe(token);

    const untrusted = await http(port, "POST", "/v1/auth/token", { origin: ext(THIRD_EXT) });
    expect(untrusted.status).toBe(403);
    expect(JSON.parse(untrusted.body)).toEqual({
      error: "untrusted-extension",
      extensionId: THIRD_EXT,
      fix: `npx pinta-companion trust ${THIRD_EXT}`,
    });
    const none = await http(port, "POST", "/v1/auth/token");
    expect(none.status).toBe(403);
    expect(none.body).not.toContain(token);
    expect((await http(port, "POST", "/v1/auth/token", { headers: { "Sec-Fetch-Site": "none" } })).status).toBe(403);
    expect((await http(port, "POST", "/v1/auth/token", { origin: "https://evil.example" })).status).toBe(403);
    expect((await http(port, "GET", "/v1/auth/token", { origin: ext(WEB_STORE_EXTENSION_ID) })).status).toBe(405);
  });

  it("browser-context requests without an Origin need the token (Bearer or ?token=); health + OPTIONS stay open", async () => {
    const token = await tokenFor(WEB_STORE_EXTENSION_ID);
    for (const path of ["/v1/sessions", "/v1/modules", "/v1/registry", "/v1/watch/events", "/v1/report-shot?key=x"]) {
      const r = await browserGet(path);
      expect(r.status, path).toBe(401);
      expect(JSON.parse(r.body), path).toEqual({ error: "auth-required" });
    }
    expect((await browserGet("/v1/sessions", { Authorization: "Bearer wrong-token" })).status).toBe(401);
    expect((await browserGet("/v1/sessions", { Authorization: `Bearer ${token}x` })).status).toBe(401);
    expect((await browserGet("/v1/sessions?token=nope")).status).toBe(401);

    expect((await browserGet("/v1/sessions", { Authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await browserGet(`/v1/sessions?token=${encodeURIComponent(token)}`)).status).toBe(200);
    // Past the gate → the route answers (no such shot).
    expect((await browserGet(`/v1/report-shot?key=missing&token=${token}`)).status).toBe(404);
    // A cross-site <img>/no-cors request has the same shape — refused without the token.
    expect((await http(port, "GET", "/v1/sessions", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(401);

    const health = await browserGet("/v1/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).projectRoot).toBe(dir);
    expect((await http(port, "OPTIONS", "/v1/sessions", { headers: { "Sec-Fetch-Site": "none" } })).status).toBe(204);
  });

  it("a token is per extension id and stops working once that extension is untrusted", async () => {
    const storeFile = join(dir, "user-trust.json");
    addTrustedId(storeFile, OTHER_EXT);
    const token = await tokenFor(OTHER_EXT);
    expect(token).not.toBe(await tokenFor(WEB_STORE_EXTENSION_ID));
    expect((await browserGet("/v1/sessions", { Authorization: `Bearer ${token}` })).status).toBe(200);
    removeTrustedId(storeFile, OTHER_EXT);
    const after = await browserGet("/v1/sessions", { Authorization: `Bearer ${token}` });
    expect(after.status).toBe(403);
    expect(JSON.parse(after.body).error).toBe("untrusted-extension");
  });

  it("Node/curl-style callers (no Origin, no Sec-Fetch-Site) are unchanged — even with Node fetch's sec-fetch-mode", async () => {
    expect((await http(port, "GET", "/v1/sessions")).status).toBe(200);
    expect((await http(port, "GET", "/v1/sessions", { headers: { "Sec-Fetch-Mode": "cors" } })).status).toBe(200);
    expect((await http(port, "GET", "/v1/registry")).status).toBe(200);
    // Real Node fetch — what the MCP HTTP backend uses.
    expect((await fetch(`http://127.0.0.1:${port}/v1/sessions`)).status).toBe(200);
  });

  it("POST /v1/sessions refuses query annotations (AI1)", async () => {
    const query = {
      id: "q1",
      createdAt: 0,
      kind: "query",
      strokes: [],
      color: "#000",
      comment: JSON.stringify({ op: "audit-fix", checkId: "c1" }),
    };
    const r = await http(port, "POST", "/v1/sessions", {
      body: fakeSession({ id: "posted-query", annotations: [query as never], modules: [{ id: "audit-flow", settings: {} }] }),
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/query annotations/);
    expect(store.get("posted-query")).toBeNull();

    // A query hidden behind a normal annotation is refused too, from any caller.
    const mixed = fakeSession({
      id: "posted-mixed",
      annotations: [{ ...query, id: "n1", kind: "select", comment: "make it pink" } as never, { ...query, id: "q2" } as never],
    });
    for (const origin of [undefined, ext(WEB_STORE_EXTENSION_ID)]) {
      const m = await http(port, "POST", "/v1/sessions", { body: mixed, origin });
      expect(m.status, String(origin)).toBe(400);
    }
    expect(store.get("posted-mixed")).toBeNull();
  });

  it("POST /v1/sessions strips modules / origin / ephemeral / claimedBy (AI1)", async () => {
    const r = await http(port, "POST", "/v1/sessions", {
      body: {
        ...fakeSession({ id: "posted-mods", modules: [{ id: "git-commit", settings: {} }], claimedBy: "x", claimedAt: 1 }),
        origin: "ws-query",
        ephemeral: true,
      },
    });
    expect(r.status).toBe(201);
    for (const s of [JSON.parse(r.body) as Record<string, unknown>, store.get("posted-mods")! as unknown as Record<string, unknown>]) {
      expect(s.modules).toBeUndefined();
      expect(s.origin).toBeUndefined();
      expect(s.ephemeral).toBeUndefined();
      expect(s.claimedBy).toBeUndefined();
      expect(s.claimedAt).toBeUndefined();
    }
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
    trust = new ExtensionTrust(dir, { allowIds: [], userStorePath: join(dir, "user-trust.json") });
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

  it("rejects web origins, no-Origin upgrades and unknown extensions; never pins; trusts after the CLI adds an id", async () => {
    await boot(false);
    expect(await wsConnect(port)).toMatchObject({ ok: false, status: 403 });
    expect(await wsConnect(port, "https://evil.example")).toMatchObject({ ok: false, status: 403 });

    // The first extension to connect is NOT pinned.
    expect(await wsConnect(port, `chrome-extension://${OTHER_EXT}`)).toMatchObject({ ok: false, status: 403 });
    expect(trust.check(OTHER_EXT)).toBe("untrusted");

    addTrustedId(join(dir, "user-trust.json"), OTHER_EXT);
    const first = await wsConnect(port, `chrome-extension://${OTHER_EXT}`);
    expect(first.ok).toBe(true);
    if (first.ok) sockets.push(first.socket);

    expect(await wsConnect(port, `chrome-extension://${THIRD_EXT}`)).toMatchObject({ ok: false, status: 403 });
    // The Web Store id always connects.
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
    // Server-only marker the skill requires before running a writing op (AI1).
    expect(msg.session.origin).toBe("ws-query");
    expect(store.get(msg.session.id)!.origin).toBe("ws-query");
  });

  it("import-file-issues: trusted socket passes with the ws-query marker, an untrusted socket is refused", async () => {
    await boot(true);
    const importQuery = {
      type: "module.query.submit",
      moduleId: "gitlab-issues",
      url: "http://x/",
      queryComment: JSON.stringify({
        op: "import-file-issues",
        importedId: "imp-1",
        source: { title: "t", author: "a", exportedAt: 1, url: "http://x/" },
        items: [{ annotationId: "ann-1", kind: "select", comment: "c", url: "http://x/", where: {}, hasImages: false }],
        gitlab: null,
        fallbackToLocal: true,
      }),
    };

    // Opted-in no-Origin socket (untrusted) → refused, nothing stored.
    const anon = await wsConnect(port);
    if (!anon.ok) throw new Error("connect failed");
    sockets.push(anon.socket);
    const err = nextMessage(anon.socket, "error");
    anon.socket.send(JSON.stringify(importQuery));
    expect(String((await err).message)).toMatch(/writing ops/);
    expect(store.list().filter((s) => s.status === "submitted")).toHaveLength(0);

    // Trusted extension socket → accepted, carrying the server-only marker
    // the skill checks before running the writing op.
    const c = await wsConnect(port, `chrome-extension://${WEB_STORE_EXTENSION_ID}`);
    if (!c.ok) throw new Error("connect failed");
    sockets.push(c.socket);
    const created = nextMessage(c.socket, "module.query.created");
    c.socket.send(JSON.stringify(importQuery));
    const msg = (await created) as { session: Session };
    expect(msg.session.status).toBe("submitted");
    expect(msg.session.origin).toBe("ws-query");
    expect(msg.session.autoApply).toBe(true);
    expect(store.get(msg.session.id)!.origin).toBe("ws-query");
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
    const readOnly = ((await created) as { session: Session }).session;
    expect(readOnly.status).toBe("submitted");
    expect(readOnly.origin).toBeUndefined();

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
