import { describe, it, expect } from "vitest";
import { classifySyncedSession } from "./session-routing.js";

describe("classifySyncedSession", () => {
  it("routes a session already in the tray to an in-place update", () => {
    expect(
      classifySyncedSession({ id: "b1", status: "applying" }, { inTray: true }),
    ).toBe("tray-update");
    // Even a drafting id that's somehow tracked updates the tray, never the draft.
    expect(
      classifySyncedSession({ id: "b1", status: "submitted" }, { inTray: true }),
    ).toBe("tray-update");
  });

  it("adopts only a drafting broadcast as the active draft", () => {
    expect(
      classifySyncedSession({ id: "d1", status: "drafting" }, { inTray: false }),
    ).toBe("adopt-draft");
  });

  it("routes an untracked submitted/applying batch to the tray, never the draft", () => {
    // Regression: a submitted session must NOT become this.session (that froze
    // annotating — the footer stuck on "Submitted — waiting for agent").
    expect(
      classifySyncedSession({ id: "b9", status: "submitted" }, { inTray: false }),
    ).toBe("tray-add");
    expect(
      classifySyncedSession({ id: "b9", status: "applying" }, { inTray: false }),
    ).toBe("tray-add");
  });

  it("drops a stale terminal (done/error) echo for an untracked batch", () => {
    expect(
      classifySyncedSession({ id: "old", status: "done" }, { inTray: false }),
    ).toBe("drop");
    expect(
      classifySyncedSession({ id: "old", status: "error" }, { inTray: false }),
    ).toBe("drop");
  });

  it("never returns adopt-draft for any non-drafting status", () => {
    for (const status of ["submitted", "applying", "done", "error"] as const) {
      expect(
        classifySyncedSession({ id: "x", status }, { inTray: false }),
      ).not.toBe("adopt-draft");
    }
  });
});
