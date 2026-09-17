/**
 * Coalesce bursts of an async job: while one run is in flight, later calls
 * don't start overlapping runs — only the latest request is remembered
 * (`merge` folds it into any already-queued one, e.g. a sticky `force`)
 * and it runs once after the current run settles. Every call made during
 * a run shares the one trailing promise. A failing run rejects only its
 * own callers; the queued trailing run still happens.
 */
export function createCoalescer<A>(
  run: (args: A) => Promise<void>,
  merge: (queued: A | null, next: A) => A = (_q, next) => next,
): (args: A) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queued: { args: A } | null = null;
  let trailing: Promise<void> | null = null;

  const call = (args: A): Promise<void> => {
    if (inFlight) {
      queued = { args: merge(queued?.args ?? null, args) };
      if (!trailing) {
        trailing = inFlight.catch(() => {}).then(() => {
          const q = queued;
          queued = null;
          trailing = null;
          return q ? call(q.args) : undefined;
        });
      }
      return trailing;
    }
    let started: Promise<void>;
    try {
      started = run(args);
    } catch (err) {
      started = Promise.reject(err);
    }
    const own: Promise<void> = started.finally(() => {
      if (inFlight === own) inFlight = null;
    });
    inFlight = own;
    return own;
  };
  return call;
}
