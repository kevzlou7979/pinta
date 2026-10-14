// Phase 25 — the in-page motion rehearsal runner.
//
// Turns a MotionPlan (plain JSON from the side panel) into live
// animations on the user's real element, and hands back a handle the
// panel drives: play, reverse, seek, rate, stop. Nothing here writes to
// source — stop() restores the element exactly as it was found, the same
// contract the Design Variants preview keeps.
//
// The maths lives in lib/motion.ts; this file is the DOM half.

import { formatNumeric, parseNumeric, type MotionPlan, type NumericText } from "../lib/motion.js";

export type MotionHandle = {
  /** Timeline length in ms — what the scrub bar maps onto. */
  total: number;
  /** Play forward from `from` ms (default 0 — a fresh run). */
  play(rate: number, from?: number): void;
  reverse(rate: number): void;
  seek(ms: number): void;
  setRate(rate: number): void;
  /** Cancel everything and restore the element. Safe to call twice. */
  stop(): void;
  currentTime(): number;
  running(): boolean;
  onFinish(cb: () => void): void;
};

const NOOP: MotionHandle = {
  total: 0,
  play() {},
  reverse() {},
  seek() {},
  setRate() {},
  stop() {},
  currentTime: () => 0,
  running: () => false,
  onFinish() {},
};

