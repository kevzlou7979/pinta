import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type {
  AnnotationStatus,
  Session,
  SessionStatus,
} from "@pinta/shared";

export type SetStatusInput = {
  status: SessionStatus;
  summary?: string;
  errorMessage?: string;
};

export type SetAnnotationStatusInput = {
  status: AnnotationStatus;
  errorMessage?: string;
};

export interface Backend {
  health(): Promise<{ ok: boolean; projectRoot?: string }>;
  getPendingSession(): Promise<Session | null>;
  getSession(id: string): Promise<Session | null>;
  setStatus(id: string, input: SetStatusInput): Promise<Session>;
  setAnnotationStatus(
    sessionId: string,
    annotationId: string,
    input: SetAnnotationStatusInput,
  ): Promise<Session>;
  getScreenshot(id: string): Promise<{ base64: string; mediaType: string } | null>;
}

/**
 * Bridge backend: talks to a running companion's HTTP API. This is the
 * default — one companion holds state for both the Chrome extension and
 * any MCP-using agent.
 */
export class HttpBackend implements Backend {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<{ ok: boolean; projectRoot?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/health`);
      if (!res.ok) return { ok: false };
      return (await res.json()) as { ok: boolean; projectRoot?: string };
    } catch {
      return { ok: false };
    }
  }

  async getPendingSession(): Promise<Session | null> {
    const res = await fetch(`${this.baseUrl}/v1/sessions/poll`);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`poll failed: ${res.status}`);
    return (await res.json()) as Session;
  }

  async getSession(id: string): Promise<Session | null> {
    const res = await fetch(`${this.baseUrl}/v1/sessions/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`get failed: ${res.status}`);
    return (await res.json()) as Session;
  }

  async setStatus(id: string, input: SetStatusInput): Promise<Session> {
    const res = await fetch(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(id)}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) throw new Error(`status update failed: ${res.status}`);
    return (await res.json()) as Session;
  }

  async setAnnotationStatus(
    sessionId: string,
    annotationId: string,
    input: SetAnnotationStatusInput,
  ): Promise<Session> {
    const res = await fetch(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/annotations/${encodeURIComponent(annotationId)}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      throw new Error(`annotation status update failed: ${res.status}`);
    }
    return (await res.json()) as Session;
  }

  async getScreenshot(
    id: string,
  ): Promise<{ base64: string; mediaType: string } | null> {
    const session = await this.getSession(id);
    if (!session?.fullPageScreenshotPath) return null;

    const abs = isAbsolute(session.fullPageScreenshotPath)
      ? session.fullPageScreenshotPath
      : join(session.projectRoot, session.fullPageScreenshotPath);

    try {
      const bytes = await readFile(abs);
      return { base64: bytes.toString("base64"), mediaType: "image/png" };
    } catch (err) {
      throw new Error(
        `could not read screenshot at ${abs}: ${(err as Error).message}`,
      );
    }
  }
}
