import type { ClientMessage, ServerMessage } from "@pinta/shared";

export type WsClientStatus = "connecting" | "connected" | "disconnected";

export type WsClientOptions = {
  url: string;
  onMessage: (msg: ServerMessage) => void;
  onStatusChange: (status: WsClientStatus) => void;
};

// Outbox guards — without these, a long disconnect (laptop sleep,
// companion crash) lets the queue grow unbounded and stale messages
// (old session.create, stale annotation.adds) flood the companion on
// reconnect.
const OUTBOX_MAX = 100;
const OUTBOX_TTL_MS = 30_000;

type OutboxEntry = { msg: ClientMessage; at: number };

export class WsClient {
  private socket: WebSocket | null = null;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private readonly outbox: OutboxEntry[] = [];

  constructor(private readonly opts: WsClientOptions) {}

  start(): void {
    this.intentionallyClosed = false;
    this.connect();
  }

  stop(): void {
    this.intentionallyClosed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    } else {
      this.outbox.push({ msg, at: Date.now() });
      // Drop the oldest if we exceeded the cap. Loss > unbounded growth.
      while (this.outbox.length > OUTBOX_MAX) this.outbox.shift();
    }
  }

  private connect(): void {
    this.opts.onStatusChange("connecting");
    try {
      this.socket = new WebSocket(this.opts.url);
    } catch (err) {
      console.error("[ws] construct failed", err);
      this.scheduleReconnect();
      return;
    }

    this.socket.addEventListener("open", () => {
      this.retryCount = 0;
      this.opts.onStatusChange("connected");
      // Flush the outbox, but drop stale entries — better to lose a 5
      // minute-old annotation.add than to replay it after the user
      // started a new draft.
      const now = Date.now();
      while (this.outbox.length > 0) {
        const entry = this.outbox.shift()!;
        if (now - entry.at > OUTBOX_TTL_MS) continue;
        this.socket!.send(JSON.stringify(entry.msg));
      }
    });

    this.socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        this.opts.onMessage(msg);
      } catch (err) {
        console.error("[ws] bad server message", err);
      }
    });

    this.socket.addEventListener("close", () => {
      this.opts.onStatusChange("disconnected");
      if (!this.intentionallyClosed) this.scheduleReconnect();
    });

    this.socket.addEventListener("error", (event) => {
      console.warn("[ws] error", event);
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    const delay = Math.min(30_000, 500 * 2 ** this.retryCount);
    this.retryCount++;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}