export function reducedMotionPreferred(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** Direct element children, minus anything Pinta injected. */
export function resolveChildren(root: Element, isOurNode?: (el: Element) => boolean): Element[] {
  return Array.from(root.children).filter(
    (el) => el instanceof HTMLElement && !(isOurNode?.(el) ?? false),
  );
}

/** How many children a stagger would animate. Used to size the plan. */
export function childCountFor(root: Element | null, isOurNode?: (el: Element) => boolean): number {
  if (!root) return 0;
  return resolveChildren(root, isOurNode).length;
}

/**
 * Build the live animations. `root` is the picked element; child-scoped
 * plans animate its children instead.
 */
export function runPlan(
  plan: MotionPlan,
  root: Element,
  opts: { isOurNode?: (el: Element) => boolean } = {},
): MotionHandle {
  if (!root.isConnected) return NOOP;
  return plan.kind === "countup"
    ? runCountUp(plan, root)
    : runKeyframes(plan, root, opts.isOurNode);
}

// ---------------------------------------------------------------------------
// WAAPI patterns

function runKeyframes(
  plan: MotionPlan,
  root: Element,
  isOurNode?: (el: Element) => boolean,
): MotionHandle {
  const anims: Animation[] = [];
  const step = plan.stagger?.step ?? 0;

  for (const s of plan.steps) {
    const nodes =
      s.node === "child" ? resolveChildren(root, isOurNode) : [root as HTMLElement];
    nodes.forEach((node, i) => {
      if (!(node instanceof HTMLElement)) return;
      const delay = s.delay + (s.node === "child" ? i * step : 0);
      try {
        const anim = node.animate(s.keyframes as unknown as PropertyIndexedKeyframes, {
          duration: Math.max(1, s.duration),
          delay,
          easing: s.easing,
          fill: "both",
        });
        anim.pause();
        anim.currentTime = 0;
        anims.push(anim);
      } catch {
        // A node that refuses to animate (display:contents, detached) is
        // skipped rather than failing the whole rehearsal.
      }
    });
  }

  if (!anims.length) return NOOP;

  let finishCb: (() => void) | null = null;
  let stopped = false;
  // Every play/reverse arms afresh; only the newest arming may fire, so
  // a second click mid-run doesn't double "finished" (and double a loop).
  let generation = 0;

  // The longest animation owns "finished" for the whole plan.
  const lead = anims.reduce((a, b) => (timelineEnd(a) >= timelineEnd(b) ? a : b));
  const total = Math.max(1, Math.round(timelineEnd(lead)));

  function armFinish(): void {
    const mine = ++generation;
    lead.finished
      .then(() => {
        if (!stopped && mine === generation) finishCb?.();
      })
      .catch(() => {});
  }

  return {
    total,
    play(rate, from = 0) {
      if (stopped) return;
      const start = Math.min(total, Math.max(0, from));
      anims.forEach((a) => {
        a.currentTime = Math.min(timelineEnd(a), start);
        a.playbackRate = Math.abs(rate) || 1;
        a.play();
      });
      armFinish();
    },
    reverse(rate) {
      if (stopped) return;
      anims.forEach((a) => {
        a.currentTime = timelineEnd(a);
        a.playbackRate = -(Math.abs(rate) || 1);
        a.play();
      });
      armFinish();
    },
    seek(ms) {
      if (stopped) return;
      const t = Math.min(total, Math.max(0, ms));
      anims.forEach((a) => {
        a.pause();
        // currentTime includes the animation's own delay, so a staggered
        // child reads the same clock as the scrub bar.
        a.currentTime = Math.min(timelineEnd(a), t);
      });
    },
    setRate(rate) {
      if (stopped) return;
      anims.forEach((a) => {
        if (a.playState === "running") {
          a.playbackRate = (a.playbackRate < 0 ? -1 : 1) * (Math.abs(rate) || 1);
        }
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      finishCb = null;
      anims.forEach((a) => {
        try {
          a.cancel();
        } catch {
          /* already gone */
        }
      });
    },
    currentTime: () => {
      // The lead's clock runs to `total`; a child with delay 0 stops short.
      const t = lead.currentTime;
      return typeof t === "number" ? t : 0;
    },
    running: () => !stopped && anims.some((a) => a.playState === "running"),
    onFinish(cb) {
      finishCb = cb;
    },
  };
}

function timelineEnd(a: Animation): number {
  const timing = a.effect?.getComputedTiming();
  const delay = typeof timing?.delay === "number" ? timing.delay : 0;
  const dur = typeof timing?.duration === "number" ? timing.duration : 0;
  return delay + dur;
}

// ---------------------------------------------------------------------------
// Count up
//
// Text interpolation, not style. The element's format is read once and
// re-applied every frame, so £128,460 counts through £71,204. While the
// rehearsal runs the node is aria-hidden, because counting a figure out
// loud through a live region is a genuinely hostile thing to ship — the
// applied code gets the same rule via the payload.

function runCountUp(plan: MotionPlan, root: Element): MotionHandle {
  const node = root as HTMLElement;
  // textContent writes flatten child markup (<span>£</span><strong>…) and
  // the restore would too — only a node that holds just the text counts.
  if (node.children.length > 0) return NOOP;
  const originalText = node.textContent ?? "";
  const meta: NumericText | null = parseNumeric(originalText);
  if (!meta) return NOOP;

  const duration = Math.max(1, plan.count?.duration ?? plan.total ?? 1);
  const hadAriaHidden = node.getAttribute("aria-hidden");
  let raf: number | null = null;
  let finishCb: (() => void) | null = null;
  let stopped = false;
  let t = 0;
  let rate = 1;
  /** The last string we wrote — stop() only restores over our own text. */
  let written: string | null = null;

  function render(progress: number): void {
    if (!node.isConnected) return;
    const p = Math.min(1, Math.max(0, progress));
    // Decelerate — the eye is reading digits, so ease out hard.
    const eased = 1 - Math.pow(1 - p, 3);
    written = formatNumeric(meta!.value * eased, meta!);
    node.textContent = written;
  }

  function markHidden(on: boolean): void {
    if (on) node.setAttribute("aria-hidden", "true");
    else if (hadAriaHidden == null) node.removeAttribute("aria-hidden");
    else node.setAttribute("aria-hidden", hadAriaHidden);
  }

  function tick(last: number | null): void {
    raf = requestAnimationFrame((now) => {
      if (stopped) return;
      // The first frame only reads the clock: Chromium's first rAF
      // timestamp can precede a performance.now() taken in start(), and a
      // non-positive delta must not count as "arrived".
      if (last == null) {
        tick(now);
        return;
      }
      t += (now - last) * rate;
      // Direction-aware: forward is done at the end, reverse at zero —
      // never the other way round, or a run ends on its first frame.
      if (rate > 0 ? t >= duration : t <= 0) {
        t = Math.min(duration, Math.max(0, t));
        raf = null;
        render(t / duration);
        markHidden(false);
        finishCb?.();
        return;
      }
      render(t / duration);
      tick(now);
    });
  }

  function start(from: number, r: number): void {
    if (stopped) return;
    cancel();
    t = from;
    rate = r;
    markHidden(true);
    render(t / duration);
    tick(null);
  }

  function cancel(): void {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
  }

  // Resting state is the real figure, never a zero the page never had.
  render(1);
  t = duration;

  return {
    total: duration,
    play(r, from = 0) {
      start(Math.min(duration, Math.max(0, from)), Math.abs(r) || 1);
    },
    reverse(r) {
      start(duration, -(Math.abs(r) || 1));
    },
    seek(ms) {
      if (stopped) return;
      cancel();
      markHidden(false);
      t = Math.min(duration, Math.max(0, ms));
      render(t / duration);
    },
    setRate(r) {
      rate = (rate < 0 ? -1 : 1) * (Math.abs(r) || 1);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      finishCb = null;
      cancel();
      markHidden(false);
      // A live page update since our last write wins — never clobber it.
      if (written != null && node.textContent === written) node.textContent = originalText;
    },
    currentTime: () => t,
    running: () => !stopped && raf != null,
    onFinish(cb) {
      finishCb = cb;
    },
  };
}
