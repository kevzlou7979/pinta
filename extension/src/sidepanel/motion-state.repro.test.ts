// QA-B F9 (2026-10-14): the Motion state contract had no unit coverage —
// hover-to-try (previewMotionPattern / endMotionPreview), the seq guard
// after a stop, an arm superseded before its first await, pick → auto-play
// of the first REHEARSABLE suggestion (never a two-target), plus the two
// MotionTab fixes F10 (keep() mid end-pick cancels it) and F20 (✕ on the
// chip re-arms pick mode). Every message the panel sends to "the tab" is
// recorded by the chrome.tabs.sendMessage stub; page replies are fed
// straight into the app's onMotion* handlers.
//   npx vitest run --config vitest.repro.config.ts src/sidepanel/motion-state.repro.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TAB = 7;
/** Everything chrome.tabs.sendMessage was asked to deliver, in order. */
const sent: Array<{ tabId: number; msg: any }> = [];

const ev = () => ({ addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) });
(globalThis as any).chrome = {
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: ev(),
  },
  runtime: {
    onMessage: ev(),
    sendMessage: vi.fn(async () => ({})),
    getManifest: () => ({ version: "0.10.0" }),
    getURL: (p: string) => p,
    id: "t",
  },
  tabs: {
    onActivated: ev(),
    onUpdated: ev(),
    onRemoved: ev(),
    query: vi.fn(async () => [{ id: TAB, url: "http://localhost:5173/", active: true, windowId: 1 }]),
    sendMessage: vi.fn(async (tabId: number, msg: any) => {
      sent.push({ tabId, msg });
      return {};
    }),
  },
  windows: { onFocusChanged: ev(), WINDOW_ID_NONE: -1 },
  notifications: { create: vi.fn(), onClicked: ev(), onClosed: ev(), clear: vi.fn() },
  action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  permissions: { contains: vi.fn(async () => false) },
  commands: { onCommand: ev() },
};
globalThis.fetch = vi.fn(async () => {
  throw new Error("offline");
}) as any;

const target = (selector: string, outerHTML: string, over: Record<string, unknown> = {}) => ({
  selector,
  outerHTML,
  computedStyles: {},
  nearbyText: [],
  boundingRect: { x: 0, y: 0, width: 120, height: 40 },
  ...over,
});
const KPI = target("div.kpi", '<div class="kpi">£128,460</div>');
// Container transform ranks first for a card link — and cannot rehearse.
const CARD = target("a.claim-card", '<a class="claim-card" href="/claims/1"><h3>Claim 1</h3><p>Open</p></a>');
const DEST = target("section.detail", '<section class="detail"><h2>Detail</h2></section>');

/** Let every pending microtask / 0ms timer in the state's send paths run. */
const flush = () => new Promise((r) => setTimeout(r, 15));
const types = (from = 0) => sent.slice(from).map((s) => s.msg.type);
const rehearses = (from = 0) => sent.slice(from).filter((s) => s.msg.type === "motion.rehearse").map((s) => s.msg.patternId);
const ready = (app: any, total: number, seq = app.motion.seq) =>
  app.onMotionReady({ seq, total, childCount: 0, stagger: null, reduced: false });

