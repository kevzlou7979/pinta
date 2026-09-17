import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const EXTENSION_ID = /^[a-p]{32}$/;

/** `chrome-extension://<id>` → `<id>`; null for any other origin. */
export function extensionIdFromOrigin(origin: unknown): string | null {
  if (typeof origin !== "string") return null;
  const m = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin.trim().toLowerCase());
  return m ? m[1]! : null;
}

export type TrustVerdict = "trusted" | "unpinned" | "untrusted";

export type ExtensionTrustOptions = {
  /** Extra allow-listed ids. Defaults to `$PINTA_EXTENSION_IDS` (comma-separated). */
  allowIds?: string[];
  log?: (msg: string) => void;
};

/**
 * Which `chrome-extension://` origins count as Pinta.
 *
 *  - The Web Store id and `$PINTA_EXTENSION_IDS` are always trusted.
 *  - Trust-on-first-use: the first extension that opens the WebSocket
 *    (allow-listed or not) is pinned to
 *    `<project>/.pinta/trusted-extension.json`. A different, non-allow-
 *    listed id later is refused (WS, HTTP reads + writes) until the user
 *    deletes that file or allow-lists the id — so another installed
 *    extension can't pose as Pinta once the real one has connected.
 *  - When `$PINTA_EXTENSION_IDS` is set, TOFU is off: only allow-listed
 *    ids are trusted.
 */
export class ExtensionTrust {
  private readonly allow: Set<string>;
  /** True when the user configured ids explicitly — disables TOFU. */
  private readonly explicitAllow: boolean;
  private readonly log: (msg: string) => void;
  private pinned: string | null | undefined = undefined; // undefined = not read yet
  private readonly refusedLogged = new Set<string>();

  constructor(
    private readonly projectRoot: string,
    opts: ExtensionTrustOptions = {},
  ) {
    const extra = (opts.allowIds ?? (process.env.PINTA_EXTENSION_IDS ?? "").split(","))
      .map((s) => s.trim().toLowerCase())
      .filter((s) => EXTENSION_ID.test(s));
    this.explicitAllow = extra.length > 0;
    this.allow = new Set([WEB_STORE_EXTENSION_ID, ...extra]);
    this.log = opts.log ?? (() => {});
  }

  get pinFile(): string {
    return join(this.projectRoot, ".pinta", "trusted-extension.json");
  }

  private readPinned(): string | null {
    try {
      const raw = JSON.parse(readFileSync(this.pinFile, "utf8")) as { id?: unknown };
      const id = typeof raw.id === "string" ? raw.id.toLowerCase() : "";
      this.pinned = EXTENSION_ID.test(id) ? id : null;
    } catch {
      this.pinned = null;
    }
    return this.pinned;
  }

  /** Verdict for an extension id, without pinning. */
  check(id: string | null): TrustVerdict {
    if (!id) return "untrusted";
    if (this.allow.has(id)) return "trusted";
    if (this.explicitAllow) return "untrusted";
    let pinned = this.pinned === undefined ? this.readPinned() : this.pinned;
    // Re-read on a miss so deleting the file takes effect without a restart.
    if (pinned !== id) pinned = this.readPinned();
    if (pinned === null) return "unpinned";
    return pinned === id ? "trusted" : "untrusted";
  }

  /** WS connect path: pin the first extension (TOFU), then report whether it's trusted. */
  pinOrCheck(id: string | null): boolean {
    const verdict = this.check(id);
    if (verdict === "untrusted" || !id) {
      this.logRefused(id);
      return false;
    }
    // Take the TOFU slot even for an allow-listed id, so a rogue extension
    // can't claim it later while the user runs the Web Store build.
    if (!this.explicitAllow && this.readPinned() === null) this.pin(id);
    return true;
  }

  private pin(id: string): void {
    try {
      mkdirSync(dirname(this.pinFile), { recursive: true });
      writeFileSync(
        this.pinFile,
        JSON.stringify({ id, pinnedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    } catch (err) {
      this.log(`could not write ${this.pinFile}: ${(err as Error).message}`);
    }
    this.pinned = id;
    this.refusedLogged.clear();
    this.log(`trusted extension ${id} (pinned in ${this.pinFile})`);
  }

  /** Log a refusal with the fix — once per id so a polling client can't flood the log. */
  logRefused(id: string | null): void {
    const key = id ?? "(unknown)";
    if (this.refusedLogged.has(key)) return;
    this.refusedLogged.add(key);
    const why = this.explicitAllow
      ? "it is not listed in PINTA_EXTENSION_IDS"
      : `this project trusts ${this.pinned ?? "another extension"}`;
    this.log(
      `refused extension ${key} — ${why}. If this is your Pinta build, ` +
        `delete ${this.pinFile} or add it to PINTA_EXTENSION_IDS=${id ?? "<id>"}.`,
    );
  }
}
