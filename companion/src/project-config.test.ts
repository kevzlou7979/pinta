import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addUrlPattern,
  readProjectConfig,
  writeProjectConfig,
} from "./project-config.js";

describe("project-config", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pinta-cfg-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns {} when .pinta.json is missing", async () => {
    expect(await readProjectConfig(dir)).toEqual({});
  });

  it("returns {} when .pinta.json contains invalid JSON", async () => {
    await writeFile(join(dir, ".pinta.json"), "{ not json", "utf8");
    expect(await readProjectConfig(dir)).toEqual({});
  });

  it("round-trips a config through write+read", async () => {
    await writeProjectConfig(dir, {
      urlPatterns: ["http://localhost:5173/*"],
    });
    const raw = await readFile(join(dir, ".pinta.json"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(await readProjectConfig(dir)).toEqual({
      urlPatterns: ["http://localhost:5173/*"],
    });
  });

  it("addUrlPattern appends a new pattern", async () => {
    const next = await addUrlPattern(dir, "http://localhost:5173/*");
    expect(next).toEqual(["http://localhost:5173/*"]);
    const cfg = await readProjectConfig(dir);
    expect(cfg.urlPatterns).toEqual(["http://localhost:5173/*"]);
  });

  it("addUrlPattern is a no-op when the pattern already exists", async () => {
    await writeProjectConfig(dir, {
      urlPatterns: ["http://localhost:5173/*"],
    });
    const next = await addUrlPattern(dir, "http://localhost:5173/*");
    expect(next).toEqual(["http://localhost:5173/*"]);
  });

  it("addUrlPattern preserves prior patterns when adding", async () => {
    await writeProjectConfig(dir, { urlPatterns: ["a", "b"] });
    const next = await addUrlPattern(dir, "c");
    expect(next).toEqual(["a", "b", "c"]);
  });
});
