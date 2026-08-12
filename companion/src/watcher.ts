// Task watcher — an OPT-IN background poll that nudges the user when new
// tracker items appear (e.g. issues David just posted on GitLab), without
// spending a single Claude token.
//
// Compliance + cost design (see the `feedback-anthropic-compliance` +
// `feedback-token-economy` memories): the *detection* is a dumb shell
// command the companion runs on an interval — NO agent, NO Claude. When it
// finds new items it broadcasts a `watch.new` over the WS; the extension
// raises a desktop notification + a Tasks-tab badge. The agent only ever
// runs later, interactively, when the user clicks through to build the
// board. That keeps Pinta bring-your-own-Claude and interactive-only.
//
// The watch is driven entirely by a user-authored `.pinta/watch.json`
// (Pinta's import flow never writes this file). If it's absent or
// `enabled` isn't true, the watcher does nothing. The command runs in the
// project root with the user's own env, so it uses the user's existing
// `glab` / `gh` auth — Pinta stores no tracker credentials.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";

export interface WatchConfig {
  /** Master switch — the watcher is inert unless this is exactly `true`. */
  enabled?: boolean;
  /**
   * The interactive module this watch belongs to (e.g.
   * "insclix.workflow-tasks"). The extension only surfaces nudges when
   * this module is installed + enabled — the watch is a MODULE feature,
   * not a core-Pinta one. Required in practice: without it the extension
   * drops the broadcast.
   */
  moduleId?: string;
  /** Short id echoed to the extension, e.g. "tasks". */
  label?: string;
  /** Desktop-notification title, e.g. "New tasks for today". */
  title?: string;
  /** Shell command that prints a JSON array (or `{items:[...]}`). */
  command?: string;
  /** Poll cadence in seconds (floored at 60). */
  intervalSec?: number;
  /** Dot-path to each item's unique id (default "id"). */
  idPath?: string;
  /** Dot-path to each item's human title (default "title"). */
  labelPath?: string;
  /** Cap on how many fresh items to surface per notification. */
  max?: number;
  /**
   * With numeric, monotonically-increasing tracker ids (GitLab/GitHub),
   * only notify for ids ABOVE the highest id ever seen. Kills the
   * "window sliding" false positive: a paginated query (per_page=N)
   * surfaces OLD items when others close — unseen, but not new.
   */
  onlyNewerIds?: boolean;
}

export interface WatchItem {
  id: string;
  title: string;
}

/**
 * One "fresh items detected" occurrence, kept in a small in-memory ring
 * so the extension's service worker can poll `GET /v1/watch/events` and
 * raise a Chrome notification even while the side panel (and its WS) is
 * closed. Ephemeral by design — a companion restart drops the backlog.
 */
export interface WatchEvent {
  at: number;
  moduleId?: string;
  label: string;
  title: string;
  items: WatchItem[];
}

const MIN_INTERVAL_SEC = 60;
const CMD_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4_000_000;
const SEEN_CAP = 500;

/**
 * Pure diff: given the ids fetched this tick and the previously-seen ids,
 * return the fresh ones (never seen before) and the updated seen list
 * (fresh first, capped so it can't grow unbounded). Exposed for tests.
 */
export function diffSeen(
  ids: string[],
  seen: string[],
  cap = SEEN_CAP,
): { fresh: string[]; nextSeen: string[] } {
  const seenSet = new Set(seen);
  const fresh = ids.filter((id) => !seenSet.has(id));
  const nextSeen: string[] = [];
  const pushed = new Set<string>();
  for (const id of [...fresh, ...seen]) {
    if (pushed.has(id)) continue;
    pushed.add(id);
    nextSeen.push(id);
    if (nextSeen.length >= cap) break;
  }
  return { fresh, nextSeen };
}

/**
 * Window-sliding guard (`onlyNewerIds`): with numeric ascending tracker
 * ids, an unseen id LOWER than the historical high-water mark is an old
 * item that slid into the query window (per_page cutoff shifting as other
 * items close/reopen) — seed it, don't announce it. Non-numeric ids fail
 * open (kept). Exposed for tests.
 */
export function filterNewerIds(fresh: string[], seen: string[]): string[] {
  const nums = seen.map(Number).filter(Number.isFinite);
  if (nums.length === 0) return fresh;
  const max = Math.max(...nums);
  return fresh.filter((id) => {
    const n = Number(id);
    return !Number.isFinite(n) || n > max;
  });
}

function pluck(obj: unknown, path: string): string | null {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur == null ? null : String(cur);
}

