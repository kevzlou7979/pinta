// testerInfo.devEmail — the tester side of the round-trip ("Email the
// .pinta back to the developer"). Runs under vitest.repro.config.ts
// because state.svelte.ts needs the Svelte compiler for its runes:
//   npx vitest run --config vitest.repro.config.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "pinta-tester-info";

/** Install a chrome.storage.local stub seeded with `data`, matching the
 *  shape the other repro tests use, and hand back the spies + backing map. */
function setChrome(data: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...data };
  const get = vi.fn(async (k: any) => {
    if (typeof k === "string") return k in store ? { [k]: store[k] } : {};
    return {};
  });
  const set = vi.fn(async (obj: any) => {
    Object.assign(store, obj);
  });
  (globalThis as any).chrome = {
    storage: {
      local: { get, set, remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(),
      getManifest: () => ({ version: "0.9.0" }),
    },
    tabs: { query: vi.fn(async () => []) },
  };
  return { get, set, store };
}

/** Fresh ExtensionState per test — `app` is a module singleton and
 *  loadTesterInfo() is once-only per instance. */
async function freshApp() {
  vi.resetModules();
  const { app } = await import("./state.svelte.js");
  return app;
}

describe("loadTesterInfo() / saveTesterInfo() — devEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates devEmail from chrome.storage", async () => {
    const { get } = setChrome({
      [KEY]: {
        name: "Tess",
        email: "tess@example.com",
        environment: "UAT",
        recipient: "tester@example.com",
        devEmail: "dev@example.com",
      },
    });
    const app = await freshApp();
    expect(app.testerInfo.devEmail).toBe("");
    await app.loadTesterInfo();
    expect(get).toHaveBeenCalledWith(KEY);
    expect(app.testerInfo.devEmail).toBe("dev@example.com");
    // The rest of the record still hydrates alongside it.
    expect(app.testerInfo.name).toBe("Tess");
    expect(app.testerInfo.recipient).toBe("tester@example.com");
  });

  it("defaults devEmail to \"\" for a legacy record saved before the field existed", async () => {
    setChrome({
      [KEY]: { name: "Tess", email: "t@e.co", environment: "Dev", recipient: "r@e.co" },
    });
    const app = await freshApp();
    await app.loadTesterInfo();
    expect(app.testerInfo.devEmail).toBe("");
    expect(app.testerInfo.name).toBe("Tess");
  });

  it("defaults devEmail to \"\" when nothing is stored at all", async () => {
    setChrome({});
    const app = await freshApp();
    await app.loadTesterInfo();
    expect(app.testerInfo.devEmail).toBe("");
    expect(app.testerInfo.recipient).toBe("");
  });

  it("defaults devEmail to \"\" when the stored value is not a string", async () => {
    setChrome({ [KEY]: { devEmail: 42, name: null } });
    const app = await freshApp();
    await app.loadTesterInfo();
    expect(app.testerInfo.devEmail).toBe("");
    expect(app.testerInfo.name).toBe("");
  });

  it("survives storage being unavailable", async () => {
    (globalThis as any).chrome = undefined;
    const app = await freshApp();
    await expect(app.loadTesterInfo()).resolves.toBeUndefined();
    expect(app.testerInfo.devEmail).toBe("");
  });

  it("persists devEmail via saveTesterInfo()", async () => {
    const { set, store } = setChrome({});
    const app = await freshApp();
    await app.loadTesterInfo();
    app.testerInfo.devEmail = "dev@example.com";
    app.saveTesterInfo();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]![0]).toEqual({
      [KEY]: {
        name: "",
        email: "",
        environment: "",
        recipient: "",
        devEmail: "dev@example.com",
        generateSteps: true,
      },
    });
    // A plain object, not a Svelte proxy — chrome.storage must be able
    // to structured-clone it.
    expect(JSON.parse(JSON.stringify(store[KEY]))).toEqual(
      (set.mock.calls[0]![0] as any)[KEY],
    );
  });

  it("round-trips devEmail: save then reload into a fresh state", async () => {
    const { store } = setChrome({});
    const app = await freshApp();
    await app.loadTesterInfo();
    app.testerInfo.devEmail = "round@trip.dev";
    app.saveTesterInfo();
    const again = await freshApp();
    // Re-point the stub at the same backing store.
    setChrome(store as Record<string, unknown>);
    await again.loadTesterInfo();
    expect(again.testerInfo.devEmail).toBe("round@trip.dev");
  });

  it("is idempotent — a second load does not clobber a typed-in devEmail", async () => {
    const { get } = setChrome({ [KEY]: { devEmail: "stored@example.com" } });
    const app = await freshApp();
    await app.loadTesterInfo();
    app.testerInfo.devEmail = "typed@example.com";
    await app.loadTesterInfo();
    expect(get).toHaveBeenCalledTimes(1);
    expect(app.testerInfo.devEmail).toBe("typed@example.com");
  });
});
