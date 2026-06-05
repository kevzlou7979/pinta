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

export type AttachOptions = {
  server: HttpServer;
  store: SessionStore;
  log?: (msg: string) => void;
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

/**
 * Reject WebSocket upgrade requests from cross-origin browser tabs.
 * Mirrors the HTTP-side Origin check in server.ts: localhost binding
 * doesn't help when the attacker is already a tab in the same browser,
 * so we explicitly accept only:
 *
 *  - chrome-extension:// (our own side panel)
 *  - no Origin header (Node CLI, agent tooling, raw curl)
 *
 * Anything else is some webpage trying to drive our state — refuse.
 * Without this, a malicious page could open ws://127.0.0.1:7878/ and
 * fire `session.create` / `annotation.add` / `session.submit` to
 * exfiltrate annotations or coerce the agent into running a session.
 */
function isAllowedWsOrigin(req: IncomingMessage): boolean {
  const origin = (req.headers.origin ?? "").toString();
  if (!origin) return true;
  return origin.startsWith("chrome-extension://");
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
 *  - Anything else (another tab's draft, an old non-module session) is
 *    skipped.
 *
 * Exported so the gate is unit-testable without booting a real socket.
 */
export function shouldBroadcastSession(
  session: Pick<Session, "id" | "modules">,
  activeId: string | null,
): boolean {
  if (session.id === activeId) return true;
  return (session.modules?.length ?? 0) > 0;
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

export function attachWebSocket(opts: AttachOptions): WebSocketServer {
  const { server, store } = opts;
  const log = opts.log ?? (() => {});

  const wss = new WebSocketServer({
    server,
    path: "/",
    maxPayload: MAX_WS_PAYLOAD,
    verifyClient: (info, cb) => {
      if (isAllowedWsOrigin(info.req)) {
        cb(true);
        return;
      }
      log(
        `ws upgrade rejected from origin ${info.req.headers.origin ?? "(none)"}`,
      );
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

  wss.on("connection", (socket) => {
    log("ws client connected");

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
        const session = await dispatch(msg, store, log);
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

async function dispatch(
  msg: ClientMessage,
  store: SessionStore,
  log: (msg: string) => void,
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
      const submitted = await store.submit(
        active.id,
        msg.screenshot,
        msg.autoApply,
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
        "", // no screenshot
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
