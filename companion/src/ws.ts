import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type {
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
  // in real time without re-fetching.
  store.subscribe((session) => {
    if (session.id !== store.getActive()?.id) return;
    const payload = JSON.stringify({
      type: "session.synced",
      session,
    } satisfies ServerMessage);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
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
      const session = store.createSession({ url: msg.url });
      log(`session.create → ${session.id}`);
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
      );
      log(
        `session.submit ${submitted.id} (${submitted.annotations.length} annotations${submitted.autoApply ? ", auto-apply" : ""})`,
      );
      return submitted;
    }
  }
}