describe("Motion state — hover to try, seq guard, pick auto-play", () => {
  let app: any;
  beforeEach(async () => {
    ({ app } = await import("../lib/state.svelte.js"));
    sent.length = 0;
    app.motion.error = null;
    app.motion.picking = null;
    app.motion.destTarget = null;
    app.motion.pickedTarget = KPI;
    app.selectMotionPattern("count-up");
    await flush();
    sent.length = 0;
  });

  it("previewMotionPattern plays the hovered row with its own tokens and leaves the kept patternId alone", async () => {
    app.motion.durationToken = "morph";
    await app.previewMotionPattern("rise-in");
    expect(app.motion.previewingId).toBe("rise-in");
    expect(app.motion.patternId).toBe("count-up");
    expect(app.motion.durationToken).toBe("morph");
    const reh = sent.filter((s) => s.msg.type === "motion.rehearse");
    expect(reh).toHaveLength(1);
    expect(reh[0].tabId).toBe(TAB);
    expect(reh[0].msg.patternId).toBe("rise-in");
    expect(reh[0].msg.selector).toBe("div.kpi");
    expect(reh[0].msg.overrides).toEqual({});
    expect(app.motion.playing).toBe(true);
  });

  it("a two-target or un-rehearsable id never previews", async () => {
    await app.previewMotionPattern("container-transform");
    expect(app.motion.previewingId).toBeNull();
    expect(types()).toEqual([]);
  });

  it("endMotionPreview stops, then re-arms the KEPT id parked at its end state — never the hovered id (F15)", async () => {
    await app.previewMotionPattern("rise-in");
    ready(app, 300);
    await flush(); // the ready's motion.play goes out before the leave
    expect(app.motion.rehearsing).toBe(true);
    expect(types().at(-1)).toBe("motion.play");
    const from = sent.length;
    await app.endMotionPreview();
    expect(types(from)[0]).toBe("motion.stop");
    expect(rehearses(from)).toEqual(["count-up"]);
    expect(app.motion.previewingId).toBeNull();
    expect(app.motion.playing).toBe(false); // re-armed with autoPlay false
    // The page's ready for that arm → seek to the end, not play.
    const beforeReady = sent.length;
    ready(app, 1100);
    await flush();
    expect(app.motion.rehearsing).toBe(true);
    expect(app.motion.position).toBe(1100);
    expect(app.motion.playing).toBe(false);
    expect(types(beforeReady)).toEqual(["motion.seek"]);
    expect(sent[beforeReady].msg.ms).toBe(1100);
    // One-shot: the next arm's ready plays as usual.
    const beforeClick = sent.length;
    await app.rehearseMotion(true);
    ready(app, 1100);
    await flush();
    expect(types(beforeClick)).toEqual(["motion.rehearse", "motion.play"]);
    expect(app.motion.position).toBe(0);
  });

  it("endMotionPreview with nothing previewing sends nothing", async () => {
    await app.endMotionPreview();
    expect(types()).toEqual([]);
  });

  it("endMotionPreview does not re-arm when the kept pattern cannot rehearse", async () => {
    app.selectMotionPattern("container-transform");
    await flush();
    await app.previewMotionPattern("rise-in");
    const from = sent.length;
    await app.endMotionPreview();
    expect(types(from)).toEqual(["motion.stop"]);
    expect(app.motion.rehearsing).toBe(false);
  });

  it("a failed preview clears previewingId (F3)", async () => {
    await app.previewMotionPattern("rise-in");
    app.onMotionFailed("not-found", app.motion.seq);
    expect(app.motion.previewingId).toBeNull();
    expect(app.motion.rehearsing).toBe(false);
    expect(app.motion.error).toMatch(/isn't on the page/);
    app.motion.error = null;
  });

  it("stopMotionRehearsal retires the live seq; a late ready for it is ignored", async () => {
    await app.rehearseMotion(true);
    const live = app.motion.seq;
    ready(app, 500);
    expect(app.motion.rehearsing).toBe(true);
    await app.stopMotionRehearsal();
    expect(app.motion.seq).toBe(live + 1);
    expect(app.motion.rehearsing).toBe(false);
    expect(types().at(-1)).toBe("motion.stop");
    ready(app, 500, live);
    app.onMotionTick(250, true, live);
    expect(app.motion.rehearsing).toBe(false);
    expect(app.motion.position).toBe(0);
    expect(app.motion.playing).toBe(false);
  });

  it("an arm superseded before its first await never sends", async () => {
    const p = app.previewMotionPattern("rise-in"); // seq taken synchronously
    void app.stopMotionRehearsal(); // bumps seq before the arm resumes
    await p;
    await flush();
    expect(rehearses()).toEqual([]);
    expect(types()).toEqual(["motion.stop"]);
    expect(app.motion.previewingId).toBeNull();
  });

  it("onMotionPicked keeps + auto-plays the first REHEARSABLE suggestion — never a two-target", async () => {
    app.motion.pickedTarget = null;
    app.motion.patternId = null;
    app.motion.picking = "start";
    app.onMotionPicked(CARD);
    await flush();
    expect(app.motion.picking).toBeNull();
    expect(app.motion.pickedTarget.selector).toBe("a.claim-card");
    expect(app.motionRanked.suggested[0].id).toBe("container-transform");
    expect(app.motion.patternId).toBe("rise-in");
    expect(rehearses()).toEqual(["rise-in"]);
    expect(app.motion.playing).toBe(true);
  });

  it("onMotionPicked with a kept two-target pattern does not auto-play it", async () => {
    app.selectMotionPattern("container-transform");
    await flush();
    sent.length = 0;
    app.motion.picking = "start";
    app.onMotionPicked(CARD);
    await flush();
    expect(app.motion.patternId).toBe("container-transform");
    expect(rehearses()).toEqual([]);
    expect(app.motion.rehearsing).toBe(false);
  });

  it("re-picking an element that keeps the same pattern leaves the Tune tokens alone (F4)", async () => {
    app.motion.durationToken = "morph";
    app.motion.easingToken = "linear";
    app.motion.picking = "start";
    app.onMotionPicked(KPI);
    await flush();
    expect(app.motion.patternId).toBe("count-up");
    expect(app.motion.durationToken).toBe("morph");
    expect(app.motion.easingToken).toBe("linear");
    expect(rehearses()).toEqual(["count-up"]);
    app.motion.durationToken = null;
    app.motion.easingToken = null;
  });

  it("an end pick lands as destTarget; choosing a one-target pattern drops it (F10)", async () => {
    app.selectMotionPattern("container-transform");
    app.motion.picking = "end";
    app.onMotionPicked(DEST);
    expect(app.motion.destTarget?.selector).toBe("section.detail");
    expect(app.motion.pickedTarget.selector).toBe("div.kpi");
    app.selectMotionPattern("lateral");
    expect(app.motion.destTarget).toBeNull();
  });

  it("startMotionPick sends the role with motion.pick-element (F16)", async () => {
    await app.startMotionPick("end");
    const pick = sent.filter((s) => s.msg.type === "motion.pick-element");
    expect(pick).toHaveLength(1);
    expect(pick[0].msg.role).toBe("end");
    expect(app.motion.picking).toBe("end");
    await app.cancelMotionPick();
    await flush();
    expect(types().at(-1)).toBe("motion.pick-cancel");
  });
});

describe("MotionTab — keep() mid end-pick (F10) and ✕ on the chip (F20)", () => {
  let app: any;
  let unmount: (() => void) | null = null;
  beforeEach(async () => {
    ({ app } = await import("../lib/state.svelte.js"));
    sent.length = 0;
    app.motion.error = null;
    app.motion.picking = null;
    app.motion.destTarget = null;
    app.motion.pickedTarget = CARD;
    app.motion.showAll = true;
    app.selectMotionPattern("container-transform");
    await flush();
    sent.length = 0;
  });
  afterEach(() => {
    unmount?.();
    unmount = null;
    document.body.innerHTML = "";
  });

  const mountTab = async () => {
    const { mount, unmount: un, flushSync } = await import("svelte");
    const { default: MotionTab } = await import("./MotionTab.svelte");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const inst = mount(MotionTab, { target: host });
    unmount = () => un(inst);
    flushSync();
    await flush();
    return { flushSync };
  };
  const row = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
      (b) => document.getElementById(b.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === name,
    )!;

  it("keeping a one-target row while the end pick is pending cancels the pick first", async () => {
    const { flushSync } = await mountTab();
    // The tab was opened with a target kept, so it did not arm a pick.
    expect(sent.filter((s) => s.msg.type === "motion.pick-element")).toHaveLength(0);
    await app.startMotionPick("end");
    expect(app.motion.picking).toBe("end");
    const from = sent.length;
    row("Lateral").click();
    flushSync();
    await flush();
    expect(app.motion.picking).toBeNull();
    expect(app.motion.patternId).toBe("lateral");
    const t = types(from);
    expect(t).toContain("motion.pick-cancel");
    expect(t.indexOf("motion.pick-cancel")).toBeLessThan(t.indexOf("motion.rehearse"));
    expect(rehearses(from)).toEqual(["lateral"]);
    // A stray page click can no longer land as a destination.
    app.onMotionPicked(DEST);
    expect(app.motion.destTarget).toBeNull();
  });

  it("rows are named by their title alone (F26) and the kept row sits above 'Try another' (F13)", async () => {
    await mountTab();
    const kept = row("Container transform");
    expect(kept.getAttribute("aria-pressed")).toBe("true");
    expect(kept.className).not.toMatch(/bg-brand-pink5/);
    expect(kept.parentElement?.className).toContain("bg-brand-pink/5");
    const heading = [...document.querySelectorAll("p")].find((p) => p.textContent?.trim() === "Try another")!;
    expect(heading).toBeTruthy();
    expect(kept.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const pressed = [...document.querySelectorAll('button[aria-pressed="true"]')];
    expect(pressed).toHaveLength(1);
    // The alternatives never repeat the kept id.
    const names = [...document.querySelectorAll("button[aria-pressed]")].map((b) =>
      document.getElementById(b.getAttribute("aria-labelledby") ?? "")?.textContent?.trim(),
    );
    expect(names.filter((n) => n === "Container transform")).toHaveLength(1);
  });

  it("✕ on the target chip clears it and re-arms the start pick (F20)", async () => {
    const { flushSync } = await mountTab();
    const from = sent.length;
    const clear = document.querySelector<HTMLButtonElement>('button[aria-label="Clear target"]')!;
    expect(clear).toBeTruthy();
    clear.click();
    flushSync();
    await flush();
    expect(app.motion.pickedTarget).toBeNull();
    expect(app.motion.patternId).toBeNull();
    expect(app.motion.picking).toBe("start");
    const pick = sent.slice(from).filter((s) => s.msg.type === "motion.pick-element");
    expect(pick).toHaveLength(1);
    expect(pick[0].msg.role).toBe("start");
    await app.cancelMotionPick();
  });
});
