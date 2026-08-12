// Task-watcher notification plumbing shared by the SERVICE WORKER (alarm
// poll of `GET /v1/watch/events` — fires Chrome notifications while the
// side panel is closed) and the SIDE PANEL (instant WS path while open).
//
// Both paths converge on the same chrome.storage.local keys so a nudge is
// toasted exactly once no matter which side sees it first, and the badge
// state survives the panel closing:
//   - `pinta-watch-ports`    recent companion ports for the SW to poll
//   - `pinta-watch-toasted`  item ids already toasted (permanent, capped)
//   - `pinta-watch-pending`  un-visited items backing the tab + icon badge
//
// Everything chrome.* lives inside functions — the pure helpers at the top
// are unit-tested in a plain node environment.

export interface WatchNudgeItem {
  id: string;
  title: string;
}

export interface WatchPending {
  moduleId: string;
  items: WatchNudgeItem[];
}

export const WATCH_PORTS_KEY = "pinta-watch-ports";
export const WATCH_TOASTED_KEY = "pinta-watch-toasted";
export const WATCH_PENDING_KEY = "pinta-watch-pending";
/** Same record the panel persists its module enable/settings map under. */
export const MODULES_STORE_KEY = "pinta-modules";

const TOASTED_CAP = 1000;
const PORTS_CAP = 5;

/** Items whose id has not been toasted yet. */
export function filterUntoasted<T extends { id: string }>(
  items: T[],
  toasted: string[],
): T[] {
  const seen = new Set(toasted);
  return items.filter((i) => !seen.has(i.id));
}

/** Append newly-toasted ids, newest last, capped from the FRONT so the
 *  oldest ids age out first. */
export function appendToasted(
  toasted: string[],
  ids: string[],
  cap = TOASTED_CAP,
): string[] {
  const merged = [...toasted];
  const have = new Set(toasted);
  for (const id of ids) {
    if (have.has(id)) continue;
    have.add(id);
    merged.push(id);
  }
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** Merge fresh items into the pending badge state. A nudge for a different
 *  module replaces the pending set (one watcher per project in practice). */
export function mergePending(
  pending: WatchPending | null,
  moduleId: string,
  items: WatchNudgeItem[],
): WatchPending {
  const base =
    pending && pending.moduleId === moduleId ? [...pending.items] : [];
  const have = new Set(base.map((i) => i.id));
  for (const it of items) {
    if (have.has(it.id)) continue;
    have.add(it.id);
    base.push(it);
  }
  return { moduleId, items: base };
}

/** Track a companion port for the SW poll, most-recent first, capped. */
export function mergePorts(ports: number[], port: number, cap = PORTS_CAP): number[] {
  return [port, ...ports.filter((p) => p !== port)].slice(0, cap);
}

/** Notification body: up to four "#id title" lines, then an ellipsis. */
export function toastBody(items: WatchNudgeItem[]): string {
  return (
    items
      .slice(0, 4)
      .map((i) => `#${i.id} ${i.title}`)
      .join("\n") + (items.length > 4 ? "\n…" : "")
  );
}

/** Badge text for a count ("" clears the badge). */
export function badgeText(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

/* ── chrome-touching helpers (no top-level chrome so tests can import) ── */

/** Modules map as persisted by the panel: id → { enabled, settings }. */
type ModulesRecord = Record<
  string,
  { enabled?: boolean; settings?: Record<string, string | boolean> }
>;

/** Should this nudge toast? The module must be enabled and not have its
 *  own `watchNotifications` setting explicitly off. */
export function moduleWantsToast(
  modules: ModulesRecord | undefined,
  moduleId: string,
): boolean {
  const entry = modules?.[moduleId];
  if (!entry?.enabled) return false;
  return entry.settings?.["watchNotifications"] !== false;
}

/** Raise the Chrome notification for a nudge. Safe no-op when the API or
 *  permission is unavailable. Errors are surfaced to the console (visible
 *  in the service-worker inspector) instead of being silently swallowed —
 *  "badge but no toast" is otherwise undiagnosable. */
export function raiseWatchToast(title: string, items: WatchNudgeItem[]): void {
  try {
    const create = chrome.notifications?.create as
      | ((id: string, o: chrome.notifications.NotificationOptions<true>) => Promise<string>)
      | undefined;
    if (!create) {
      console.warn("[pinta] watch toast skipped — notifications API unavailable");
      return;
    }
    create
      .call(chrome.notifications, `pinta-watch-${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: title || "New tasks",
        message: toastBody(items),
        priority: 1,
      })
      .then((id) => console.info(`[pinta] watch toast created: ${id}`))
      .catch((err) =>
        console.warn("[pinta] watch toast FAILED:", (err as Error)?.message ?? err),
      );
  } catch (err) {
    console.warn("[pinta] watch toast threw:", (err as Error)?.message ?? err);
  }
}

/** Reflect the pending count on the extension's toolbar icon. */
export function setIconBadge(count: number): void {
  try {
    void chrome.action?.setBadgeBackgroundColor?.({ color: "#FF3D6E" });
    void chrome.action?.setBadgeText?.({ text: badgeText(count) });
  } catch {
    // action API unavailable (unlikely) — ignore
  }
}

/** Record a connected companion's port so the SW knows whom to poll. */
export async function recordWatchPort(port: number): Promise<void> {
  try {
    const s = await chrome.storage?.local?.get(WATCH_PORTS_KEY);
    const ports = Array.isArray(s?.[WATCH_PORTS_KEY])
      ? (s[WATCH_PORTS_KEY] as number[])
      : [];
    await chrome.storage?.local?.set({
      [WATCH_PORTS_KEY]: mergePorts(ports, port),
    });
  } catch {
    // storage unavailable — SW just won't background-poll this port
  }
}

/** Fetch a companion's recent watch events with a hard timeout. Returns
 *  [] on any failure (companion down, route missing on an old build). */
export async function fetchWatchEvents(
  port: number,
  timeoutMs = 3000,
): Promise<
  { moduleId?: string; title: string; items: WatchNudgeItem[] }[]
> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/watch/events`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      events?: { moduleId?: string; title?: string; items?: WatchNudgeItem[] }[];
    };
    return (body.events ?? []).map((e) => ({
      moduleId: e.moduleId,
      title: e.title ?? "New tasks",
      items: Array.isArray(e.items) ? e.items : [],
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
