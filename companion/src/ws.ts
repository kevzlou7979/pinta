import type { Server as HttpServer, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
  Annotation,
  ClientMessage,
  ServerMessage,
  Session,
} from "@pinta/shared";
import type { SessionStore } from "./store.js";
import {
  ExtensionTrust,
  extensionIdFromOrigin,
  isLoopbackHost,
  isWritingQueryComment,
  parseImageDataUrl,
} from "./security.js";

export type AttachOptions = {
  server: HttpServer;
  store: SessionStore;
  log?: (msg: string) => void;
  /** Shared with startServer so a WS pin is honored by HTTP. */
  trust?: ExtensionTrust;
  /**
   * Accept WS upgrades that carry no Origin header. Nothing legitimate
   * does (the extension always sends its chrome-extension:// origin; the
   * agent and MCP backend use HTTP), so this is off unless
   * `PINTA_ALLOW_NO_ORIGIN_WS=1`. Such sockets are never trusted: they
   * can't submit writing ops and their submits never auto-apply.
   */
  allowNoOriginWs?: boolean;
};

// Cap incoming WebSocket frame size. Same rationale as the HTTP body
// cap in server.ts: bound peak memory so a malicious local connection
// can't OOM the companion by streaming arbitrary frames. 50 MB is
// large enough for any legitimate ClientMessage payload (the biggest
// is `annotation.add` with inline reference images; full-page
// screenshots ride on the HTTP submit path, not WS) and small enough
// to refuse abuse.
const MAX_WS_PAYLOAD = 50 * 1024 * 1024;

// How far back a reconnecting client's "missed result" recovery looks.
// Matches the extension's per-op pending timeout (MODULE_OP_TIMEOUT_MS,
// 10 min): a result older than this is past the point any tab is still
// waiting on it, so there's nothing to recover. Bounds replay so a
// reconnect never re-pushes the whole session history.
const RECONNECT_REPLAY_WINDOW_MS = 10 * 60 * 1000;

export type WsOriginVerdict =
  | { ok: true; trusted: boolean }
  | { ok: false; reason: string };

/**
 * Gate a WebSocket upgrade. Localhost binding doesn't help when the
 * attacker is already a tab or another extension in the same browser, so
 * we accept only:
 *
 *  - the trusted Pinta extension (Web Store id, $PINTA_EXTENSION_IDS, or
 *    the first extension ever to connect — pinned trust-on-first-use)
 *  - no Origin header, only when explicitly opted in (untrusted socket)
 *
 * Anything else (web pages, other extensions, a rebound Host) is refused.
 * Without this, a page or rogue extension could open ws://127.0.0.1:7878/
 * and fire `session.submit` / writing module ops the agent would run
 * with no user click. Exported for unit tests.
 */
export function verifyWsOrigin(
  req: Pick<IncomingMessage, "headers">,
  trust: ExtensionTrust,
  allowNoOrigin: boolean,
): WsOriginVerdict {
  if (!isLoopbackHost(req.headers.host)) {
    return { ok: false, reason: `non-loopback host ${req.headers.host}` };
  }
  const origin = (req.headers.origin ?? "").toString();
  if (!origin) {
    return allowNoOrigin
      ? { ok: true, trusted: false }
      : { ok: false, reason: "no Origin header (set PINTA_ALLOW_NO_ORIGIN_WS=1 to allow)" };
  }
  const id = extensionIdFromOrigin(origin);
  if (!id) return { ok: false, reason: `forbidden origin ${origin}` };
  if (!trust.pinOrCheck(id)) {
    return { ok: false, reason: `untrusted extension ${id}` };
  }
  return { ok: true, trusted: true };
}

/**
 * Whether a store mutation should be pushed to extension WS clients.
 *
 *  - The active annotation draft always goes (the side panel mirrors it
 *    live).
 *  - ANY session carrying a module goes — it's a module-query session
 *    whose result some side-panel surface is waiting on. This covers the
 *    built-in interactive modules (Test Pilot, chat, audit-flow) AND every
 *    IMPORTED interactive module (Phase 19). The earlier hardcoded
 *    allow-list of the three built-in ids silently dropped imported
 *    modules' ephemeral `done`, so their tab spun forever even after the
 *    agent posted the board — the regression this function guards.
 *  - Phase 20 — async annotation batches. Once a plain (module-less)
 *    batch is submitted, the extension detaches it from the active draft
 *    and mints a fresh one, so the batch is no longer `activeId`. The
 *    side-panel tray still mirrors its progress, so its
 *    submitted/applying/done/error updates MUST go out — otherwise the
 *    agent's HTTP status writes never reach the panel and the batch is
 *    stranded on "Waiting for agent…" forever. A still-`drafting`
 *    non-active session is some OTHER tab's live draft — not ours to push.
 *  - Anything else (another tab's draft) is skipped.
 *
 * Exported so the gate is unit-testable without booting a real socket.
 */
