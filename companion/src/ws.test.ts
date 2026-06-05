import { describe, expect, it } from "vitest";
import {
  shouldBroadcastSession,
  selectReconnectReplaySessions,
} from "./ws.js";
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
function session(input: Partial<Session>): Pick<Session, "id" | "modules"> {
  return { id: "s-1", modules: undefined, ...input } as Session;
}

describe("shouldBroadcastSession", () => {
  it("broadcasts the active annotation draft even with no modules", () => {
    expect(shouldBroadcastSession(session({ id: "active" }), "active")).toBe(
      true,
    );
  });

  it("skips a non-active session that carries no modules", () => {
    // Another tab's draft / an old completed annotation session.
    expect(shouldBroadcastSession(session({ id: "other" }), "active")).toBe(
      false,
    );
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
