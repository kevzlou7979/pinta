import type {
  Annotation,
  ClientMessage,
  ServerMessage,
  Session,
} from "@pinta/shared";
import { WsClient, type WsClientStatus } from "./ws-client.js";

const COMPANION_URL = "ws://127.0.0.1:7878/";
const COMPANION_HTTP = "http://127.0.0.1:7878";

export type ExtensionMode = "draw" | "select" | "review" | "idle";

class ExtensionState {
  session = $state<Session | null>(null);
  mode = $state<ExtensionMode>("idle");
  selectedAnnotationId = $state<string | null>(null);
  connectionStatus = $state<WsClientStatus>("disconnected");
  lastError = $state<string | null>(null);

  private client: WsClient;
  // Set true between sending session.create and receiving session.created
  // back, so concurrent ensureSession() calls don't create duplicates.
  private creatingSession = false;

  constructor() {
    this.client = new WsClient({
      url: COMPANION_URL,
      onMessage: (msg) => this.onMessage(msg),
      onStatusChange: (status) => {
        this.connectionStatus = status;
      },
    });
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  send(msg: ClientMessage): void {
    this.client.send(msg);
  }

  ensureSession(url: string): void {
    if (this.session || this.creatingSession) return;
    this.creatingSession = true;
    this.send({ type: "session.create", url });
  }

  addAnnotation(annotation: Annotation): void {
    this.send({ type: "annotation.add", annotation });
  }

  updateAnnotation(id: string, patch: Partial<Annotation>): void {
    this.send({ type: "annotation.update", id, patch });
  }

  removeAnnotation(id: string): void {
    this.send({ type: "annotation.remove", id });
  }

  submit(screenshot = ""): void {
    this.send({ type: "session.submit", screenshot });
  }

  /**
   * Mark the current session as canceled (errored on the companion so any
   * agent that polls it later will skip it) and start a fresh drafting
   * session for the same URL.
   */
  async cancelAndRestart(url: string): Promise<void> {
    const current = this.session;
    if (current && current.status !== "drafting") {
      try {
        await fetch(
          `${COMPANION_HTTP}/v1/sessions/${encodeURIComponent(current.id)}/status`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "error",
              errorMessage: "canceled by user",
            }),
          },
        );
      } catch (err) {
        this.lastError = `cancel failed: ${(err as Error).message}`;
      }
    }
    this.session = null;
    this.creatingSession = true;
    this.send({ type: "session.create", url });
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "session.created":
      case "session.synced":
        this.session = msg.session;
        this.creatingSession = false;
        this.lastError = null;
        break;
      case "session.applying":
        if (this.session) this.session.status = "applying";
        break;
      case "session.done":
        if (this.session) {
          this.session.status = "done";
          this.session.appliedSummary = msg.summary;
        }
        break;
      case "error":
        this.lastError = msg.message;
        break;
    }
  }
}

export const app = new ExtensionState();

