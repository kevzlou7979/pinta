import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type {
  AnnotationStatus,
  Session,
  SessionStatus,
} from "@pinta/shared";
import { SessionStore } from "./store.js";
import {
  snapshot as registrySnapshot,
  updateUrlPatterns as updateRegistryUrlPatterns,
  type RegistryEntry,
} from "./registry.js";
import { addUrlPattern, readProjectConfig } from "./project-config.js";

export type ServerOptions = {
  host?: string;
  port: number;
  /**
   * If true and `port` is in use, increment up to `portRangeEnd` looking
   * for a free port. Defaults to false to preserve the historical
   * "fail fast on collision" behavior for explicit --port usage.
   */
  autoAllocatePort?: boolean;
  portRangeEnd?: number;
  store: SessionStore;
  log?: (msg: string) => void;
  /**
   * Mutable hook into this companion's registry entry, set by the CLI
   * after registration so health/registry endpoints can surface live
   * urlPatterns + the entry id (used by POST /v1/url-patterns).
   */
  getRegistryEntry?: () => RegistryEntry | null;
};

const POLL_TIMEOUT_MS = 25_000;
const DEFAULT_PORT_RANGE_END = 7898;

// Cap incoming HTTP request bodies. The largest legitimate payload is
// a session.submit carrying a full-page PNG screenshot base64-encoded
// in `session.fullPageScreenshot` — at 1920×3000 DPR 2 that's ~12 MB
// raw, ~16 MB base64. 50 MB gives 3× headroom for unusually tall
// pages without leaving the companion exposed to OOM via a malicious
// local process POSTing an unbounded body. Without this, `readJson`
// would buffer the entire chunk stream into memory.
const MAX_HTTP_BODY_BYTES = 50 * 1024 * 1024;

const okStatuses: SessionStatus[] = [
  "drafting",
  "submitted",
  "applying",
  "done",
  "error",
];

const okAnnotationStatuses: AnnotationStatus[] = ["applying", "done", "error"];

export type StartedServer = {
  close: () => Promise<void>;
  port: number;
  server: ReturnType<typeof createServer>;
};

