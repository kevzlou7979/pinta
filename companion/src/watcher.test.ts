import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSeen, parseItems, filterNewerIds, startWatcher, type WatcherHandle } from "./watcher.js";

describe("diffSeen", () => {
  it("treats everything as fresh against an empty seen list", () => {
    const { fresh, nextSeen } = diffSeen(["1", "2", "3"], []);
    expect(fresh).toEqual(["1", "2", "3"]);
    expect(nextSeen).toEqual(["1", "2", "3"]);
  });

  it("returns only ids not previously seen", () => {
    const { fresh } = diffSeen(["1", "2", "3"], ["1", "2"]);
    expect(fresh).toEqual(["3"]);
  });

  it("returns no fresh ids when all are already seen", () => {
    const { fresh } = diffSeen(["1", "2"], ["2", "1", "0"]);
    expect(fresh).toEqual([]);
  });

  it("puts fresh ids first and dedups the merged seen list", () => {
    const { nextSeen } = diffSeen(["3", "1"], ["1", "2"]);
    expect(nextSeen).toEqual(["3", "1", "2"]);
  });

  it("caps the seen list so it can't grow unbounded", () => {
    const seen = Array.from({ length: 10 }, (_, i) => `old-${i}`);
    const { nextSeen } = diffSeen(["new"], seen, 5);
    expect(nextSeen).toHaveLength(5);
    expect(nextSeen[0]).toBe("new"); // fresh id kept
  });
});

describe("parseItems", () => {
  it("reads a bare JSON array with default id/title paths", () => {
    const out = parseItems(
      JSON.stringify([
        { id: "7", title: "Fix login" },
        { id: "8", title: "Add export" },
      ]),
      {},
    );
    expect(out).toEqual([
      { id: "7", title: "Fix login" },
      { id: "8", title: "Add export" },
    ]);
  });

  it("honors custom idPath / labelPath (e.g. GitLab iid)", () => {
    const out = parseItems(
      JSON.stringify([{ iid: 42, title: "Claimant title dropdown" }]),
      { idPath: "iid", labelPath: "title" },
    );
    expect(out).toEqual([{ id: "42", title: "Claimant title dropdown" }]);
  });

  it("unwraps a { items: [...] } envelope", () => {
    const out = parseItems(JSON.stringify({ items: [{ id: "1", title: "A" }] }), {});
    expect(out).toEqual([{ id: "1", title: "A" }]);
  });

  it("skips entries with no id and falls back to id for a missing title", () => {
    const out = parseItems(
      JSON.stringify([{ id: "1" }, { title: "no id here" }]),
      {},
    );
    expect(out).toEqual([{ id: "1", title: "1" }]);
  });
});

describe("filterNewerIds (window-sliding guard)", () => {
  it("drops unseen ids below the historical high-water mark", () => {
    // 195... slid into the window when another issue closed; 197... is new.
    expect(filterNewerIds(["195616488", "197295395"], ["197294150", "196187156"])).toEqual([
      "197295395",
    ]);
  });

  it("keeps everything when nothing was ever seen", () => {
    expect(filterNewerIds(["1", "2"], [])).toEqual(["1", "2"]);
  });

  it("fails open for non-numeric ids", () => {
    expect(filterNewerIds(["abc-1", "5"], ["100"])).toEqual(["abc-1"]);
  });
});

describe("startWatcher (integration, real command via temp project)", () => {
  let root: string;
  let handle: WatcherHandle | null = null;
  const events: { moduleId?: string; items: { id: string; title: string }[] }[] = [];

  // The watch command reads items.json from the project root, so tests
  // mutate that file between ticks to simulate the tracker changing.
  async function seedProject(items: unknown[], cfg: Record<string, unknown> = {}) {
    await mkdir(join(root, ".pinta"), { recursive: true });
    await writeFile(join(root, "items.json"), JSON.stringify(items), "utf8");
    await writeFile(
      join(root, "read-items.cjs"),
      'process.stdout.write(require("fs").readFileSync("items.json", "utf8"));',
      "utf8",
    );
    await writeFile(
      join(root, ".pinta", "watch.json"),
      JSON.stringify({
        enabled: true,
        moduleId: "insclix.workflow-tasks",
        title: "New tasks",
        command: "node read-items.cjs",
        intervalSec: 60,
        ...cfg,
      }),
      "utf8",
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pinta-watch-"));
    events.length = 0;
  });

  afterEach(async () => {
    handle?.stop();
    handle = null;
    await rm(root, { recursive: true, force: true });
  });

  it("is a no-op without an enabled config", async () => {
    const logs: string[] = [];
    handle = await startWatcher({
      projectRoot: root, // no .pinta/watch.json at all
      log: (m) => logs.push(m),
      onNew: (p) => events.push(p),
    });
    expect(logs.join(" ")).toContain("off");
    expect(handle.tickNow).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("seeds the backlog silently, notifies only for later items, then dedupes", async () => {
    await seedProject([{ id: "1", title: "Existing task" }]);
    handle = await startWatcher({
      projectRoot: root,
      onNew: (p) => events.push(p),
    });

    // Boot tick: existing backlog seeds watch-state.json, no notification.
    expect(events).toHaveLength(0);
    const state = JSON.parse(
      await readFile(join(root, ".pinta", "watch-state.json"), "utf8"),
    ) as { seen: string[] };
    expect(state.seen).toContain("1");

    // David posts a new task → next tick notifies with ONLY the new item.
    await writeFile(
      join(root, "items.json"),
      JSON.stringify([
        { id: "1", title: "Existing task" },
        { id: "2", title: "New task from David" },
      ]),
      "utf8",
    );
    await handle.tickNow!();
    expect(events).toHaveLength(1);
    expect(events[0].moduleId).toBe("insclix.workflow-tasks");
    expect(events[0].items).toEqual([{ id: "2", title: "New task from David" }]);

    // Same data again → no duplicate notification.
    await handle.tickNow!();
    expect(events).toHaveLength(1);
  });

  it("goes quiet when the config is disabled between ticks (no restart)", async () => {
    await seedProject([{ id: "1", title: "A" }]);
    handle = await startWatcher({
      projectRoot: root,
      onNew: (p) => events.push(p),
    });
    // Disable in place — the watcher re-reads the config each tick.
    await writeFile(
      join(root, ".pinta", "watch.json"),
      JSON.stringify({ enabled: false, command: "node read-items.cjs" }),
      "utf8",
    );
    await writeFile(
      join(root, "items.json"),
      JSON.stringify([{ id: "1", title: "A" }, { id: "2", title: "B" }]),
      "utf8",
    );
    await handle.tickNow!();
    expect(events).toHaveLength(0);
  });
});