export function shouldBroadcastSession(
  session: Pick<Session, "id" | "modules" | "status">,
  activeId: string | null,
): boolean {
  if (session.id === activeId) return true;
  if ((session.modules?.length ?? 0) > 0) return true;
  return session.status !== "drafting";
}

/**
 * Pick the ephemeral module-query sessions a freshly (re)connecting client
 * should be re-pushed, so a `done` / `error` that completed during a WS gap
 * (companion restart, dropped socket) isn't lost — the gap that strands a
 * module / audit / chat tab on its spinner forever.
 *
 * Rules:
 *  - never the active annotation draft (already sent on connect),
 *  - must carry a module (it's a module-query session some surface awaits),
 *  - must be terminal (`done` / `error`) — nothing to recover otherwise,
 *  - submitted within `windowMs` so we replay only recent work, never the
 *    whole session history,
 *  - deduped to the LATEST terminal session per module id, so a client that
 *    ran the same module several times only gets the final result.
 *
 * Pure + exported for unit testing — no socket, store, or clock inside.
 */
export function selectReconnectReplaySessions(
  sessions: Session[],
  opts: { activeId: string | null; nowMs: number; windowMs: number },
): Session[] {
  const { activeId, nowMs, windowMs } = opts;
  const recencyOf = (s: Session): number => s.submittedAt ?? s.startedAt ?? 0;
  const latestByModule = new Map<string, Session>();
  for (const s of sessions) {
    if (s.id === activeId) continue;
    if ((s.modules?.length ?? 0) === 0) continue;
    if (s.status !== "done" && s.status !== "error") continue;
    if (nowMs - recencyOf(s) > windowMs) continue;
    const key = s.modules![0]!.id;
    const prev = latestByModule.get(key);
    if (!prev || recencyOf(s) > recencyOf(prev)) latestByModule.set(key, s);
  }
  return [...latestByModule.values()];
}

/** Fan a server message out to every open client (used by the watcher). */
export function broadcastAll(wss: WebSocketServer, msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    try {
      client.send(payload);
    } catch {
      // skip a dead/closing socket
    }
  }
}

export function attachWebSocket(opts: AttachOptions): WebSocketServer {
  const { server, store } = opts;
  const log = opts.log ?? (() => {});
  const trust = opts.trust ?? new ExtensionTrust(store.projectRoot, { log });
  const allowNoOrigin =
    opts.allowNoOriginWs ?? process.env.PINTA_ALLOW_NO_ORIGIN_WS === "1";
  // Per-upgrade trust, read back on "connection".
  const trustedReqs = new WeakSet<IncomingMessage>();

  const wss = new WebSocketServer({
    server,
    path: "/",
    maxPayload: MAX_WS_PAYLOAD,
    verifyClient: (info, cb) => {
      const verdict = verifyWsOrigin(info.req, trust, allowNoOrigin);
      if (verdict.ok) {
        if (verdict.trusted) trustedReqs.add(info.req);
        cb(true);
        return;
      }
      log(`ws upgrade rejected: ${verdict.reason}`);
      cb(false, 403, "forbidden origin");
    },
  });

  // Push store mutations to all connected clients so the side panel sees
  // agent-driven state changes (e.g. mark_session_applying / done via
  // HTTP) in real time without re-fetching. The gate (active draft + any
  // module-query session) lives in shouldBroadcastSession.
  store.subscribe((session) => {
    if (!shouldBroadcastSession(session, store.getActive()?.id ?? null)) {
      return;
    }
    const payload = JSON.stringify({
      type: "session.synced",
      session,
    } satisfies ServerMessage);
    // Per-client try/catch so one dying socket (broken pipe, mid-close
    // race) can't bubble out of the listener and trip the store's
    // notifier chain.
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(payload);
      } catch (err) {
        log(`ws send failed (will skip): ${(err as Error).message}`);
      }
    }
  });

  wss.on("connection", (socket, req) => {
    const trusted = trustedReqs.has(req);
    log(`ws client connected${trusted ? "" : " (untrusted: no writing ops)"}`);

    const send = (msg: ServerMessage) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };

    const broadcast = (msg: ServerMessage) => {
      const payload = JSON.stringify(msg);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    };

    // On connect, sync the active session if one exists
    const active = store.getActive();
    if (active) send({ type: "session.synced", session: active });

    // Defense against a result lost to a WS gap (companion restart /
    // reconnect): re-push recent terminal module-query sessions so a
    // module / audit / chat tab recovers a `done` it missed while the
    // socket was down, instead of spinning until its timeout. Bounded to
    // the latest result per module within the window. See
    // selectReconnectReplaySessions.
    for (const session of selectReconnectReplaySessions(store.list(), {
      activeId: active?.id ?? null,
      nowMs: Date.now(),
      windowMs: RECONNECT_REPLAY_WINDOW_MS,
    })) {
      send({ type: "session.synced", session });
    }

    socket.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch (err) {
        send({ type: "error", message: `bad json: ${(err as Error).message}` });
        return;
      }

      try {
        const session = await dispatch(msg, store, log, { trusted });
        if (session && msg.type === "session.create") {
          broadcast({ type: "session.created", session });
        } else if (session && msg.type === "module.query.submit") {
          // Two messages: a targeted ack (so the requesting extension can
          // pin the new session id) and the regular synced broadcast so
          // every connected client (history viewers, etc.) sees the new
          // session land.
          send({
            type: "module.query.created",
            moduleId: msg.moduleId,
            session,
          });
          broadcast({ type: "session.synced", session });
        } else if (session) {
          broadcast({ type: "session.synced", session });
        }
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      }
    });

    socket.on("close", () => log("ws client disconnected"));
    socket.on("error", (err) => log(`ws error: ${err.message}`));
  });

  return wss;
}

