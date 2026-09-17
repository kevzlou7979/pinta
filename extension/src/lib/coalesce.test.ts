import { describe, expect, it } from "vitest";
import { createCoalescer } from "./coalesce.js";

type Req = { url: string; force: boolean };
const stickyForce = (q: Req | null, next: Req): Req => ({
  url: next.url,
  force: next.force || (q?.force ?? false),
});

function harness(failFirst = false) {
  const runs: Req[] = [];
  const resolvers: Array<(err?: Error) => void> = [];
  const call = createCoalescer<Req>((args) => {
    runs.push(args);
    return new Promise<void>((res, rej) => {
      resolvers.push((err) => (err ? rej(err) : res()));
    });
  }, stickyForce);
  const settle = async (i: number, err?: Error) => {
    resolvers[i]!(err);
    for (let k = 0; k < 10; k++) await Promise.resolve();
  };
  return { runs, call, settle, failFirst };
}

describe("createCoalescer", () => {
  it("a burst during one run yields exactly one trailing run with the latest args", async () => {
    const h = harness();
    const first = h.call({ url: "a", force: false });
    const t1 = h.call({ url: "b", force: false });
    const t2 = h.call({ url: "c", force: false });
    expect(t1).toBe(t2);
    expect(h.runs).toHaveLength(1);
    await h.settle(0);
    await first;
    expect(h.runs).toEqual([{ url: "a", force: false }, { url: "c", force: false }]);
    await h.settle(1);
    await t2;
    expect(h.runs).toHaveLength(2);
  });

  it("force is sticky across the queued burst", async () => {
    const h = harness();
    void h.call({ url: "a", force: false });
    void h.call({ url: "b", force: true });
    const t = h.call({ url: "c", force: false });
    await h.settle(0);
    expect(h.runs[1]).toEqual({ url: "c", force: true });
    await h.settle(1);
    await t;
  });

  it("a failing run rejects its caller but doesn't wedge the queue", async () => {
    const h = harness();
    const first = h.call({ url: "a", force: false });
    const firstResult = first.catch((e: Error) => e.message);
    const t = h.call({ url: "b", force: false });
    await h.settle(0, new Error("scan failed"));
    expect(await firstResult).toBe("scan failed");
    expect(h.runs).toHaveLength(2);
    await h.settle(1);
    await t;
    // Idle again: the next call starts immediately.
    const next = h.call({ url: "d", force: false });
    expect(h.runs).toHaveLength(3);
    await h.settle(2);
    await next;
  });

  it("a synchronously throwing run still clears the in-flight slot", async () => {
    let n = 0;
    const call = createCoalescer<number>(() => {
      n++;
      throw new Error("boom");
    });
    await expect(call(1)).rejects.toThrow("boom");
    await expect(call(2)).rejects.toThrow("boom");
    expect(n).toBe(2);
  });
});
