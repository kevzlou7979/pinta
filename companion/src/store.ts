import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Annotation,
  AnnotationStatus,
  Session,
  SessionStatus,
  SessionProducer,
} from "@pinta/shared";

type Waiter = (session: Session) => void;
type Listener = (session: Session) => void;

export class SessionStore {
  private sessions = new Map<string, Session>();
  private activeId: string | null = null;
  private waiters: Waiter[] = [];
  private listeners = new Set<Listener>();

  constructor(public readonly projectRoot: string) {}

  /**
   * Subscribe to every session mutation — used by the WS layer to push
   * `session.synced` to connected extensions whenever the agent updates
   * status via HTTP / MCP. Returns an unsubscribe.
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyChange(session: Session): void {
    for (const fn of this.listeners) fn(session);
  }

  private get sessionsDir(): string {
    return join(this.projectRoot, ".pinta", "sessions");
  }

  /** Path stored on the session — relative to projectRoot, posix-style. */
  private screenshotPath(id: string): string {
    return `.pinta/sessions/${id}.png`;
  }

  private absScreenshotPath(id: string): string {
    return join(this.sessionsDir, `${id}.png`);
  }

  /**
   * If the session carries a base64 PNG data URL, write it to disk and
   * replace the inline data with a relative path reference. Mutates and
   * returns the session.
   */
  private async extractScreenshot(session: Session): Promise<Session> {
    const data = session.fullPageScreenshot;
    if (!data) return session;
    const m = /^data:image\/(png|jpeg);base64,(.+)$/i.exec(data);
    if (!m) return session;
    const [, , base64] = m;
    await mkdir(this.sessionsDir, { recursive: true });
    await writeFile(this.absScreenshotPath(session.id), Buffer.from(base64!, "base64"));
    session.fullPageScreenshotPath = this.screenshotPath(session.id);
    delete session.fullPageScreenshot;
    return session;
  }

