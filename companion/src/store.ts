import { mkdir, writeFile, readdir, readFile, unlink, rm } from "node:fs/promises";
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

/**
 * How long a claim survives without activity before another agent can
 * steal it. Refreshed on every status update — a healthy agent emitting
 * progress easily stays under this; one that crashed mid-apply releases
 * the lock instead of orphaning the session forever.
 */
const CLAIM_TTL_MS = 5 * 60 * 1000;

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
    // Isolate listeners so one dying subscriber (closed WS, broken
    // SSE pipe) can't poison the rest of the chain and leave the
    // store in a half-broadcast state.
    for (const fn of this.listeners) {
      try {
        fn(session);
      } catch (err) {
        // Listeners are best-effort — swallow & log so the store loop
        // continues. SSE/WS write failures are the most likely cause.
        console.warn("[store] listener threw:", (err as Error).message);
      }
    }
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

  private get testDocsDir(): string {
    return join(this.projectRoot, ".pinta", "test-docs");
  }

  /**
   * Test Pilot "doc-parse" queries carry the full markdown doc in the
   * query annotation's comment as JSON `{op, docId, filename, content}`.
   * Write the content out to `.pinta/test-docs/{docId}.md` so the agent
   * can read it from disk via the standard Read tool, and strip the
   * inline content from the annotation before persisting. Mutates the
   * session in place. No-op for sessions that aren't doc-parse queries.
   */
  private async extractTestDocContent(session: Session): Promise<void> {
    if (!session.modules?.some((m) => m.id === "test-pilot")) return;
    for (const ann of session.annotations) {
      if (ann.kind !== "query" || !ann.comment) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ann.comment);
      } catch {
        continue;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as { op?: unknown }).op !== "doc-parse"
      ) {
        continue;
      }
      const p = parsed as {
        op: "doc-parse";
        docId: string;
        filename: string;
        content?: string;
      };
      if (typeof p.content !== "string") continue;
      await mkdir(this.testDocsDir, { recursive: true });
      const ext = p.filename.toLowerCase().endsWith(".md") ? "md" : "md";
      const filePath = join(this.testDocsDir, `${p.docId}.${ext}`);
      await writeFile(filePath, p.content, "utf8");
      // Sweep prior imports — only one catalog is active at a time, and
      // older docs would otherwise linger on disk indefinitely. Specs
      // can contain real credentials / internal URLs; bounded retention
      // limits the blast radius if the project root is shared or backed up.
      await this.purgeStaleTestDocs(p.docId);
      // Strip the inline content from the annotation so the persisted
      // session JSON stays small. The agent reads the file via docId.
      ann.comment = JSON.stringify({
        op: p.op,
        docId: p.docId,
        filename: p.filename,
      });
    }
  }

  /**
   * Replace the contents of `.pinta/test-docs/{docId}.md` with `content`
   * verbatim. Called from `PUT /v1/test-docs/:docId` whenever the side
   * panel edits the catalog (add / delete / rename / reorder) — the
   * on-disk file is the source of truth so the agent's `?` (detail-
   * steps) flow works against newly-added rows and edits survive
   * regen.
   *
   * Idempotent: re-creates the directory if it was wiped by Clear
   * Catalog between sessions. UTF-8 to match `extractTestDocContent`'s
   * original write.
   */
  async writeTestDoc(docId: string, content: string): Promise<void> {
    await mkdir(this.testDocsDir, { recursive: true });
    const filePath = join(this.testDocsDir, `${docId}.md`);
    await writeFile(filePath, content, "utf8");
  }

  /**
   * Remove every file in `.pinta/test-docs/` that doesn't belong to
   * `keepDocId`. Tolerates a missing directory.
   */
  private async purgeStaleTestDocs(keepDocId: string): Promise<void> {
    try {
      const entries = await readdir(this.testDocsDir);
      for (const name of entries) {
        if (name.startsWith(`${keepDocId}.`)) continue;
        try {
          await unlink(join(this.testDocsDir, name));
        } catch {
          // best-effort — locked file, race with cleanup, etc.
        }
      }
    } catch {
      // dir doesn't exist yet — nothing to clean.
    }
  }

  /**
   * Wipe every persisted session + screenshot from `.pinta/sessions/`
   * and drop them from the in-memory map. The currently-active drafting
   * session is preserved so a user mid-edit doesn't lose their work.
   * Called by DELETE /v1/sessions when the user clears their history.
   */
  async purgeAllSessions(): Promise<void> {
    const keepId =
      this.activeId && this.sessions.get(this.activeId)?.status === "drafting"
        ? this.activeId
        : null;
    for (const id of [...this.sessions.keys()]) {
      if (id === keepId) continue;
      this.sessions.delete(id);
    }
    if (!keepId) this.activeId = null;
    try {
      const files = await readdir(this.sessionsDir);
      for (const f of files) {
        const isKeptJson = keepId && f === `${keepId}.json`;
        const isKeptPng = keepId && f === `${keepId}.png`;
        if (isKeptJson || isKeptPng) continue;
        try {
          await unlink(join(this.sessionsDir, f));
        } catch {
          // best-effort
        }
      }
    } catch {
      // dir may not exist yet
    }
  }

  /** Wipe the entire test-docs directory. Called by the companion's
   *  DELETE /v1/test-docs endpoint when the user clears their catalog. */
  async purgeAllTestDocs(): Promise<void> {
    try {
      await rm(this.testDocsDir, { recursive: true, force: true });
    } catch {
      // already gone / permission issue — caller treats as success.
    }
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
    /**
     * When true, force a brand-new session even if the user already
     * has a drafting session in flight, and do NOT take over `activeId`.
     * Used by interactive modules (e.g. Test Pilot) that run query
     * sessions alongside the user's annotation draft.
     */
    ephemeral?: boolean;
    /**
     * When true, drop any existing drafting session before creating a
     * new one. Set by the side panel's "Clear" action — without this,
     * the drafting-idempotency below would echo back the existing
     * session and its annotations would silently resurrect.
     */
    force?: boolean;
  }): Session {
    // Idempotent on the drafting session. The side panel sends
    // session.create whenever it reconnects (e.g. user navigated tabs and
    // we re-routed back to this companion). Without this guard, a fresh
    // session would replace the user's in-progress draft and the
    // annotations they'd already added would silently disappear from view.
    if (!input.ephemeral && !input.force) {
      const existing = this.getActive();
      if (existing && existing.status === "drafting") {
        // Update the URL in case the user is now on a different page in
        // the same project — annotations still carry their per-target URL.
        if (input.url) existing.url = input.url;
        return existing;
      }
    }
    if (input.force) {
      // User explicitly asked to discard the active draft (Clear button).
      // Delete it outright instead of leaving an empty `drafting` row in
      // session history.
      const existing = this.getActive();
      if (existing && existing.status === "drafting") {
        this.sessions.delete(existing.id);
        if (this.activeId === existing.id) this.activeId = null;
      }
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
    // Ephemeral sessions don't become "active" — the user's annotation
    // draft (if any) stays the active session. The extension routes
    // status events by session.id so this still works end-to-end.
    if (!input.ephemeral) {
      this.activeId = session.id;
    }
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
    modules?: Session["modules"],
  ): Promise<Session> {
    const session = this.requireSession(sessionId);
    session.status = "submitted";
    session.submittedAt = Date.now();
    if (screenshot) session.fullPageScreenshot = screenshot;
    if (autoApply !== undefined) session.autoApply = autoApply;
    // Persist the per-submit module opt-in so the agent (which only
    // sees the JSON on disk) can act on it. Empty array is treated as
    // "no modules" — same as undefined — so we never write [] either.
    if (modules && modules.length > 0) session.modules = modules;
    else delete session.modules;
    await this.extractScreenshot(session);
    await this.extractTestDocContent(session);
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
    // Status updates count as heartbeat — refreshes the claim TTL so a
    // long-running apply doesn't get stolen out from under the agent.
    if (session.claimedBy) session.claimedAt = Date.now();
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
    // Per-annotation status updates also count as claim heartbeat.
    if (session.claimedBy) session.claimedAt = Date.now();
    await this.persist(session);
    this.notifyChange(session);
    return session;
  }

  /**
   * First-claim-wins. If the session has no claimer yet (or the prior
   * claim has gone stale past `CLAIM_TTL_MS` without any heartbeat),
   * mark it claimed by `claimerId` and return `{ ok: true, session }`.
   * If actively claimed by someone else, return `{ ok: false, claimedBy }`.
   * Idempotent for the same claimerId — re-claiming returns ok with the
   * existing claim. The TTL heartbeat is wired through `setStatus` /
   * `setAnnotationStatus`, not through re-claim, so an agent that's
   * actively reporting progress stays alive without explicit re-claims.
   */
  async tryClaim(
    sessionId: string,
    claimerId: string,
  ): Promise<
    | { ok: true; session: Session }
    | { ok: false; claimedBy: string; claimedAt: number }
  > {
    const session = this.requireSession(sessionId);
    const now = Date.now();
    const claimAge = now - (session.claimedAt ?? 0);
    const stale = !!session.claimedBy && claimAge > CLAIM_TTL_MS;

    if (session.claimedBy && session.claimedBy !== claimerId && !stale) {
      return {
        ok: false,
        claimedBy: session.claimedBy,
        claimedAt: session.claimedAt ?? 0,
      };
    }
    // Take or refresh the claim. Both first-claim and stale-takeover
    // paths land here; same-claimer re-claims also refresh claimedAt.
    if (!session.claimedBy || session.claimedBy !== claimerId || stale) {
      session.claimedBy = claimerId;
      session.claimedAt = now;
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
