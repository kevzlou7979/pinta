#!/usr/bin/env node
// Discovers the Pinta companion for the agent's current project.
// Reads ~/.pinta/registry.json (written by each companion at startup),
// prunes entries whose pid is dead OR whose port is no longer answering
// /v1/health, and prints the port for the entry whose projectRoot is
// the deepest ancestor of the agent's cwd.
//
// "Cwd" here means $CLAUDE_PROJECT_DIR if set (Claude Code exports it
// when the user has opened a specific project), else process.cwd().
// Walking up matters: an agent invoked from `~/proj/src/components/`
// should still find the companion registered against `~/proj/`.
//
// Two-stage prune is intentional. `pid alive` alone isn't enough on
// Windows: pids get recycled, and process.kill(pid, 0) returns EPERM
// (which we'd otherwise treat as alive) for processes we don't own.
// A successful HTTP probe to /v1/health proves the process is the
// companion we registered, not some recycled stranger.
//
// Exit codes:
//   0 — found; prints `<port>\t<projectRoot>` to stdout
//   2 — registry exists but no companion for this cwd; lists candidates on stderr
//   3 — registry empty / missing / all stale; tells the user to start one

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { request } from "node:http";

const REGISTRY = join(homedir(), ".pinta", "registry.json");

/** True iff the pid still maps to a live process. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

/**
 * HTTP probe to confirm the entry's port is actually a Pinta companion
 * with the matching registry id. Returns true on a 200 + matching body.
 */
function healthCheck(entry) {
  return new Promise((resolveProbe) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: entry.port,
        path: "/v1/health",
        method: "GET",
        timeout: 250,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolveProbe(false);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            // Match on registry id when available (most precise) — falls
            // back to projectRoot for tolerance against id format changes.
            const match =
              (entry.id && body.registryId === entry.id) ||
              body.projectRoot === entry.projectRoot;
            resolveProbe(!!body?.ok && match);
          } catch {
            resolveProbe(false);
          }
        });
      },
    );
    req.on("error", () => resolveProbe(false));
    req.on("timeout", () => {
      req.destroy();
      resolveProbe(false);
    });
    req.end();
  });
}

function readSnapshot() {
  try {
    const raw = readFileSync(REGISTRY, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.companions) ? parsed.companions : [];
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    return [];
  }
}

function writeSnapshot(companions) {
  try {
    mkdirSync(dirname(REGISTRY), { recursive: true });
    writeFileSync(REGISTRY, JSON.stringify({ companions }, null, 2), "utf8");
  } catch {
    // best effort — a stale registry is annoying, not fatal
  }
}

function normPath(p) {
  const abs = resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * True iff `target` is `root` or a descendant of `root` after
 * platform-aware normalization.
 */
function pathContains(root, target) {
  const R = normPath(root);
  const T = normPath(target);
  return T === R || T.startsWith(R + "/");
}

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const all = readSnapshot();
const pidLive = all.filter((e) => pidAlive(e.pid));

// Probe each surviving entry in parallel. Total wall-clock cost is one
// 250ms timeout slot regardless of how many entries we check.
const probes = await Promise.all(
  pidLive.map(async (e) => ({ entry: e, ok: await healthCheck(e) })),
);
const live = probes.filter((p) => p.ok).map((p) => p.entry);

// If we filtered anything, persist the cleaned registry so future
// readers don't have to re-probe stale entries.
if (live.length !== all.length) writeSnapshot(live);

if (live.length === 0) {
  process.stderr.write(
    "no Pinta companion is running. Start one in this project root:\n" +
      "  node ~/.claude/skills/pinta/start-companion.js .\n",
  );
  process.exit(3);
}

// Pick the deepest projectRoot that contains the agent's cwd. A repo
// with sub-projects (e.g. ~/mono/web + ~/mono/api) would otherwise tie
// at the parent — longest-match wins.
const candidates = live
  .filter((e) => pathContains(e.projectRoot, cwd))
  .sort((a, b) => normPath(b.projectRoot).length - normPath(a.projectRoot).length);
const match = candidates[0] ?? null;

if (!match) {
  const hint = live
    .map((e) => `  • port ${e.port} → ${e.projectRoot}`)
    .join("\n");
  process.stderr.write(
    `no Pinta companion is running for this project (${cwd}).\n` +
      `Other companions are running:\n${hint}\n` +
      `Start one here:\n  node ~/.claude/skills/pinta/start-companion.js .\n`,
  );
  process.exit(2);
}

process.stdout.write(`${match.port}\t${match.projectRoot}\n`);
