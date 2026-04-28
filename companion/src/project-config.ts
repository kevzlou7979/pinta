// Per-project Pinta config, lives at <projectRoot>/.pinta.json.
// Committed to the repo so URL-pattern routing travels with the
// project for teammates.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PintaProjectConfig = {
  /**
   * Glob-style URL patterns matched against the active tab URL.
   * Examples:
   *   "http://localhost:5173/*"
   *   "https://*.staging.example.com/*"
   */
  urlPatterns?: string[];
};

const FILE = ".pinta.json";

export async function readProjectConfig(
  projectRoot: string,
): Promise<PintaProjectConfig> {
  try {
    const raw = await readFile(join(projectRoot, FILE), "utf8");
    return JSON.parse(raw) as PintaProjectConfig;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    return {};
  }
}

export async function writeProjectConfig(
  projectRoot: string,
  config: PintaProjectConfig,
): Promise<void> {
  await writeFile(
    join(projectRoot, FILE),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Append a URL pattern to the project's config, deduping. Returns the
 * full updated patterns array.
 */
export async function addUrlPattern(
  projectRoot: string,
  pattern: string,
): Promise<string[]> {
  const config = await readProjectConfig(projectRoot);
  const existing = config.urlPatterns ?? [];
  if (existing.includes(pattern)) return existing;
  const next = [...existing, pattern];
  await writeProjectConfig(projectRoot, { ...config, urlPatterns: next });
  return next;
}
