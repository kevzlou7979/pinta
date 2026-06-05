#!/usr/bin/env node
// Pins the documented `npx pinta-companion@<version> install-skill` command to
// the CURRENT companion version across the user-facing docs, so the version in
// the docs never drifts behind a release. Reads the version from
// companion/package.json (already bumped by the release flow's Step 4) and
// rewrites every `pinta-companion@<semver> install-skill` occurrence.
//
// Why pin at all: `npx` can serve a previously-cached pinta-companion that
// predates the `install-skill` subcommand, so an unpinned command silently
// runs the old bundle. Pinning forces the new tarball.
//
// Run from the release flow after the version bumps. Idempotent.
//   node scripts/pin-docs-version.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const version = JSON.parse(
  readFileSync(join(ROOT, "companion", "package.json"), "utf8"),
).version;

// Files that document the install-skill command for end users.
const FILES = ["README.md", "docs/index.html", "docs/docs.html"];
// Match `pinta-companion@<semver> install-skill` (also catches an unpinned
// `pinta-companion install-skill` so first-time pinning works).
const PATTERN = /pinta-companion(@[0-9]+\.[0-9]+\.[0-9]+)? install-skill/g;
const replacement = `pinta-companion@${version} install-skill`;

let total = 0;
for (const rel of FILES) {
  const path = join(ROOT, rel);
  const before = readFileSync(path, "utf8");
  let count = 0;
  const after = before.replace(PATTERN, () => {
    count++;
    return replacement;
  });
  if (after !== before) {
    writeFileSync(path, after);
    total += count;
    console.log(`  ${rel}: pinned ${count} occurrence(s) → @${version}`);
  }
}
console.log(
  total > 0
    ? `pinned install-skill docs to @${version} (${total} total)`
    : `install-skill docs already at @${version}`,
);
