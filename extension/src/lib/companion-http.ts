// Token-aware HTTP to the local companion.
//
// Chromium sends no Origin header on GET/HEAD from extension pages, so the
// companion can't tell Pinta's reads from any other extension's. It gates
// browser-context requests on a per-process bearer token instead, handed
// out only to a trusted `chrome-extension://` Origin via
// `POST /v1/auth/token` (POSTs do carry Origin). Every companion call in
// the side panel and service worker goes through here:
//   - token cached per base URL in memory + chrome.storage.session (shared
//     by the panel and the SW, cleared when the browser closes);
//   - `Authorization: Bearer` attached; on 401 (companion restarted → new
//     token) refresh once and retry;
//   - a 403 `untrusted-extension` from the token endpoint (or a gated call)
//     is reported to `onCompanionUntrusted` listeners — the panel's amber
//     "run pinta-companion trust <id>" notice.
// <img src> / fetch-by-URL callers use `withCompanionToken` (`?token=`).

export type CompanionRefusal = { extensionId: string | null; fix: string | null };

export type TokenResult =
  | { kind: "token"; token: string }
  | { kind: "untrusted"; refusal: CompanionRefusal }
  | { kind: "unavailable" };

const STORAGE_KEY = "pinta.companionTokens";
const TOKEN_TIMEOUT_MS = 2_000;

const memory = new Map<string, string>();
const inflight = new Map<string, Promise<TokenResult>>();
const untrustedListeners = new Set<(base: string, refusal: CompanionRefusal) => void>();
const tokenListeners = new Set<(base: string, token: string | null) => void>();
let storageLoaded: Promise<void> | null = null;

/** `http://127.0.0.1:7878/v1/x?y` → `http://127.0.0.1:7878`; null for non-http(s) URLs. */
export function companionBaseOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Parse a companion 403 body; non-null only for `untrusted-extension`. */
export function parseUntrustedBody(body: unknown): CompanionRefusal | null {
  const b = (body && typeof body === "object" ? body : null) as Record<string, unknown> | null;
  if (b?.error !== "untrusted-extension") return null;
  return {
    extensionId: typeof b.extensionId === "string" && b.extensionId ? b.extensionId : null,
    fix: typeof b.fix === "string" && b.fix ? b.fix : null,
  };
}

/** Subscribe to "this companion refuses the extension" signals. Returns unsubscribe. */
export function onCompanionUntrusted(
  listener: (base: string, refusal: CompanionRefusal) => void,
): () => void {
  untrustedListeners.add(listener);
  return () => untrustedListeners.delete(listener);
}

function emitUntrusted(base: string, refusal: CompanionRefusal): void {
  for (const l of untrustedListeners) {
    try {
      l(base, refusal);
    } catch {
      // a listener's failure must not break the request path
    }
  }
}

/** Subscribe to token changes per base (acquired / refreshed / dropped) so <img> URLs can rebuild. */
export function onCompanionToken(listener: (base: string, token: string | null) => void): () => void {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

function emitToken(base: string, token: string | null): void {
  for (const l of tokenListeners) {
    try {
      l(base, token);
    } catch {
      // ignore listener failures
    }
  }
}

function sessionStorageArea(): chrome.storage.StorageArea | null {
  try {
    return (globalThis as { chrome?: typeof chrome }).chrome?.storage?.session ?? null;
  } catch {
    return null;
  }
}

async function loadStoredTokens(): Promise<void> {
  storageLoaded ??= (async () => {
    const area = sessionStorageArea();
    if (!area) return;
    try {
      const got = (await area.get(STORAGE_KEY)) as Record<string, unknown>;
      const map = got?.[STORAGE_KEY];
      if (map && typeof map === "object") {
        for (const [base, token] of Object.entries(map as Record<string, unknown>)) {
          if (typeof token === "string" && !memory.has(base)) memory.set(base, token);
        }
      }
    } catch {
      // storage unavailable — memory cache only
    }
  })();
  return storageLoaded;
}

async function persistTokens(): Promise<void> {
  const area = sessionStorageArea();
  if (!area) return;
  try {
    await area.set({ [STORAGE_KEY]: Object.fromEntries(memory) });
  } catch {
    // memory cache only
  }
}

function forget(base: string): void {
  if (!memory.delete(base)) return;
  void persistTokens();
  emitToken(base, null);
}

/** Synchronous cache read (for building <img> URLs). Null until a token was acquired. */
export function cachedCompanionToken(base: string | null | undefined): string | null {
  return base ? (memory.get(base) ?? null) : null;
}

/** Append `token=` to a companion URL when a token is cached for its base. */
export function withCompanionToken(url: string, token?: string | null): string {
  const t = token ?? cachedCompanionToken(companionBaseOf(url));
  if (!t) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}`;
}

/**
 * Get a token for `base` (cached unless `refresh`). Concurrent callers share
 * one request. Untrusted → listeners notified + typed result; network
 * failure / old companion without the route → `unavailable`.
 */
export async function acquireCompanionToken(
  base: string,
  opts: { refresh?: boolean; timeoutMs?: number } = {},
): Promise<TokenResult> {
  await loadStoredTokens();
  if (!opts.refresh) {
    const cached = memory.get(base);
    if (cached) return { kind: "token", token: cached };
  }
  const pending = inflight.get(base);
  if (pending) return pending;
  const run = (async (): Promise<TokenResult> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? TOKEN_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/v1/auth/token`, { method: "POST", signal: ctrl.signal });
      const body = await res.json().catch(() => null);
      if (res.status === 403) {
        const refusal = parseUntrustedBody(body);
        if (refusal) {
          forget(base);
          emitUntrusted(base, refusal);
          return { kind: "untrusted", refusal };
        }
        return { kind: "unavailable" };
      }
      const token = (body as { token?: unknown } | null)?.token;
      if (!res.ok || typeof token !== "string" || !token) return { kind: "unavailable" };
      const changed = memory.get(base) !== token;
      memory.set(base, token);
      if (changed) {
        void persistTokens();
        emitToken(base, token);
      }
      return { kind: "token", token };
    } catch {
      return { kind: "unavailable" };
    } finally {
      clearTimeout(timer);
      inflight.delete(base);
    }
  })();
  inflight.set(base, run);
  return run;
}

/**
 * `fetch` for a companion URL: attaches the bearer token, refreshes once on
 * 401, and reports an `untrusted-extension` 403 to listeners. Returns the
 * final Response (callers keep their own `res.ok` handling). Non-companion
 * URLs pass straight through.
 */
export async function companionFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const base = companionBaseOf(url);
  if (!base) return fetch(url, init);
  const send = (token: string | null) => {
    if (!token) return fetch(url, init);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  };
  const first = await acquireCompanionToken(base);
  let res = await send(first.kind === "token" ? first.token : null);
  if (res.status === 401 && first.kind !== "untrusted") {
    forget(base);
    const again = await acquireCompanionToken(base, { refresh: true });
    if (again.kind === "token") res = await send(again.token);
  } else if (res.status === 403) {
    const refusal = parseUntrustedBody(await res.clone().json().catch(() => null));
    if (refusal) {
      forget(base);
      emitUntrusted(base, refusal);
    }
  }
  return res;
}

/** Test hook: drop caches, in-flight requests and listeners. */
export function __resetCompanionHttpForTests(): void {
  memory.clear();
  inflight.clear();
  untrustedListeners.clear();
  tokenListeners.clear();
  storageLoaded = null;
}
