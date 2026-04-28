// Discovers running Pinta companions by parallel-scanning the
// reserved port range. Each companion advertises projectRoot +
// urlPatterns on /v1/health, which is enough to populate the side
// panel's project picker without the extension needing to read the
// shared ~/.pinta/registry.json (Chrome extensions have no fs access).

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
 * Probes one port. Returns a Companion descriptor on success, null on
 * any failure (timeout, refused connection, non-Pinta service).
 */
async function probe(port: number): Promise<Companion | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok?: boolean;
      projectRoot?: string;
      urlPatterns?: string[];
      registryId?: string;
      version?: string;
    };
    if (!body?.ok || typeof body.projectRoot !== "string") return null;
    return {
      port,
      projectRoot: body.projectRoot,
      urlPatterns: Array.isArray(body.urlPatterns) ? body.urlPatterns : [],
      registryId: body.registryId,
      version: body.version,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scans the full Pinta port range in parallel. Order of returned list
 * follows port number ascending. Total wall-clock latency is one
 * PROBE_TIMEOUT_MS slot regardless of how many ports respond.
 */
export async function discoverCompanions(): Promise<Companion[]> {
  const ports = [];
  for (let p = PORT_START; p <= PORT_END; p++) ports.push(p);
  const results = await Promise.all(ports.map(probe));
  return results.filter((c): c is Companion => c !== null);
}
