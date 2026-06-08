import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldBroadcastSession,
  selectReconnectReplaySessions,
} from "./ws.js";
import { SessionStore } from "./store.js";
import type { Session, SessionStatus } from "@pinta/shared";

/** Minimal Session for the replay selector — only the fields it reads. */
function sess(input: {
  id: string;
  status: SessionStatus;
  moduleId?: string;
  submittedAt?: number;
}): Session {
  return {
    id: input.id,
    url: "http://localhost/",
    startedAt: input.submittedAt ?? 0,
    submittedAt: input.submittedAt,
    annotations: [],
    status: input.status,
    producer: "test",
    modules: input.moduleId ? [{ id: input.moduleId }] : undefined,
  } as Session;
}

/**
 * Guards the store → extension WS broadcast gate. The regression this
 * locks: an IMPORTED interactive module (Phase 19) carries an arbitrary
 * `modules[].id`, and the old hardcoded allow-list (test-pilot / chat /
 * audit-flow) silently dropped its ephemeral `done` — so the module's
 * side-panel tab spun forever even though the agent had posted its result.
 */
function session(
  input: Partial<Session>,
): Pick<Session, "id" | "modules" | "status"> {
  // Default to a `drafting` status — that's the "some other tab's live
  // draft" case the gate must skip. Phase 20 in-flight batches override it
  // with submitted/applying/done/error.
  return { id: "s-1", modules: undefined, status: "drafting", ...input } as Session;
}

describe("shouldBroadcastSession", () => {
  it("broadcasts the active annotation draft even with no modules", () => {
    expect(shouldBroadcastSession(session({ id: "active" }), "active")).toBe(
      true,
    );
  });

  it("skips a non-active, module-less session that is still drafting", () => {
    // Another tab's live draft — not ours to push.
    expect(shouldBroadcastSession(session({ id: "other" }), "active")).toBe(
      false,
    );
  });

  it("broadcasts a non-active, module-less batch once it leaves drafting", () => {
    // Phase 20 — a submitted annotation batch is detached from the active
    // draft, so its applying/done updates must still reach the side-panel
    // tray. Each non-drafting status broadcasts.
    for (const status of ["submitted", "applying", "done", "error"] as const) {
      expect(
        shouldBroadcastSession(session({ id: "batch", status }), "active"),
      ).toBe(true);
    }
  });

  it("broadcasts a built-in interactive-module session when not active", () => {
    expect(
      shouldBroadcastSession(
        session({ id: "tp", modules: [{ id: "test-pilot" }] }),
        "active",
      ),
    ).toBe(true);
  });

  it("broadcasts an IMPORTED interactive-module session (the regression)", () => {
    // The exact case that hung: an imported module id not in the old
    // hardcoded built-in allow-list.
    expect(
      shouldBroadcastSession(
        session({ id: "wf", modules: [{ id: "insclix.workflow-tasks" }] }),
        "active",
      ),
    ).toBe(true);
  });

  it("broadcasts a per-submit module session attached to the active draft", () => {
    expect(
      shouldBroadcastSession(
        session({ id: "active", modules: [{ id: "gitlab-issues" }] }),
        "active",
      ),
    ).toBe(true);
  });

  it("treats an empty modules array as no modules", () => {
    expect(
      shouldBroadcastSession(session({ id: "other", modules: [] }), "active"),
    ).toBe(false);
  });

  it("handles a null activeId (no active session)", () => {
    expect(
      shouldBroadcastSession(
        session({ id: "wf", modules: [{ id: "insclix.workflow-tasks" }] }),
        null,
      ),
    ).toBe(true);
    expect(shouldBroadcastSession(session({ id: "other" }), null)).toBe(false);
  });
});

/**
 * End-to-end of the regression: a submitted annotation batch that the agent
 * later resolves must reach the side panel. Wires the REAL SessionStore
 * through the same gate `attachWebSocket` uses, then replays the exact
 * extension flow (submit detaches the batch, a fresh draft becomes active)
 * and the agent's HTTP status writes. Asserts the gate lets the batch's
 * applying/done updates through so the panel can flip its card to done.
 */