export async function startServer(opts: ServerOptions): Promise<StartedServer> {
  const { store } = opts;
  const host = opts.host ?? "127.0.0.1";
  const log = opts.log ?? (() => {});
  const autoAllocate = opts.autoAllocatePort ?? false;
  const rangeEnd = opts.portRangeEnd ?? DEFAULT_PORT_RANGE_END;

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res, store, log, opts);
    } catch (err) {
      log(`error: ${(err as Error).message}`);
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  // Try ports in sequence until one binds. Without auto-allocation we
  // surface the original EADDRINUSE so callers passing an explicit
  // --port get the failure they expect.
  let port = opts.port;
  while (true) {
    try {
      await listen(server, port, host);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" && autoAllocate && port < rangeEnd) {
        port += 1;
        continue;
      }
      throw err;
    }
  }

  log(`pinta companion listening on http://${host}:${port}`);
  return {
    port,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: SessionStore,
  log: (msg: string) => void,
  opts: ServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  const path = url.pathname;

  // CORS for local dev. Reads (GET) are open — any tool on the user's
  // machine should be able to probe /v1/health. Writes (POST/PUT/DELETE)
  // are gated: only the extension itself, the agent's localhost CLI
  // (no-Origin), or an explicitly-permitted origin may mutate state.
  // Without this, a malicious page in the user's *own* browser could
  // CSRF the companion (DELETE /v1/sessions, POST /v1/url-patterns)
  // because the server binds to 127.0.0.1 — which doesn't help when the
  // attacker is already a tab in the same browser.
  const reqOrigin = req.headers.origin ?? "";
  const isExtensionOrigin = reqOrigin.startsWith("chrome-extension://");
  const isReadMethod = method === "GET" || method === "HEAD";
  const writeAllowed = !reqOrigin || isExtensionOrigin;

  // ACAO mirroring: echo the request's Origin when it's a Chrome
  // extension (so the browser allows credentialed fetches), else "*"
  // for the read-only case. Methods/headers are constant.
  res.setHeader(
    "Access-Control-Allow-Origin",
    isExtensionOrigin ? reqOrigin : "*",
  );
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, DELETE, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Reject cross-origin writes from non-extension pages. Same-origin or
  // no-Origin (Node CLI, curl, native fetch without Origin header) pass
  // through; only browser-tab attacks are blocked.
  if (!isReadMethod && !writeAllowed) {
    log(`rejected ${method} ${path} from origin ${reqOrigin}`);
    return sendJson(res, 403, { error: "forbidden cross-origin write" });
  }

  if (method === "GET" && path === "/v1/health") {
    const entry = opts.getRegistryEntry?.() ?? null;
    return sendJson(res, 200, {
      ok: true,
      projectRoot: store.projectRoot,
      port: entry?.port,
      urlPatterns: entry?.urlPatterns ?? [],
      registryId: entry?.id,
      version: entry?.version,
      pid: process.pid,
    });
  }

  // Surface every running companion so the extension can populate its
  // project picker without scanning ports itself. Returns the same
  // pruned snapshot we use for skill discovery.
  if (method === "GET" && path === "/v1/registry") {
    const snap = await registrySnapshot();
    return sendJson(res, 200, snap);
  }

  // Append a URL pattern to this project's .pinta.json. Side panel
  // calls this when the user clicks "Associate this URL with this
  // project". Returns the updated patterns so the extension can
  // re-evaluate routing immediately.
  if (method === "POST" && path === "/v1/url-patterns") {
    const body = await readJson<{ pattern: string }>(req);
    if (!body.pattern || typeof body.pattern !== "string") {
      return sendJson(res, 400, { error: "missing pattern" });
    }
    const patterns = await addUrlPattern(store.projectRoot, body.pattern);
    log(`url-pattern added: ${body.pattern}`);
    // Persist the change in two places: the in-memory entry (so this
    // companion's own /v1/health is correct immediately) and the
    // shared ~/.pinta/registry.json (so other companions and the
    // extension see the update via /v1/registry).
    const entry = opts.getRegistryEntry?.();
    if (entry) {
      entry.urlPatterns = patterns;
      await updateRegistryUrlPatterns(entry.id, patterns);
    }
    return sendJson(res, 200, { urlPatterns: patterns });
  }

  // Read the on-disk patterns directly. Used by tests + by the
  // extension when bootstrapping after a companion restart.
  if (method === "GET" && path === "/v1/url-patterns") {
    const config = await readProjectConfig(store.projectRoot);
    return sendJson(res, 200, { urlPatterns: config.urlPatterns ?? [] });
  }

  if (method === "GET" && path === "/v1/sessions/active") {
    return sendJson(res, 200, store.getActive());
  }

  // ── Importable modules (Phase 19) ────────────────────────────────
  // Installed third-party modules live under `.pinta/modules/<id>/`.
  // Writes are already gated by the extension-origin / no-Origin CORS
  // check above, so only the extension or the local agent can mutate
  // them. The store validates the manifest + id (path-traversal guard)
  // and records the user's capability consent.

  if (method === "GET" && path === "/v1/modules") {
    return sendJson(res, 200, await store.listInstalledModules());
  }

  if (method === "POST" && path === "/v1/modules") {
    const body = await readJson<{
      package?: unknown;
      grantedCapabilities?: unknown;
    }>(req);
    const grants = Array.isArray(body.grantedCapabilities)
      ? (body.grantedCapabilities as string[])
      : [];
    try {
      const installed = await store.installModule(
        body.package as never,
        grants as never,
      );
      log(
        `module installed: ${installed.manifest.id} (caps: ${installed.grantedCapabilities.join(", ") || "none"})`,
      );
      return sendJson(res, 201, installed);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  const moduleMatch = path.match(/^\/v1\/modules\/([^/]+)$/);
  if (method === "DELETE" && moduleMatch) {
    const id = decodeURIComponent(moduleMatch[1]!);
    try {
      await store.uninstallModule(id);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    log(`module uninstalled: ${id}`);
    return sendJson(res, 200, { ok: true });
  }

  if (method === "DELETE" && path === "/v1/test-docs") {
    // Wipe the entire .pinta/test-docs/ directory. Called when the
    // user hits "Clear catalog" in Test Pilot — keeps the on-disk
    // copy of (potentially credential-bearing) UAT specs in lock-step
    // with the side panel's catalog state.
    await store.purgeAllTestDocs();
    log("test-docs cleared");
    return sendJson(res, 200, { ok: true });
  }

  // Replace one test-doc file in place. The side panel writes the
  // entire catalog back whenever the user edits it (add / delete /
  // rename / reorder section or test) so the on-disk spec stays the
  // source of truth — the agent's `?` (detail-steps) flow keys off
  // the file, and edits survive regen.
  const putTestDocMatch = path.match(/^\/v1\/test-docs\/([^/]+)$/);
  if (method === "PUT" && putTestDocMatch) {
    const docId = putTestDocMatch[1]!;
    // Reject anything that could escape the test-docs directory or
    // collide with the on-disk extension scheme. Doc ids should be
    // UUIDs in practice; accept a permissive but safe alphabet.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(docId)) {
      return sendJson(res, 400, { error: "invalid docId" });
    }
    const body = await readJson<{ content: string }>(req);
    if (typeof body.content !== "string") {
      return sendJson(res, 400, { error: "missing content" });
    }
    await store.writeTestDoc(docId, body.content);
    log(`test-doc ${docId} written (${body.content.length}B)`);
    return sendJson(res, 200, { ok: true });
  }

  // Per-author results sidecar (Pass/Fail marks + chat threads + detail
  // cache). Companion-side durable storage so a chrome.storage wipe
  // doesn't lose tester progress. Path includes an optional author
  // slug — empty when the catalog has no author metadata yet.
  //
  // Author slug rules: lowercase kebab-case, [a-z0-9-], 0-64 chars.
  // Anything else is rejected to prevent path traversal or filename
  // collisions with other on-disk schemes.
  const resultsMatch = path.match(
    /^\/v1\/test-docs\/([^/]+)\/results(?:\/([^/]*))?$/,
  );
  if (resultsMatch && (method === "PUT" || method === "GET")) {
    const docId = resultsMatch[1]!;
    const authorSlug = resultsMatch[2] ?? "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(docId)) {
      return sendJson(res, 400, { error: "invalid docId" });
    }
    if (authorSlug !== "" && !/^[a-z0-9-]{1,64}$/.test(authorSlug)) {
      return sendJson(res, 400, { error: "invalid author slug" });
    }
    if (method === "PUT") {
      const body = await readJson<{ content: string }>(req);
      if (typeof body.content !== "string") {
        return sendJson(res, 400, { error: "missing content" });
      }
      await store.writeTestResults(docId, authorSlug, body.content);
      log(
        `test-results ${docId}${authorSlug ? `/${authorSlug}` : ""} written (${body.content.length}B)`,
      );
      return sendJson(res, 200, { ok: true });
    }
    // GET
    const content = await store.readTestResults(docId, authorSlug);
    if (content === null) {
      return sendJson(res, 404, { error: "no results yet" });
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(content);
    return;
  }

  if (method === "DELETE" && path === "/v1/sessions") {
    // Wipe every persisted session + screenshot. Drafting session (if
    // any) is preserved by the store. Called from the side panel's
    // History → Clear button.
    await store.purgeAllSessions();
    log("sessions cleared");
    return sendJson(res, 200, { ok: true });
  }

  if (method === "GET" && path === "/v1/sessions") {
    // Recent sessions, newest first. Light summary — no annotation bodies
    // — so the side panel history view stays fast even with many sessions.
    const summaries = store.list().map((s) => ({
      id: s.id,
      url: s.url,
      status: s.status,
      startedAt: s.startedAt,
      submittedAt: s.submittedAt,
      annotationCount: s.annotations.length,
      appliedSummary: s.appliedSummary,
      errorMessage: s.errorMessage,
      fullPageScreenshotPath: s.fullPageScreenshotPath,
    }));
    return sendJson(res, 200, summaries);
  }

  if (method === "GET" && path === "/v1/sessions/poll") {
    const session = await store.waitForSubmitted(POLL_TIMEOUT_MS);
    if (!session) {
      res.statusCode = 204;
      res.end();
      return;
    }
    return sendJson(res, 200, session);
  }

  if (method === "GET" && path === "/v1/sessions/stream") {
    // Server-Sent Events stream. One long-lived connection per agent;
    // each newly-submitted session arrives as a single `data: {json}` line.
    // Avoids the per-cycle tool-call noise that long-polling generates
    // in agent transcripts.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Initial backlog: any sessions already in `submitted` state get
    // pushed immediately so a freshly-connected agent doesn't miss them.
    for (const s of store.list()) {
      if (s.status === "submitted") {
        res.write(`event: session\ndata: ${JSON.stringify(s)}\n\n`);
      }
    }

    let alive = true;
    const tearDown = (reason: string) => {
      if (!alive) return;
      alive = false;
      clearInterval(keepalive);
      unsubscribe();
      log(`sse stream closed (${reason})`);
    };

    // Push on every transition into the submitted state. Wrap the
    // write in try/catch — if the agent's TCP socket half-closed, a
    // synchronous write throws and would otherwise propagate up
    // through the store's listener loop, blocking other subscribers.
    const unsubscribe = store.subscribe((session) => {
      if (!alive) return;
      if (session.status !== "submitted") return;
      try {
        res.write(`event: session\ndata: ${JSON.stringify(session)}\n\n`);
      } catch (err) {
        tearDown(`write failed: ${(err as Error).message}`);
      }
    });

    // Periodic comment keeps proxies / agents from idle-closing the
    // connection. SSE comments start with `:` and are ignored by clients.
    const keepalive = setInterval(() => {
      if (!alive) return;
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch (err) {
        tearDown(`keepalive write failed: ${(err as Error).message}`);
      }
    }, 20_000);

    req.on("close", () => tearDown("client closed"));
    res.on("error", (err) => tearDown(`response error: ${err.message}`));
    return;
  }

  if (method === "POST" && path === "/v1/sessions") {
    const body = await readJson<Session>(req);
    const session = await store.ingestSession(body);
    log(`ingested session ${session.id} (${session.annotations.length} annotations)`);
    return sendJson(res, 201, session);
  }

  const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)$/);
  if (method === "GET" && sessionMatch) {
    const session = store.get(sessionMatch[1]!);
    if (!session) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, session);
  }

  // First-claim-wins. Multiple agents subscribed to the same SSE stream
  // (typical inside Claude Dock with several terminals on one project)
  // all receive every submitted-session push; this endpoint lets them
  // race to claim and the winner processes the session. Losers get 409
  // and silently skip back to streaming.
  const claimMatch = path.match(/^\/v1\/sessions\/([^/]+)\/claim$/);
  if (method === "POST" && claimMatch) {
    const body = await readJson<{ claimerId?: string; role?: string }>(req);
    const claimerId =
      body.claimerId && typeof body.claimerId === "string"
        ? body.claimerId
        : null;
    if (!claimerId) {
      return sendJson(res, 400, { error: "missing claimerId" });
    }
    // Phase 18b — role-enforced routing. The skill sends a role when
    // the terminal was started with a role flag; we reject mismatches
    // with 403 so the agent can't process work outside its lane even
    // when no other terminal has claimed it yet. Generalists (no flag)
    // omit `role` and fall through to first-wins.
    const role =
      body.role === "annotate" ||
      body.role === "test-pilot" ||
      body.role === "audit" ||
      body.role === "chat"
        ? body.role
        : null;
    let result;
    try {
      result = await store.tryClaim(claimMatch[1]!, claimerId, role);
    } catch (err) {
      return sendJson(res, 404, { error: (err as Error).message });
    }
    if (!result.ok) {
      if (result.reason === "role-mismatch") {
        log(
          `claim ${claimMatch[1]} REJECTED for ${claimerId} (role ${role} != expected ${result.expectedRole})`,
        );
        return sendJson(res, 403, {
          error: "role mismatch",
          expectedRole: result.expectedRole,
        });
      }
      log(
        `claim ${claimMatch[1]} REJECTED for ${claimerId} (already held by ${result.claimedBy})`,
      );
      return sendJson(res, 409, {
        error: "already claimed",
        claimedBy: result.claimedBy,
        claimedAt: result.claimedAt,
      });
    }
    log(
      `claim ${claimMatch[1]} GRANTED to ${claimerId}${role ? ` (role: ${role})` : ""}`,
    );
    return sendJson(res, 200, result.session);
  }

  const statusMatch = path.match(/^\/v1\/sessions\/([^/]+)\/status$/);
  if (method === "POST" && statusMatch) {
    const body = await readJson<{
      status: SessionStatus;
      summary?: string;
      errorMessage?: string;
    }>(req);
    if (!okStatuses.includes(body.status)) {
      return sendJson(res, 400, { error: `invalid status: ${body.status}` });
    }
    const session = await store.setStatus(statusMatch[1]!, body.status, body);
    log(`session ${session.id} → ${session.status}`);
    return sendJson(res, 200, session);
  }

  const annotationStatusMatch = path.match(
    /^\/v1\/sessions\/([^/]+)\/annotations\/([^/]+)\/status$/,
  );
  if (method === "POST" && annotationStatusMatch) {
    const body = await readJson<{
      status: AnnotationStatus;
      errorMessage?: string;
    }>(req);
    if (!okAnnotationStatuses.includes(body.status)) {
      return sendJson(res, 400, {
        error: `invalid annotation status: ${body.status}`,
      });
    }
    const session = await store.setAnnotationStatus(
      annotationStatusMatch[1]!,
      annotationStatusMatch[2]!,
      body.status,
      body,
    );
    log(
      `session ${session.id} annotation ${annotationStatusMatch[2]} → ${body.status}`,
    );
    return sendJson(res, 200, session);
  }

  sendJson(res, 404, { error: `no route for ${method} ${path}` });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  // Bound the buffered body so a malicious local process can't OOM the
  // companion with an unbounded POST. We accumulate sizes during the
  // chunk stream and bail early once we cross MAX_HTTP_BODY_BYTES —
  // doing the check at end-of-stream wouldn't help (we'd already have
  // buffered the over-limit bytes).
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_HTTP_BODY_BYTES) {
      // Drain the rest of the stream so the connection closes cleanly.
      req.destroy();
      throw new Error(
        `request body too large (>${MAX_HTTP_BODY_BYTES} bytes)`,
      );
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new Error("empty body");
  return JSON.parse(raw) as T;
}
