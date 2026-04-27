import type { ClientMessage, ServerMessage } from "@pinta/shared";

export type WsClientStatus = "connecting" | "connected" | "disconnected";

export type WsClientOptions = {
  url: string;
  onMessage: (msg: ServerMessage) => void;
  onStatusChange: (status: WsClientStatus) => void;
};

export class WsClient {
  private socket: WebSocket | null = null;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private readonly outbox: ClientMessage[] = [];

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
      this.outbox.push(msg);
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
      while (this.outbox.length > 0) {
        const msg = this.outbox.shift()!;
        this.socket!.send(JSON.stringify(msg));
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
