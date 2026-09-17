import { execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Security primitives shared by the HTTP (server.ts), WebSocket (ws.ts),
 * store and MCP layers. Kept dependency-free + synchronous so every gate
 * is cheap and unit-testable without booting a socket.
 */

/** An input error the HTTP layer maps to a 400 (vs a generic 500). */
export class BadRequestError extends Error {
  readonly status = 400;
}

// ── Path-segment guards ──────────────────────────────────────────────

/**
 * Session ids become file names (`.pinta/sessions/<id>.json|png|jpg`).
 * The companion mints UUIDs; the fake-session script uses `test-<ts>`.
 * Anything outside this alphabet (dots, slashes, backslashes, `..`) is
 * refused so an id can never escape the sessions directory.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeSessionId(id: unknown): id is string {
  return typeof id === "string" && SAFE_SESSION_ID.test(id);
}

export function assertSafeSessionId(id: unknown): asserts id is string {
  if (!isSafeSessionId(id)) {
    throw new BadRequestError("invalid session id (expected [A-Za-z0-9_-]{1,64})");
  }
}

/** Test-doc ids (`.pinta/test-docs/<docId>.md`) — same rule as the route guard. */
const SAFE_DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeDocId(id: unknown): id is string {
  return typeof id === "string" && SAFE_DOC_ID.test(id);
}

/**
 * Defense in depth: resolve `name` under `baseDir` and throw unless the
 * result stays strictly inside it. Callers still validate the segment
 * first; this catches anything a future caller forgets to.
 */
export function resolveInside(baseDir: string, name: string): string {
  const base = resolve(baseDir);
  const abs = resolve(base, name);
  if (!abs.startsWith(base + sep)) {
    throw new BadRequestError(`path escapes ${base}`);
  }
  return abs;
}

// ── Image data URLs ──────────────────────────────────────────────────

export type ImageFormat = { ext: "png" | "jpg"; mediaType: "image/png" | "image/jpeg" };

export type ParsedImageDataUrl = ImageFormat & { base64: string };

/**
 * Parse a base64 image data URL. Only PNG and JPEG are accepted (the
 * extension sends PNG screenshots and JPEG composites / reference
 * images). Returns null for anything else, including non-image data.
 */
export function parseImageDataUrl(data: string): ParsedImageDataUrl | null {
  const m = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(data);
  if (!m) return null;
  const kind = m[1]!.toLowerCase();
  const base64 = m[2]!;
  return kind === "png"
    ? { ext: "png", mediaType: "image/png", base64 }
    : { ext: "jpg", mediaType: "image/jpeg", base64 };
}

/** Screenshot file extensions a session may own on disk. */
export const SCREENSHOT_EXTS = ["png", "jpg"] as const;

/** Media type for a stored screenshot path, or null when not an image we write. */
export function imageMediaTypeForPath(p: string): ImageFormat["mediaType"] | null {
  const lower = p.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return null;
}

// ── Writing ops (module queries that edit / commit / file issues) ────

/**
 * Module-query ops that change the user's project or the outside world
 * (source edits, commits, tracker issues). Every other op is read + emit
 * only. These must only come from a trusted-extension connection.
 */
export const WRITING_QUERY_OPS: ReadonlySet<string> = new Set([
  "audit-fix",
  "audit-file-issue",
  "variants-apply",
  "review-fix",
  "git-commit",
  "test-file-issues",
  "generate-doc",
  "report-screenshot",
]);

/** The JSON `op` of a module query comment, or null when it isn't JSON. */
export function queryOpOf(comment: unknown): string | null {
  if (typeof comment !== "string" || !comment.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(comment) as { op?: unknown };
    return parsed && typeof parsed.op === "string" ? parsed.op : null;
  } catch {
    return null;
  }
}

export function isWritingQueryComment(comment: unknown): boolean {
  const op = queryOpOf(comment);
  return op !== null && WRITING_QUERY_OPS.has(op);
}

// ── Host header (DNS rebinding) ──────────────────────────────────────

/**
 * True when the Host header names a loopback address (any port). A page
 * that DNS-rebinds its own hostname to 127.0.0.1 makes same-origin GETs
 * with no Origin header — but its Host is still the attacker's name.
 * A missing Host (raw HTTP/1.0 tooling) is allowed.
 */
export function isLoopbackHost(host: unknown): boolean {
  if (host === undefined || host === "") return true;
  if (typeof host !== "string") return false;
  const h = host.trim().toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

// ── Trusted extension (Origin) ───────────────────────────────────────

/** Published Chrome Web Store id of the Pinta extension. */
export const WEB_STORE_EXTENSION_ID = "gnobpbogpbgdcpfjhbajfnbcfpbcnhah";

export const EXTENSION_ID = /^[a-p]{32}$/;

export function isExtensionId(id: unknown): id is string {
  return typeof id === "string" && EXTENSION_ID.test(id);
}

/** `chrome-extension://<id>` → `<id>`; null for any other origin. */
export function extensionIdFromOrigin(origin: unknown): string | null {
  if (typeof origin !== "string") return null;
  const m = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin.trim().toLowerCase());
  return m ? m[1]! : null;
}

export type TrustVerdict = "trusted" | "untrusted";

/** The fix a refused extension is told to run (403 body + companion log). */
export function trustFixCommand(id: string | null): string {
  return `npx pinta-companion trust ${id ?? "<extension-id>"}`;
}

// ── HTTP token (browser contexts without an Origin) ──────────────────

/**
 * Chromium sends no Origin on GET/HEAD from an extension page (only
 * `Sec-Fetch-Site: none`), so Origin alone can't tell Pinta from any other
 * extension with host permissions. Browser contexts therefore authenticate
 * GETs with a bearer token they fetched via the Origin-checked
 * `POST /v1/auth/token`. Keyed on `Sec-Fetch-Site`, NOT `Sec-Fetch-Mode`:
 * Node's fetch (the MCP HTTP backend) sends `sec-fetch-mode: cors` but never
 * `sec-fetch-site`, and local tools must keep working without a token.
 */
export function isBrowserContextRequest(headers: Record<string, string | string[] | undefined>): boolean {
  return headers["sec-fetch-site"] !== undefined;
}

/** `Authorization: Bearer <t>` or, for <img src>/EventSource URLs, `?token=<t>`. */
export function requestTokenOf(authorization: unknown, searchParams: URLSearchParams): string | null {
  if (typeof authorization === "string") {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (m) return m[1]!;
  }
  return searchParams.get("token") || null;
}

/**
 * Per-process tokens, one random 256-bit token per trusted extension id,
 * minted on first request and never logged or persisted. A restart
 * invalidates them all (the extension refreshes on 401). Resolving a token
 * yields the id it was issued to, so the caller can re-check trust and an
 * `untrust` takes effect on the next request.
 */
export class CompanionTokens {
  private readonly byId = new Map<string, string>();

  issue(extensionId: string): string {
    let token = this.byId.get(extensionId);
    if (!token) {
      token = randomBytes(32).toString("base64url");
      this.byId.set(extensionId, token);
    }
    return token;
  }

  /** The extension id `token` was issued to, or null. Constant-time per compare. */
  resolve(token: string | null): string | null {
    if (!token) return null;
    const given = Buffer.from(token, "utf8");
    let match: string | null = null;
    for (const [id, t] of this.byId) {
      const want = Buffer.from(t, "utf8");
      if (want.length === given.length && timingSafeEqual(want, given)) match = id;
    }
    return match;
  }
}

// ── Per-user trust store (~/.pinta/trusted-extensions.json) ──────────

export type TrustStoreFile = { ids: { id: string; addedAt: string }[] };

/** Global (per-user, every project) list of ids the user trusted via the CLI. */
export function defaultUserTrustStorePath(): string {
  return join(homedir(), ".pinta", "trusted-extensions.json");
}

/** The store exists but isn't a JSON object with an `ids` array — never overwritten. */
export class TrustStoreCorruptError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path} is not a valid trust store (${detail}); fix or delete it, then retry — refusing to overwrite it`);
  }
}

function parseTrustStore(path: string, text: string): TrustStoreFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new TrustStoreCorruptError(path, (err as Error).message);
  }
  const entries = raw && typeof raw === "object" ? (raw as { ids?: unknown }).ids : undefined;
  if (!Array.isArray(entries)) throw new TrustStoreCorruptError(path, "missing ids array");
  const ids: TrustStoreFile["ids"] = [];
  for (const e of entries as unknown[]) {
    const rec = (e ?? {}) as { id?: unknown; addedAt?: unknown };
    if (!isExtensionId(rec.id)) continue;
    ids.push({ id: rec.id, addedAt: typeof rec.addedAt === "string" ? rec.addedAt : "" });
  }
  return { ids };
}

/**
 * Strict read for writers: a missing file is an empty list, a corrupt one
 * throws TrustStoreCorruptError so trust/untrust never wipe a hand-edited store.
 */
export function readTrustStoreStrict(path: string): TrustStoreFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ids: [] };
    throw err;
  }
  return parseTrustStore(path, text);
}

/** Read the store; a missing or malformed file is an empty list (trusts nothing). Invalid ids are dropped. */
export function readTrustStore(path: string): TrustStoreFile {
  try {
    return parseTrustStore(path, readFileSync(path, "utf8"));
  } catch {
    return { ids: [] };
  }
}

/** Atomic write: temp file in the same directory, then rename over the store. */
function writeTrustStore(path: string, file: TrustStoreFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // temp file never created / already renamed
    }
    throw err;
  }
}

function normalizeExtensionId(id: string): string {
  const norm = id.trim().toLowerCase();
  if (!isExtensionId(norm)) {
    throw new BadRequestError(`invalid extension id "${id}" (expected 32 letters a-p)`);
  }
  return norm;
}

/** Add an id to the store. False when it was already there. Throws on a malformed id. */
export function addTrustedId(path: string, id: string): boolean {
  const norm = normalizeExtensionId(id);
  const file = readTrustStoreStrict(path);
  if (file.ids.some((e) => e.id === norm)) return false;
  file.ids.push({ id: norm, addedAt: new Date().toISOString() });
  writeTrustStore(path, file);
  return true;
}

/** Remove an id from the store. False when it wasn't there. Throws on a malformed id. */
export function removeTrustedId(path: string, id: string): boolean {
  const norm = normalizeExtensionId(id);
  const file = readTrustStoreStrict(path);
  const ids = file.ids.filter((e) => e.id !== norm);
  if (ids.length === file.ids.length) return false;
  writeTrustStore(path, { ids });
  return true;
}

export type GitTrackState = "tracked" | "untracked" | "unknown";

/**
 * Whether `relPath` is tracked by git in `root`. "unknown" when git is
 * missing or `root` isn't inside a work tree (e.g. a zip download) — the
 * caller can't tell a committed file from a local one, so it must not trust it.
 */
export function gitTrackState(root: string, relPath: string): GitTrackState {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  try {
    if (run(["rev-parse", "--is-inside-work-tree"]).toString().trim() !== "true") return "unknown";
  } catch {
    return "unknown";
  }
  try {
    run(["ls-files", "--error-unmatch", "--", relPath]);
    return "tracked";
  } catch {
    return "untracked";
  }
}

export type LegacyPinMigration =
  | "none"
  | "migrated"
  | "already-trusted"
  | "ignored-tracked"
  | "ignored-no-git"
  | "rename-failed"
  | "invalid";

/**
 * One-time migration of the old trust-on-first-use pin
 * (`<project>/.pinta/trusted-extension.json`). A pin git reports as
 * untracked was written by this machine's companion, so the file is renamed
 * `*.migrated` first (so a later `untrust` sticks; if the rename fails
 * nothing is added) and its id moves into the per-user store. A git-tracked
 * pin came with the clone — anyone could have committed it — and a pin
 * whose status git can't report (no git, not a work tree, e.g. a zip
 * download) can't be told apart from one, so both are ignored and the
 * trust command is logged.
 */
export function migrateLegacyPin(
  projectRoot: string,
  userStorePath: string,
  log: (msg: string) => void,
  trackState: (root: string, relPath: string) => GitTrackState = gitTrackState,
): LegacyPinMigration {
  const legacy = join(projectRoot, ".pinta", "trusted-extension.json");
  if (!existsSync(legacy)) return "none";
  const state = trackState(projectRoot, ".pinta/trusted-extension.json");
  if (state === "tracked") {
    log(`ignoring git-tracked ${legacy} — trust your build with: ${trustFixCommand(null)}`);
    return "ignored-tracked";
  }
  if (state !== "untracked") {
    log(
      `ignoring ${legacy} — git can't confirm it is local (no git or not a work tree); ` +
        `trust your build with: ${trustFixCommand(null)}`,
    );
    return "ignored-no-git";
  }
  let id: unknown;
  try {
    id = (JSON.parse(readFileSync(legacy, "utf8")) as { id?: unknown }).id;
  } catch {
    id = undefined;
  }
  const norm = typeof id === "string" ? id.toLowerCase() : "";
  if (!isExtensionId(norm)) {
    log(`ignoring malformed ${legacy}`);
    return "invalid";
  }
  // Rename first: a pin left in place would be re-added on the next start
  // even after the user ran `untrust`.
  try {
    renameSync(legacy, `${legacy}.migrated`);
  } catch (err) {
    log(
      `could not rename ${legacy}, not migrated: ${(err as Error).message} — ` +
        `trust your build with: ${trustFixCommand(norm)}`,
    );
    return "rename-failed";
  }
  let added: boolean;
  try {
    added = addTrustedId(userStorePath, norm);
  } catch (err) {
    log(`could not migrate ${legacy}: ${(err as Error).message}`);
    try {
      renameSync(`${legacy}.migrated`, legacy);
    } catch {
      // leave it renamed; the log above names the problem
    }
    return "invalid";
  }
  log(
    added
      ? `migrated trusted extension ${norm} from ${legacy} to ${userStorePath}`
      : `${legacy} names ${norm}, already in ${userStorePath}`,
  );
  return added ? "migrated" : "already-trusted";
}

