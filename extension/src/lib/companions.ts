// Discovers running Pinta companions by parallel-scanning the
// reserved port range. Each companion advertises projectRoot +
// urlPatterns on /v1/health, which is enough to populate the side
// panel's project picker without the extension needing to read the
// shared ~/.pinta/registry.json (Chrome extensions have no fs access).

import { acquireCompanionToken, type TokenResult } from "./companion-http.js";

export type Companion = {
  port: number;
  projectRoot: string;
  urlPatterns: string[];
  registryId?: string;
  version?: string;
};

const PORT_START = 7878;
const PORT_END = 7898;
const PROBE_TIMEOUT_MS = 250;

/**
 * A companion that answered on a Pinta port but refused this browser
 * extension (HTTP 403 `untrusted-extension`). The companion only talks to
 * extension ids the user has explicitly trusted; `fix` is the terminal
 * command it suggests (`npx pinta-companion trust <id>`).
 */
export type UntrustedCompanion = {
  port: number;
  extensionId: string | null;
  fix: string | null;
};

export type ProbeResult =
  | { kind: "companion"; companion: Companion }
  | { kind: "untrusted"; untrusted: UntrustedCompanion }
  | { kind: "none" };

export type DiscoveryResult = {
  companions: Companion[];
  untrusted: UntrustedCompanion[];
};

/**
 * Pure interpretation of one `/v1/health` response. `body` is the parsed
 * JSON (or null when the body wasn't JSON). Split out of `probe` so the
 * status/body rules are unit-testable without fetch.
 */
export function parseHealthResponse(port: number, status: number, body: unknown): ProbeResult {
  const b = (body && typeof body === "object" ? body : null) as Record<string, unknown> | null;
  if (status === 403 && b?.error === "untrusted-extension") {
    return {
      kind: "untrusted",
      untrusted: {
        port,
        extensionId: typeof b.extensionId === "string" && b.extensionId ? b.extensionId : null,
        fix: typeof b.fix === "string" && b.fix ? b.fix : null,
      },
    };
  }
  if (status < 200 || status >= 300) return { kind: "none" };
  if (!b || !b.ok || typeof b.projectRoot !== "string") return { kind: "none" };
  return {
    kind: "companion",
    companion: {
      port,
      projectRoot: b.projectRoot,
      urlPatterns: Array.isArray(b.urlPatterns)
        ? (b.urlPatterns as unknown[]).filter((p): p is string => typeof p === "string")
        : [],
      registryId: typeof b.registryId === "string" ? b.registryId : undefined,
      version: typeof b.version === "string" ? b.version : undefined,
    },
  };
}

/**
 * Chromium sends no Origin on the health GET, so a 200 there doesn't mean
 * the companion trusts us. The token request (a POST, which carries Origin)
 * is the reliable signal: an untrusted-extension refusal turns a healthy
 * companion into an "untrusted" result. No token for other reasons (old
 * companion without the route, timeout) keeps it listed — gated calls will
 * retry the token themselves.
 */
export function applyTokenResult(probe: ProbeResult, token: TokenResult): ProbeResult {
  if (probe.kind !== "companion" || token.kind !== "untrusted") return probe;
  return {
    kind: "untrusted",
    untrusted: {
      port: probe.companion.port,
      extensionId: token.refusal.extensionId,
      fix: token.refusal.fix,
    },
  };
}

/**
 * Probes one port. Returns a companion, an "untrusted" refusal, or none
 * on any other failure (timeout, refused connection, non-Pinta service).
 */
async function probe(port: number): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      signal: ctrl.signal,
    });
    // Only bother reading bodies we can act on: 2xx health, or a 403
    // that may be the companion's untrusted-extension refusal.
    if (!res.ok && res.status !== 403) return { kind: "none" };
    const body = await res.json().catch(() => null);
    const result = parseHealthResponse(port, res.status, body);
    if (result.kind !== "companion") return result;
    return applyTokenResult(result, await acquireCompanionToken(`http://127.0.0.1:${port}`));
  } catch {
    return { kind: "none" };
  } finally {
    clearTimeout(timer);
  }
}

/** Split probe results into usable companions and untrusted refusals. */
export function collectProbeResults(results: readonly ProbeResult[]): DiscoveryResult {
  const companions: Companion[] = [];
  const untrusted: UntrustedCompanion[] = [];
  for (const r of results) {
    if (r.kind === "companion") companions.push(r.companion);
    else if (r.kind === "untrusted") untrusted.push(r.untrusted);
  }
  return { companions, untrusted };
}

/**
 * Scans the full Pinta port range in parallel. Order of returned lists
 * follows port number ascending. Total wall-clock latency is one
 * PROBE_TIMEOUT_MS slot regardless of how many ports respond.
 */
export async function discoverCompanionsDetailed(): Promise<DiscoveryResult> {
  const ports = [];
  for (let p = PORT_START; p <= PORT_END; p++) ports.push(p);
  return collectProbeResults(await Promise.all(ports.map(probe)));
}

/** Companions only (untrusted refusals dropped). */
export async function discoverCompanions(): Promise<Companion[]> {
  return (await discoverCompanionsDetailed()).companions;
}
