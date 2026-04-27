import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type {
  AnnotationStatus,
  Session,
  SessionStatus,
} from "@pinta/shared";
import { SessionStore } from "./store.js";

export type ServerOptions = {
  host?: string;
  port: number;
  store: SessionStore;
  log?: (msg: string) => void;
};

const POLL_TIMEOUT_MS = 25_000;

const okStatuses: SessionStatus[] = [
  "drafting",
  "submitted",
  "applying",
  "done",
  "error",
];

const okAnnotationStatuses: AnnotationStatus[] = ["applying", "done", "error"];

export function startServer(opts: ServerOptions) {
  const { port, store } = opts;
  const host = opts.host ?? "127.0.0.1";
  const log = opts.log ?? (() => {});

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res, store, log);
    } catch (err) {
      log(`error: ${(err as Error).message}`);
      sendJson(res, 500, { error: (err as Error).message });
    }
  });

  return new Promise<{
    close: () => Promise<void>;
    port: number;
    server: typeof server;
  }>((resolve) => {
    server.listen(port, host, () => {
      log(`pinta companion listening on http://${host}:${port}`);
      resolve({
        port,
        server,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: SessionStore,
  log: (msg: string) => void,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  const path = url.pathname;

  // CORS for local dev (extension content scripts may call directly)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === "GET" && path === "/v1/health") {
    return sendJson(res, 200, { ok: true, projectRoot: store.projectRoot });
  }

  if (method === "GET" && path === "/v1/sessions/active") {
    return sendJson(res, 200, store.getActive());
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

    // Push on every transition into the submitted state.
    const unsubscribe = store.subscribe((session) => {
      if (session.status === "submitted") {
        res.write(`event: session\ndata: ${JSON.stringify(session)}\n\n`);
      }
    });

    // Periodic comment keeps proxies / agents from idle-closing the
    // connection. SSE comments start with `:` and are ignored by clients.
    const keepalive = setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, 20_000);

    req.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
      log("ws stream closed");
    });
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
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) throw new Error("empty body");
  return JSON.parse(raw) as T;
}