export type ExtensionTrustOptions = {
  /** Extra allow-listed ids. Defaults to `$PINTA_EXTENSION_IDS` (comma-separated). */
  allowIds?: string[];
  /** Per-user trust store. Defaults to `~/.pinta/trusted-extensions.json`. */
  userStorePath?: string;
  log?: (msg: string) => void;
};

/**
 * Which `chrome-extension://` origins count as Pinta: the Web Store id ∪
 * `$PINTA_EXTENSION_IDS` ∪ the per-user store, which the user edits out
 * of band with `pinta-companion trust <id>`. Nothing is pinned
 * automatically — an unknown extension is refused (WS upgrade, every
 * HTTP request carrying its Origin, and the bearer token that gates its
 * Origin-less GETs) until the user trusts it in a terminal, so another
 * installed extension can't pose as Pinta. A click in the side panel
 * would not do: a rogue extension can send any message itself. The
 * store is re-read when its mtime/size changes, so trust / untrust apply
 * without a restart.
 */
export class ExtensionTrust {
  private readonly allow: Set<string>;
  private readonly log: (msg: string) => void;
  readonly userStorePath: string;
  private userIds = new Set<string>();
  private userStamp: string | null | undefined = undefined; // mtime:size; undefined = never read
  private readonly refusedLogged = new Set<string>();