  async restore(): Promise<void> {
    try {
      await mkdir(this.sessionsDir, { recursive: true });
      const files = await readdir(this.sessionsDir);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const raw = await readFile(join(this.sessionsDir, f), "utf8");
        const session = JSON.parse(raw) as Session;
        this.sessions.set(session.id, session);
      }
    } catch {
      // first run, nothing to restore
    }
  }

  private async persist(session: Session): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    const file = join(this.sessionsDir, `${session.id}.json`);
    await writeFile(file, JSON.stringify(session, null, 2), "utf8");
  }

  getActive(): Session | null {
    if (!this.activeId) return null;
    return this.sessions.get(this.activeId) ?? null;
  }

  get(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  createSession(input: {
    url: string;
    producer?: SessionProducer;
  }): Session {
    // Idempotent on the drafting session. The side panel sends
    // session.create whenever it reconnects (e.g. user navigated tabs and
    // we re-routed back to this companion). Without this guard, a fresh
    // session would replace the user's in-progress draft and the
    // annotations they'd already added would silently disappear from view.
    const existing = this.getActive();
    if (existing && existing.status === "drafting") {
      // Update the URL in case the user is now on a different page in
      // the same project — annotations still carry their per-target URL.
      if (input.url) existing.url = input.url;
      return existing;
    }
    const session: Session = {
      id: randomUUID(),
      url: input.url,
      projectRoot: this.projectRoot,
      startedAt: Date.now(),
      annotations: [],
      status: "drafting",
      producer: input.producer ?? "extension",
    };
    this.sessions.set(session.id, session);
    this.activeId = session.id;
    return session;
  }

  async ingestSession(session: Session): Promise<Session> {
    const stored: Session = {
      ...session,
      projectRoot: session.projectRoot || this.projectRoot,
    };
    await this.extractScreenshot(stored);
    this.sessions.set(stored.id, stored);
    if (stored.status === "drafting") this.activeId = stored.id;
    await this.persist(stored);
    this.notifyChange(stored);
    if (stored.status === "submitted") this.notifyWaiters(stored);
    return stored;
  }

  addAnnotation(sessionId: string, annotation: Annotation): Session {
    const session = this.requireSession(sessionId);
    session.annotations.push(annotation);
    this.notifyChange(session);
    return session;
  }

  updateAnnotation(
    sessionId: string,
    annotationId: string,
    patch: Partial<Annotation>,
  ): Session {
    const session = this.requireSession(sessionId);
    const idx = session.annotations.findIndex((a) => a.id === annotationId);
    if (idx === -1) throw new Error(`annotation ${annotationId} not found`);
    session.annotations[idx] = {
      ...session.annotations[idx],
      ...patch,
    } as Annotation;
    this.notifyChange(session);
    return session;
  }

  removeAnnotation(sessionId: string, annotationId: string): Session {
    const session = this.requireSession(sessionId);
    session.annotations = session.annotations.filter((a) => a.id !== annotationId);
    this.notifyChange(session);
    return session;
  }

  async submit(
    sessionId: string,
    screenshot?: string,
    autoApply?: boolean,
  ): Promise<Session> {
    const session = this.requireSession(sessionId);
    session.status = "submitted";
    session.submittedAt = Date.now();
    if (screenshot) session.fullPageScreenshot = screenshot;
    if (autoApply !== undefined) session.autoApply = autoApply;
    await this.extractScreenshot(session);
    await this.persist(session);
    this.notifyChange(session);
    this.notifyWaiters(session);
    return session;
  }

  async setStatus(
    sessionId: string,
    status: SessionStatus,
    extras?: { summary?: string; errorMessage?: string },
  ): Promise<Session> {
    const session = this.requireSession(sessionId);
    session.status = status;
    if (extras?.summary !== undefined) session.appliedSummary = extras.summary;
    if (extras?.errorMessage !== undefined) session.errorMessage = extras.errorMessage;
    await this.persist(session);
    this.notifyChange(session);
    return session;
  }

  async setAnnotationStatus(
    sessionId: string,
    annotationId: string,
    status: AnnotationStatus,
    extras?: { errorMessage?: string },
  ): Promise<Session> {
    const session = this.requireSession(sessionId);
    const idx = session.annotations.findIndex((a) => a.id === annotationId);
    if (idx === -1) throw new Error(`annotation ${annotationId} not found`);
    const current = session.annotations[idx]!;
    session.annotations[idx] = {
      ...current,
      status,
      errorMessage: extras?.errorMessage,
    };
    // Auto-roll the session status when every annotation has resolved.
    const settled = session.annotations.every(
      (a) => a.status === "done" || a.status === "error",
    );
    if (settled && session.status === "applying") {
      session.status = session.annotations.some((a) => a.status === "error")
        ? "error"
        : "done";
    }
    await this.persist(session);
    this.notifyChange(session);
    return session;
  }

  /**
   * First-claim-wins. If the session has no claimer yet, mark it
   * claimed by `claimerId` and return `{ ok: true, session }`. If
   * already claimed by someone else, return `{ ok: false, claimedBy }`.
   * Idempotent for the same claimerId — re-claiming returns ok.
   */
  async tryClaim(
    sessionId: string,
    claimerId: string,
  ): Promise<
    | { ok: true; session: Session }
    | { ok: false; claimedBy: string; claimedAt: number }
  > {
    const session = this.requireSession(sessionId);
    if (session.claimedBy && session.claimedBy !== claimerId) {
      return {
        ok: false,
        claimedBy: session.claimedBy,
        claimedAt: session.claimedAt ?? 0,
      };
    }
    if (!session.claimedBy) {
      session.claimedBy = claimerId;
      session.claimedAt = Date.now();
      await this.persist(session);
      this.notifyChange(session);
    }
    return { ok: true, session };
  }

  takeNextSubmitted(): Session | null {
    const submitted = [...this.sessions.values()]
      .filter((s) => s.status === "submitted")
      .sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
    return submitted[0] ?? null;
  }

  waitForSubmitted(timeoutMs: number): Promise<Session | null> {
    const ready = this.takeNextSubmitted();
    if (ready) return Promise.resolve(ready);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);

      const waiter: Waiter = (session) => {
        clearTimeout(timer);
        resolve(session);
      };
      this.waiters.push(waiter);
    });
  }

  private notifyWaiters(session: Session): void {
    const current = this.waiters;
    this.waiters = [];
    for (const w of current) w(session);
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`session ${id} not found`);
    return session;
  }
}