/** Parse a command's stdout into items using the config's id/label paths. */
export function parseItems(stdout: string, cfg: WatchConfig): WatchItem[] {
  const parsed = JSON.parse(stdout) as unknown;
  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown[] })?.items)
      ? (parsed as { items: unknown[] }).items
      : [];
  const idPath = cfg.idPath ?? "id";
  const labelPath = cfg.labelPath ?? "title";
  const items: WatchItem[] = [];
  for (const it of arr) {
    const id = pluck(it, idPath);
    if (id == null) continue;
    items.push({ id, title: pluck(it, labelPath) ?? id });
  }
  return items;
}

export interface WatcherHandle {
  stop: () => void;
  /** Run one poll cycle immediately (tests / diagnostics). Absent when
   *  the watcher is off. */
  tickNow?: () => Promise<void>;
}

/**
 * Start the watcher for a project. Returns a handle whose `stop()` clears
 * the interval. If `.pinta/watch.json` is missing or disabled at startup,
 * this logs and returns a no-op handle without scheduling anything.
 */
export async function startWatcher(opts: {
  projectRoot: string;
  log?: (m: string) => void;
  onNew: (p: {
    moduleId?: string;
    label: string;
    title: string;
    items: WatchItem[];
  }) => void;
}): Promise<WatcherHandle> {
  const log = opts.log ?? (() => {});
  const cfgPath = join(opts.projectRoot, ".pinta", "watch.json");
  const statePath = join(opts.projectRoot, ".pinta", "watch-state.json");

  const bootCfg = await readConfig(cfgPath);
  if (!bootCfg || bootCfg.enabled !== true || !bootCfg.command) {
    log("task watcher: off (no enabled .pinta/watch.json)");
    return { stop: () => {} };
  }

  const intervalSec = Math.max(MIN_INTERVAL_SEC, bootCfg.intervalSec ?? 600);
  let stopped = false;
  let firstRun = true;
  log(`task watcher: polling every ${intervalSec}s via .pinta/watch.json`);

  async function tick(): Promise<void> {
    if (stopped) return;
    // Re-read each tick so toggling enabled / editing the command takes
    // effect without a companion restart.
    const cfg = await readConfig(cfgPath);
    if (!cfg || cfg.enabled !== true || !cfg.command) return;

    const stdout = await runCommand(cfg.command, opts.projectRoot, log);
    if (stdout == null) return;

    let items: WatchItem[];
    try {
      items = parseItems(stdout, cfg);
    } catch (err) {
      log(`task watcher: parse failed — ${(err as Error).message}`);
      return;
    }

    const seen = await readSeen(statePath);
    const { fresh, nextSeen } = diffSeen(
      items.map((i) => i.id),
      seen,
    );
    await writeSeen(statePath, nextSeen);

    // First tick after boot only seeds `seen` — never notify for the
    // backlog that already existed when the companion started.
    if (firstRun) {
      firstRun = false;
      return;
    }
    if (fresh.length === 0) return;

    // All fresh ids are seeded above; the window-sliding guard only
    // narrows which ones get ANNOUNCED.
    const notifyIds = cfg.onlyNewerIds ? filterNewerIds(fresh, seen) : fresh;
    if (notifyIds.length === 0) return;

    const freshSet = new Set(notifyIds);
    const freshItems = items
      .filter((i) => freshSet.has(i.id))
      .slice(0, cfg.max ?? 20);
    log(`task watcher: ${freshItems.length} new item(s)`);
    opts.onNew({
      moduleId: cfg.moduleId,
      label: cfg.label ?? "tasks",
      title: cfg.title ?? "New items",
      items: freshItems,
    });
  }

  await tick();
  const timer = setInterval(() => void tick(), intervalSec * 1000);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tickNow: tick,
  };
}

async function readConfig(path: string): Promise<WatchConfig | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as WatchConfig;
  } catch {
    return null;
  }
}

async function readSeen(path: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      seen?: string[];
    };
    return Array.isArray(parsed.seen) ? parsed.seen : [];
  } catch {
    return [];
  }
}

async function writeSeen(path: string, seen: string[]): Promise<void> {
  try {
    await writeFile(path, JSON.stringify({ seen }), "utf8");
  } catch {
    // best-effort — a failed write just means we may re-notify once
  }
}

function runCommand(
  command: string,
  cwd: string,
  log: (m: string) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: CMD_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (err, stdout) => {
        if (err) {
          log(`task watcher: command failed — ${err.message}`);
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