describe("submitted-batch status reaches the panel (Phase 20 regression)", () => {
  it("broadcasts applying/done for a detached annotation batch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pinta-ws-"));
    try {
      const store = new SessionStore(dir);
      // Mimic attachWebSocket's gate-wrapped subscriber: record every
      // session id that would actually be pushed to WS clients.
      const broadcast: string[] = [];
      store.subscribe((s) => {
        if (shouldBroadcastSession(s, store.getActive()?.id ?? null)) {
          broadcast.push(`${s.id}:${s.status}`);
        }
      });

      // 1. User draws an annotation and submits → batch detaches.
      const draft = store.createSession({ url: "http://localhost:5173/" });
      store.addAnnotation(draft.id, {
        id: "ann-1",
        kind: "select",
        comment: "make it dark",
        selector: "#x",
        url: "http://localhost:5173/",
        status: "pending",
      } as never);
      await store.submit(draft.id, undefined, true);

      // 2. Extension mints a fresh draft → active moves off the batch.
      const fresh = store.createSession({ url: "http://localhost:5173/" });
      expect(store.getActive()?.id).toBe(fresh.id);
      expect(fresh.id).not.toBe(draft.id);

      // 3. Agent claims + applies the batch over HTTP.
      broadcast.length = 0;
      await store.setStatus(draft.id, "applying");
      await store.setAnnotationStatus(draft.id, "ann-1", "done");

      // The detached batch's updates must be delivered — both the applying
      // transition and the auto-rolled done. Without the gate fix these
      // were dropped (not active, no modules) and the card spun forever.
      expect(broadcast).toContain(`${draft.id}:applying`);
      expect(broadcast).toContain(`${draft.id}:done`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("selectReconnectReplaySessions", () => {
  const NOW = 1_000_000;
  const WINDOW = 10 * 60 * 1000; // 10 min
  const opts = { activeId: "active", nowMs: NOW, windowMs: WINDOW };

  it("replays a recent terminal module session", () => {
    const out = selectReconnectReplaySessions(
      [sess({ id: "a", status: "done", moduleId: "audit-flow", submittedAt: NOW - 5000 })],
      opts,
    );
    expect(out.map((s) => s.id)).toEqual(["a"]);
  });

  it("recovers a missed IMPORTED module result (the Workflow case)", () => {
    const out = selectReconnectReplaySessions(
      [sess({ id: "wf", status: "done", moduleId: "insclix.workflow-tasks", submittedAt: NOW - 30_000 })],
      opts,
    );
    expect(out.map((s) => s.id)).toEqual(["wf"]);
  });

  it("skips the active annotation draft", () => {
    const out = selectReconnectReplaySessions(
      [sess({ id: "active", status: "done", moduleId: "audit-flow", submittedAt: NOW })],
      opts,
    );
    expect(out).toEqual([]);
  });

  it("skips sessions with no module (plain annotation sessions)", () => {
    const out = selectReconnectReplaySessions(
      [sess({ id: "ann", status: "done", submittedAt: NOW })],
      opts,
    );
    expect(out).toEqual([]);
  });

  it("skips non-terminal sessions (drafting / submitted / applying)", () => {
    const out = selectReconnectReplaySessions(
      [
        sess({ id: "d", status: "drafting", moduleId: "audit-flow", submittedAt: NOW }),
        sess({ id: "s", status: "submitted", moduleId: "audit-flow", submittedAt: NOW }),
        sess({ id: "ap", status: "applying", moduleId: "audit-flow", submittedAt: NOW }),
      ],
      opts,
    );
    expect(out).toEqual([]);
  });

  it("skips results older than the window", () => {
    const out = selectReconnectReplaySessions(
      [sess({ id: "old", status: "done", moduleId: "audit-flow", submittedAt: NOW - WINDOW - 1 })],
      opts,
    );
    expect(out).toEqual([]);
  });

  it("includes error results (so a failed run also clears the spinner)", () => {
    const out = selectReconnectReplaySessions(
      [sess({ id: "e", status: "error", moduleId: "audit-flow", submittedAt: NOW - 1000 })],
      opts,
    );
    expect(out.map((s) => s.id)).toEqual(["e"]);
  });

  it("dedupes to the LATEST terminal session per module id", () => {
    const out = selectReconnectReplaySessions(
      [
        sess({ id: "old", status: "done", moduleId: "audit-flow", submittedAt: NOW - 60_000 }),
        sess({ id: "new", status: "done", moduleId: "audit-flow", submittedAt: NOW - 5_000 }),
      ],
      opts,
    );
    expect(out.map((s) => s.id)).toEqual(["new"]);
  });

  it("keeps the latest per module across DIFFERENT modules", () => {
    const out = selectReconnectReplaySessions(
      [
        sess({ id: "audit", status: "done", moduleId: "audit-flow", submittedAt: NOW - 4000 }),
        sess({ id: "wf", status: "done", moduleId: "insclix.workflow-tasks", submittedAt: NOW - 3000 }),
      ],
      opts,
    );
    expect(out.map((s) => s.id).sort()).toEqual(["audit", "wf"]);
  });
});
