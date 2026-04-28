// Cross-process registry of running Pinta companions, kept at
// ~/.pinta/registry.json. Each companion appends its own entry on
// startup and removes it on graceful shutdown; stale entries (process
// died without cleanup) are pruned on every read.
//
// This is the load-bearing piece of multi-project mode: it lets the
// /pinta skill find the right companion for its cwd, and (via the
// /v1/registry endpoint) lets the extension discover every companion
// without scanning ports itself.

import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export type RegistryEntry = {
  /** Stable per-process id (re-emitted across registry rewrites). */
  id: string;
  port: number;
  projectRoot: string;
  pid: number;
  /** Glob-style URL patterns for routing tabs to this companion. */
  urlPatterns: string[];
  /** Wall-clock ms of when the companion process started. */
  startedAt: number;
  /** Companion package version. Lets the extension warn about skew. */
  version: string;
};

export type RegistrySnapshot = {
  companions: RegistryEntry[];
};

const REGISTRY_FILE = join(homedir(), ".pinta", "registry.json");

/** Returns the absolute registry path. Exposed for tests + diagnostics. */
export function registryPath(): string {
  return REGISTRY_FILE;
}

async function readRaw(): Promise<RegistrySnapshot> {
  try {
    const raw = await readFile(REGISTRY_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<RegistrySnapshot>;
    return { companions: parsed.companions ?? [] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { companions: [] };
    // Malformed registry: don't crash, treat as empty so a fresh write
    // overwrites it.
    return { companions: [] };
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 is a no-op probe — succeeds if the pid exists, throws ESRCH
    // otherwise. Works on Windows + Unix.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means we lack permission to signal it but it does exist.
    return code === "EPERM";
  }
}

/**
 * Read + prune in one shot. Entries whose pid no longer exists are
 * dropped. By default, the pruned snapshot is persisted back so future
 * readers (the skill, other companions, the extension) don't pay the
 * prune cost again. Persistence is best-effort — failures are swallowed.
 *
 * Pass `{ writeBack: false }` from callers that are about to write the
 * registry themselves (registerEntry / unregister / updateUrlPatterns) —
 * doubling the writes there causes EPERM races on Windows where two
 * companions start concurrently.
 */
export async function snapshot(
  opts: { writeBack?: boolean } = {},
): Promise<RegistrySnapshot> {
  const writeBack = opts.writeBack ?? true;
  const raw = await readRaw();
  const live = raw.companions.filter((e) => isPidAlive(e.pid));
  if (writeBack && live.length !== raw.companions.length) {
    atomicWrite({ companions: live }).catch(() => {
      // best-effort — a stale registry is annoying, not fatal
    });
  }
  return { companions: live };
}

/**
 * Walk-up cwd matching: returns the registered companion whose
 * `projectRoot` is the deepest ancestor of (or equal to) `cwd`. If
 * nothing matches, returns null. Case-insensitive on Windows.
 *
 * This is what lets the skill and the MCP bridge auto-pick the right
 * companion without the agent having to specify a port.
 */
export async function findEntryForCwd(
  cwd: string,
): Promise<RegistryEntry | null> {
  const snap = await snapshot();
  const target = normalizePath(cwd);
  let best: RegistryEntry | null = null;
  let bestLen = -1;
  for (const e of snap.companions) {
    const root = normalizePath(e.projectRoot);
    if (target === root || target.startsWith(root + "/")) {
      if (root.length > bestLen) {
        best = e;
        bestLen = root.length;
      }
    }
  }
  return best;
}

function normalizePath(p: string): string {
  const abs = resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

async function atomicWrite(snap: RegistrySnapshot): Promise<void> {
  await mkdir(dirname(REGISTRY_FILE), { recursive: true });
  // tmpdir() may live on a different volume than the home dir on
  // Windows, which would make rename() throw EXDEV. Stage the temp file
  // in the same directory so rename is always same-volume.
  const tmp = join(
    dirname(REGISTRY_FILE),
    `.registry-${process.pid}-${randomUUID()}.tmp`,
  );
  await writeFile(tmp, JSON.stringify(snap, null, 2), "utf8");
  // Windows briefly locks files during concurrent reads (e.g. another
  // companion running readFile while we rename), throwing EPERM. Retry
  // a handful of times with backoff before giving up — this is the
  // race that two-companion concurrent startup hits.
  let lastErr: unknown = null;
  for (const delay of [0, 30, 80, 200, 500]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      await rename(tmp, REGISTRY_FILE);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
    }
  }
  await unlink(tmp).catch(() => {});
  throw lastErr;
}

/**
 * Add (or replace) this process's entry. Returns the inserted entry so
 * the caller can hold a reference for unregister().
 */
export async function registerEntry(
  input: Omit<RegistryEntry, "id" | "pid" | "startedAt"> & {
    pid?: number;
    startedAt?: number;
  },
): Promise<RegistryEntry> {
  const snap = await snapshot({ writeBack: false });
  // If a previous registration for this pid+port survived a hot-reload,
  // replace it rather than duplicating.
  const others = snap.companions.filter(
    (e) => !(e.pid === (input.pid ?? process.pid) && e.port === input.port),
  );
  const entry: RegistryEntry = {
    id: randomUUID(),
    port: input.port,
    projectRoot: input.projectRoot,
    pid: input.pid ?? process.pid,
    urlPatterns: input.urlPatterns,
    startedAt: input.startedAt ?? Date.now(),
    version: input.version,
  };
  await atomicWrite({ companions: [...others, entry] });
  return entry;
}

/** Remove the given entry on graceful shutdown. */
export async function unregister(entryId: string): Promise<void> {
  const snap = await snapshot({ writeBack: false });
  await atomicWrite({
    companions: snap.companions.filter((e) => e.id !== entryId),
  });
}

/** Patch one entry's urlPatterns. Used by POST /v1/url-patterns. */
export async function updateUrlPatterns(
  entryId: string,
  urlPatterns: string[],
): Promise<RegistryEntry | null> {
  const snap = await snapshot({ writeBack: false });
  let updated: RegistryEntry | null = null;
  const next = snap.companions.map((e) => {
    if (e.id !== entryId) return e;
    updated = { ...e, urlPatterns };
    return updated;
  });
  if (updated) await atomicWrite({ companions: next });
  return updated;
}