export type DispatchContext = {
  /** Socket came from the trusted Pinta extension (not a no-Origin opt-in). */
  trusted: boolean;
};

export async function dispatch(
  msg: ClientMessage,
  store: SessionStore,
  log: (msg: string) => void,
  ctx: DispatchContext,
): Promise<Session | null> {
  switch (msg.type) {
    case "session.create": {
      const session = store.createSession({
        url: msg.url,
        ephemeral: msg.ephemeral,
        force: msg.force,
      });
      const tag = msg.ephemeral
        ? " (ephemeral)"
        : msg.force
          ? " (forced)"
          : "";
      log(`session.create${tag} → ${session.id}`);
      return session;
    }
    case "annotation.add": {
      const active = store.getActive();
      if (!active) throw new Error("no active session");
      const updated = store.addAnnotation(active.id, msg.annotation);
      log(`annotation.add ${msg.annotation.id} → session ${active.id}`);
      return updated;
    }
    case "annotation.update": {
      const active = store.getActive();
      if (!active) throw new Error("no active session");
      const updated = store.updateAnnotation(active.id, msg.id, msg.patch);
      return updated;
    }
    case "annotation.remove": {
      const active = store.getActive();
      if (!active) throw new Error("no active session");
      const updated = store.removeAnnotation(active.id, msg.id);
      return updated;
    }
    case "session.submit": {
      const active = store.getActive();
      if (!active) throw new Error("no active session");
      if (
        !ctx.trusted &&
        active.annotations.some(
          (a) => a.kind === "query" && isWritingQueryComment(a.comment),
        )
      ) {
        throw new Error("writing ops are only accepted from the Pinta extension");
      }
      const submitted = await store.submit(
        active.id,
        msg.screenshot,
        // An untrusted socket can never skip the plan-confirm gate.
        ctx.trusted ? msg.autoApply : false,
        msg.modules,
      );
      const modulesNote = submitted.modules?.length
        ? `, modules: ${submitted.modules.map((m) => m.id).join(",")}`
        : "";
      log(
        `session.submit ${submitted.id} (${submitted.annotations.length} annotations${submitted.autoApply ? ", auto-apply" : ""}${modulesNote})`,
      );
      return submitted;
    }
    case "module.query.submit": {
      // Bundled one-shot for interactive modules. Creates a fresh
      // ephemeral session, attaches the query annotation, marks
      // submitted with the module. The agent picks it up like any
      // other submitted session and responds via mark_session_done.
      // Writing ops (edit / commit / file issues) run with no further
      // confirmation, so only the trusted extension may send them.
      if (!ctx.trusted && isWritingQueryComment(msg.queryComment)) {
        throw new Error("writing ops are only accepted from the Pinta extension");
      }
      // Reject a bad query image before minting a session it would orphan.
      if (msg.screenshot && !parseImageDataUrl(msg.screenshot)) {
        throw new Error("unsupported image (expected a PNG or JPEG data URL)");
      }
      const session = store.createSession({
        url: msg.url,
        ephemeral: true,
      });
      const queryAnnotation: Annotation = {
        id: randomUUID(),
        createdAt: Date.now(),
        kind: "query",
        strokes: [],
        color: "#000000",
        comment: msg.queryComment,
        url: msg.url,
      };
      store.addAnnotation(session.id, queryAnnotation);
      const submitted = await store.submit(
        session.id,
        msg.screenshot ?? "", // optional query image (e.g. variants look-reference)
        true, // autoApply — agent should not wait for confirmation
        [{ id: msg.moduleId, settings: msg.moduleSettings }],
      );
      log(
        `module.query.submit ${msg.moduleId} → ${submitted.id} (${msg.queryComment.length}B query)`,
      );
      return submitted;
    }
  }
}
