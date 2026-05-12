#!/usr/bin/env node
// One-shot release prep. Verifies clean tree, rebuilds extension +
// companion, zips the extension for the Chrome Web Store, and prints a
// checklist for the manual publish steps (npm publish, Web Store upload).
//
// Usage:  node scripts/release.mjs
//         node scripts/release.mjs --skip-clean-check   # for dev iteration

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  createWriteStream,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const argv = new Set(process.argv.slice(2));
const skipCleanCheck = argv.has("--skip-clean-check");

function log(step, msg) {
  process.stdout.write(`\x1b[36m▸ ${step}\x1b[0m ${msg}\n`);
}
function ok(msg) {
  process.stdout.write(`\x1b[32m✓\x1b[0m ${msg}\n`);
}
function warn(msg) {
  process.stdout.write(`\x1b[33m⚠\x1b[0m ${msg}\n`);
}
function die(msg) {
  process.stderr.write(`\x1b[31m✗\x1b[0m ${msg}\n`);
  process.exit(1);
}
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}

// --- 1. Sanity: versions are aligned ---
log("1/6", "Checking workspace versions");
const extPkg = readJson(join(ROOT, "extension", "package.json"));
const compPkg = readJson(join(ROOT, "companion", "package.json"));
if (extPkg.version !== compPkg.version) {
  die(
    `Version drift: extension@${extPkg.version} != companion@${compPkg.version}. ` +
      `Bump both to the same value before releasing.`,
  );
}
const VERSION = extPkg.version;
ok(`extension + companion both at ${VERSION}`);

// --- 2. Sanity: working tree is clean (skippable) ---
if (!skipCleanCheck) {
  log("2/6", "Checking git working tree");
  const status = execSync("git status --porcelain", { cwd: ROOT }).toString();
  if (status.trim()) {
    warn("Working tree has uncommitted changes:");
    process.stdout.write(status);
    die(
      "Commit or stash before releasing. Re-run with --skip-clean-check to override.",
    );
  }
  ok("Working tree clean");
} else {
  warn("--skip-clean-check: skipping working-tree check");
}

// --- 3. Build everything ---
log("3/6", "Building all workspaces (companion + extension)");
run("npm run build --workspaces --if-present");
ok("Build complete");

// --- 4. Verify the extension build matches the version ---
log("4/6", "Verifying built manifest matches package.json");
const manifestPath = join(ROOT, "extension", "dist", "manifest.json");
if (!existsSync(manifestPath)) {
  die(`No built manifest at ${manifestPath} — extension build failed?`);
}
const manifest = readJson(manifestPath);
if (manifest.version !== VERSION) {
  die(
    `Built manifest.json says version=${manifest.version} but package.json says ${VERSION}.`,
  );
}
ok(`manifest.json version ${manifest.version} matches`);

// --- 5. Zip the extension for the Chrome Web Store ---
log("5/6", `Zipping extension/dist → dist/pinta-extension-v${VERSION}.zip`);
const outDir = join(ROOT, "dist");
mkdirSync(outDir, { recursive: true });
// Clean any prior zips for this same version to keep the directory tidy.
for (const f of readdirSync(outDir)) {
  if (f.startsWith("pinta-extension-") && f.endsWith(".zip")) {
    rmSync(join(outDir, f));
  }
}
const zipPath = join(outDir, `pinta-extension-v${VERSION}.zip`);
const srcDir = join(ROOT, "extension", "dist");

// PowerShell's Compress-Archive ships on every Windows 10+. Works
// cross-platform via 7z on macOS/Linux if we ever need it; for now we
// shell out to PowerShell on Windows and `zip` on POSIX.
if (process.platform === "win32") {
  // Strip the wrapping path so the zip contains files at the root (Web
  // Store expects manifest.json at the top level).
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -Force`,
  ].join("; ");
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
    stdio: "inherit",
  });
  if (r.status !== 0) die(`Compress-Archive failed (exit ${r.status})`);
} else {
  // POSIX path: assumes `zip` is installed.
  const r = spawnSync("zip", ["-r", "-q", zipPath, "."], {
    cwd: srcDir,
    stdio: "inherit",
  });
  if (r.status !== 0) die(`zip failed (exit ${r.status})`);
}
const sz = statSync(zipPath).size;
ok(`Wrote ${relative(ROOT, zipPath)} (${(sz / 1024).toFixed(1)} KB)`);

// --- 6. Verify companion bundle is publishable ---
log("6/6", "Verifying companion bundle");
const compDist = join(ROOT, "companion", "dist");
for (const f of ["cli.cjs", "mcp-stdio.cjs"]) {
  const p = join(compDist, f);
  if (!existsSync(p)) die(`Missing companion artifact: ${relative(ROOT, p)}`);
}
ok(`companion/dist/{cli,mcp-stdio}.cjs both present`);

// --- Print the manual publish checklist ---
const checklist = `
\x1b[1mRelease v${VERSION} prep complete.\x1b[0m

Manual steps remaining (require your credentials):

  \x1b[1m1. Tag and push:\x1b[0m
       git tag v${VERSION}
       git push origin main --tags

  \x1b[1m2. npm publish (pinta-companion):\x1b[0m
       cd companion
       npm publish --access public
       # verify:  npm view pinta-companion version

  \x1b[1m3. Chrome Web Store:\x1b[0m
       Upload dist/pinta-extension-v${VERSION}.zip at
       https://chrome.google.com/webstore/devconsole
       Listing notes: copy the v${VERSION} section from CHANGELOG.md.

  \x1b[1m4. Smoke test the published flow:\x1b[0m
       npx pinta-companion@${VERSION} . --help
       (in a fresh shell — make sure the new bundle resolves)
`;
process.stdout.write(checklist);
