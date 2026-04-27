#!/usr/bin/env node
// Starts the Pinta companion server pointing at the given project root.
// Usage: node start-companion.js <project_root>
//
// Resolves the companion package relative to this file, supporting both:
//   1. Repo dev: skill/pinta/ inside the pinta monorepo
//   2. Installed: ~/.claude/skills/pinta/ alongside a bundled companion/

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const candidateRoots = [
  resolve(here, "../../companion"),       // monorepo dev layout
  resolve(here, "./companion"),           // bundled installer layout
];

const companionRoot = candidateRoots.find((p) =>
  existsSync(resolve(p, "package.json")),
);

if (!companionRoot) {
  process.stderr.write(
    "[start-companion] could not locate companion package; tried:\n  " +
      candidateRoots.join("\n  ") +
      "\n",
  );
  process.exit(1);
}

const projectRoot = resolve(process.argv[2] ?? process.cwd());

const child = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "dev", "--", "--project", projectRoot],
  {
    cwd: companionRoot,
    stdio: "inherit",
  },
);

child.on("exit", (code) => process.exit(code ?? 0));
