import type { Server as HttpServer } from "node:http";
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

export function attachWebSocket(opts: AttachOptions): WebSocketServer {
  const { server, store } = opts;
  const log = opts.log ?? (() => {});

  const wss = new WebSocketServer({ server, path: "/" });

  // Push every store mutation to all connected clients so the side panel
  // sees agent-driven state changes (e.g. mark_session_applying via HTTP)
  // in real time without re-fetching. We push the active annotation
  // session AND every interactive-module session (test-pilot etc.) so
  // ephemeral query sessions surface their results back to the
  // extension. Skip only when the mutation is on some unrelated session
  // (another tab's draft, an old completed session).
  store.subscribe((session) => {
    const isActive = session.id === store.getActive()?.id;
    const isInteractiveModule = session.modules?.some(
      (m) => m.id === "test-pilot",
    );
    if (!isActive && !isInteractiveModule) return;
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
