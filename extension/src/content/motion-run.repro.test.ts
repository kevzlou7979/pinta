// The in-page motion runner in happy-dom: there is no Web Animations API
// here, so Element.animate is stubbed with the smallest Animation-like
// object the runner touches, and requestAnimationFrame is a hand-cranked
// queue so the count-up's clock is under test control.
//   npx vitest run --config vitest.repro.config.ts src/content/motion-run.repro.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPlan, resolveChildren } from "./motion-run.js";
import { DEFAULT_MOTION_SYSTEM, buildPlan, getPattern } from "../lib/motion.js";

type FakeAnim = {
  currentTime: number;
  playbackRate: number;
  playState: "idle" | "paused" | "running" | "finished";
  finished: Promise<unknown>;
  resolveFinished: () => void;
  effect: { getComputedTiming(): { delay: number; duration: number } };
  play(): void;
  pause(): void;
  cancel(): void;
};

const anims: FakeAnim[] = [];

function fakeAnimate(this: Element, _kf: unknown, opts: KeyframeAnimationOptions): FakeAnim {
  let resolveFinished = () => {};
  const a: FakeAnim = {
    currentTime: 0,
    playbackRate: 1,
    playState: "idle",
    finished: new Promise((r) => {
      resolveFinished = () => r(undefined);
    }),
    resolveFinished: () => resolveFinished(),
    effect: {
      getComputedTiming: () => ({
        delay: Number(opts.delay) || 0,
        duration: Number(opts.duration) || 0,
      }),
    },
    play() {
      this.playState = "running";
    },
    pause() {
      this.playState = "paused";
    },
    cancel() {
      this.playState = "idle";
    },
  };
  anims.push(a);
  return a;
}

/** Hand-cranked rAF: `frame(now)` runs every callback queued so far. */
let queue: Array<((now: number) => void) | null> = [];
function frame(now: number): void {
  const cbs = queue;
  queue = [];
  for (const cb of cbs) cb?.(now);
}

const plan = (id: string, ctx = {}) => buildPlan(getPattern(id)!, DEFAULT_MOTION_SYSTEM, ctx);

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  const node = host.firstElementChild as HTMLElement;
  document.body.appendChild(host);
  return node;
}

beforeEach(() => {
  anims.length = 0;
  queue = [];
  (Element.prototype as unknown as { animate: unknown }).animate = fakeAnimate;
  vi.stubGlobal("requestAnimationFrame", (cb: (now: number) => void) => queue.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue[id - 1] = null;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("count up", () => {
  it("refuses an element with child markup and leaves it untouched (F1)", () => {
    const node = el('<p><span class="cur">£</span><strong>128,460</strong></p>');
    const before = node.innerHTML;
    const h = runPlan(plan("count-up"), node);
    expect(h.total).toBe(0);
    h.play(1);
    frame(16);
    h.stop();
    expect(node.innerHTML).toBe(before);
  });

  it("is not running once it has finished, and restores aria-hidden (F2)", () => {
    const node = el("<p>£128,460</p>");
    const h = runPlan(plan("count-up"), node);
    expect(h.total).toBe(1100);
    const done = vi.fn();
    h.onFinish(done);
    h.play(1);
    expect(node.getAttribute("aria-hidden")).toBe("true");
    expect(h.running()).toBe(true);
    frame(1000); // first frame: clock only
    frame(1000 + 1100 + 1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(h.running()).toBe(false);
    expect(node.textContent).toBe("£128,460");
    expect(node.getAttribute("aria-hidden")).toBeNull();
  });

  it("does not finish on a first frame whose timestamp is earlier (F17)", () => {
    const node = el("<p>£128,460</p>");
    const h = runPlan(plan("count-up"), node);
    const done = vi.fn();
    h.onFinish(done);
    h.play(1);
    frame(0); // precedes any clock the runner could have read
    frame(5);
    expect(done).not.toHaveBeenCalled();
    expect(h.running()).toBe(true);
    expect(node.textContent).not.toBe("£128,460");
    // Reverse from the end: an early first frame must not end it at £0 either.
    h.reverse(1);
    frame(0);
    frame(5);
    expect(done).not.toHaveBeenCalled();
    expect(h.running()).toBe(true);
  });

  it("restores a pre-existing aria-hidden value on stop", () => {
    const node = el('<p aria-hidden="false">42 items</p>');
    const h = runPlan(plan("count-up"), node);
    h.play(1);
    expect(node.getAttribute("aria-hidden")).toBe("true");
    h.stop();
    expect(node.getAttribute("aria-hidden")).toBe("false");
    expect(node.textContent).toBe("42 items");
  });

  it("stop() is idempotent and a later play() is a no-op", () => {
    const node = el("<p>£128,460</p>");
    const h = runPlan(plan("count-up"), node);
    h.play(1);
    expect(() => {
      h.stop();
      h.stop();
    }).not.toThrow();
    h.play(1);
    expect(h.running()).toBe(false);
    expect(node.textContent).toBe("£128,460");
  });

  it("leaves a live page update alone on stop (F13)", () => {
    const node = el("<p>£128,460</p>");
    const h = runPlan(plan("count-up"), node);
    h.play(1);
    frame(100);
    frame(200);
    node.textContent = "£999"; // the app re-rendered under us
    h.stop();
    expect(node.textContent).toBe("£999");
  });
});

describe("keyframes", () => {
  it("returns NOOP for a detached root", () => {
    const node = document.createElement("div");
    expect(runPlan(plan("fade"), node).total).toBe(0);
    expect(anims).toHaveLength(0);
  });

  it("resolveChildren skips Pinta's own nodes", () => {
    const node = el('<ul><li>a</li><li data-pinta>b</li><li>c</li></ul>');
    const kids = resolveChildren(node, (e) => e.hasAttribute("data-pinta"));
    expect(kids.map((k) => k.textContent)).toEqual(["a", "c"]);
  });

  it("seek clamps to [0, total]", () => {
    const node = el("<div>box</div>");
    const h = runPlan(plan("fade"), node);
    expect(h.total).toBe(150);
    h.seek(-50);
    expect(h.currentTime()).toBe(0);
    h.seek(9999);
    expect(h.currentTime()).toBe(150);
    expect(anims[0]!.playState).toBe("paused");
  });

  it("setRate keeps the sign when reversed", () => {
    const node = el("<div>box</div>");
    const h = runPlan(plan("fade"), node);
    h.reverse(1);
    h.setRate(2);
    expect(anims[0]!.playbackRate).toBe(-2);
    h.play(1);
    h.setRate(0.25);
    expect(anims[0]!.playbackRate).toBe(0.25);
  });

  it("play(rate, from) resumes mid-way; the lead owns the clock (F7 / F19)", () => {
    const node = el("<ul><li>a</li><li>b</li><li>c</li></ul>");
    const h = runPlan(plan("stagger", { childCount: 3, staggerStep: 60 }), node);
    expect(h.total).toBe(420);
    h.play(1, 400);
    expect(anims[0]!.currentTime).toBe(300); // child 0 ends at 300
    expect(h.currentTime()).toBe(400); // the lead (child 2) reads 400
  });

  it("only the newest play() arming may fire finished (F8)", async () => {
    const node = el("<div>box</div>");
    const h = runPlan(plan("fade"), node);
    const done = vi.fn();
    h.onFinish(done);
    h.play(1);
    h.play(1);
    anims[0]!.resolveFinished();
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
  });
});