  constructor(
    readonly projectRoot: string,
    opts: ExtensionTrustOptions = {},
  ) {
    const extra = (opts.allowIds ?? (process.env.PINTA_EXTENSION_IDS ?? "").split(","))
      .map((s) => s.trim().toLowerCase())
      .filter((s) => EXTENSION_ID.test(s));
    this.allow = new Set([WEB_STORE_EXTENSION_ID, ...extra]);
    this.userStorePath = opts.userStorePath ?? defaultUserTrustStorePath();
    this.log = opts.log ?? (() => {});
  }

  private refreshUserIds(): void {
    let stamp: string | null;
    try {
      const st = statSync(this.userStorePath);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = null;
    }
    if (stamp === this.userStamp) return;
    this.userStamp = stamp;
    this.userIds = new Set(
      stamp === null ? [] : readTrustStore(this.userStorePath).ids.map((e) => e.id),
    );
    this.refusedLogged.clear();
  }

  /** Verdict for an extension id. Read-only — never pins. */
  check(id: string | null): TrustVerdict {
    if (!id) return "untrusted";
    if (this.allow.has(id)) return "trusted";
    this.refreshUserIds();
    return this.userIds.has(id) ? "trusted" : "untrusted";
  }

  /** WS connect path: true when trusted, else logs the refusal (once per id). */
  verify(id: string | null): boolean {
    if (this.check(id) === "trusted") return true;
    this.logRefused(id);
    return false;
  }

  /** Log a refusal with the fix — once per id so a polling client can't flood the log. */
  logRefused(id: string | null): void {
    const key = id ?? "(unknown)";
    if (this.refusedLogged.has(key)) return;
    this.refusedLogged.add(key);
    this.log(
      `refused extension ${key} — not a trusted Pinta build. If it is yours, run: ` +
        `${trustFixCommand(id)} (or set PINTA_EXTENSION_IDS).`,
    );
  }
}
