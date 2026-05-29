import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./store.js";

/**
 * Phase 18b — claim-time role enforcement. The skill sends the
 * terminal's role on every claim; the companion rejects mismatches
 * with `reason: "role-mismatch"` so an off-script agent can't
 * "rescue" work outside its lane. Generalists (no role) preserve
 * the original first-claim-wins behavior.
 */
describe("SessionStore.tryClaim — Phase 18b role enforcement", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinta-store-"));
    store = new SessionStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function submittedTestPilotSession() {
    const draft = store.createSession({ url: "http://localhost:5173/" });
    return await store.submit(draft.id, undefined, true, [
      { id: "test-pilot", settings: {} },
    ]);
  }

  it("rejects a chat-role claim on a test-pilot session", async () => {
    const session = await submittedTestPilotSession();
    const result = await store.tryClaim(session.id, "chat-claimer-1", "chat");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("role-mismatch");
    if (result.reason !== "role-mismatch") return;
    expect(result.expectedRole).toBe("test-pilot");
    // Session must NOT be claimed by the rejected claimer.
    expect(session.claimedBy).toBeUndefined();
  });

  it("accepts a matching role claim", async () => {
    const session = await submittedTestPilotSession();
    const result = await store.tryClaim(
      session.id,
      "tp-claimer-1",
      "test-pilot",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.claimedBy).toBe("tp-claimer-1");
  });

  it("accepts a generalist (no role) claim — preserves first-wins", async () => {
    const session = await submittedTestPilotSession();
    const result = await store.tryClaim(session.id, "generalist-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.claimedBy).toBe("generalist-1");
  });

  it("returns role-mismatch BEFORE checking already-claimed", async () => {
    // Ensures the cross-role agent can't probe the claim state by
    // distinguishing 403 from 409 — both look the same from outside
    // its lane.
    const session = await submittedTestPilotSession();
    await store.tryClaim(session.id, "tp-incumbent", "test-pilot");
    const intruder = await store.tryClaim(
      session.id,
      "chat-intruder",
      "chat",
    );
    expect(intruder.ok).toBe(false);
    if (intruder.ok) return;
    expect(intruder.reason).toBe("role-mismatch");
  });

  it("treats an annotate session as role=annotate (no modules)", async () => {
    const draft = store.createSession({ url: "http://localhost:5173/" });
    const session = await store.submit(draft.id, undefined, true);
    const ok = await store.tryClaim(session.id, "ann-1", "annotate");
    expect(ok.ok).toBe(true);
    const wrong = await store.tryClaim(session.id, "tp-1", "test-pilot");
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.reason).toBe("role-mismatch");
    if (wrong.reason !== "role-mismatch") return;
    expect(wrong.expectedRole).toBe("annotate");
  });
});
