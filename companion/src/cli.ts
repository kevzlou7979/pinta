#!/usr/bin/env node
import { resolve } from "node:path";
import { startServer } from "./server.js";
import { SessionStore } from "./store.js";
import { attachWebSocket } from "./ws.js";
import { registerEntry, unregister, type RegistryEntry } from "./registry.js";
import { readProjectConfig } from "./project-config.js";

// Bundled by esbuild — declared at build time. See build.mjs.
declare const __PINTA_VERSION__: string;
const VERSION = typeof __PINTA_VERSION__ === "string" ? __PINTA_VERSION__ : "dev";

type Args = {
  projectRoot: string;
  port: number;
  /** True if --port was explicitly passed; disables auto-allocation. */
  portExplicit: boolean;
  verbose: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    projectRoot: process.cwd(),
    port: 7878,
    portExplicit: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") {
      args.projectRoot = resolve(argv[++i] ?? process.cwd());
    } else if (a === "--port") {
      args.port = Number(argv[++i] ?? args.port);
      args.portExplicit = true;
    } else if (a === "--verbose" || a === "-v") {
      args.verbose = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (!a?.startsWith("-")) {
      // positional shorthand: first positional = projectRoot
      args.projectRoot = resolve(a!);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "pinta-companion — annotation hub for the Pinta extension",
      "",
      "Usage:",
      "  pinta-companion [--project <path>] [--port 7878] [--verbose]",
      "  pinta-companion <project_path>",
      "",
      "Defaults:",
      "  --project  cwd",
      "  --port     7878 (auto-increments to 7898 if busy when not pinned)",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = args.verbose
    ? (msg: string) => process.stderr.write(`[pinta] ${msg}\n`)
    : () => {};

  const store = new SessionStore(args.projectRoot);
  await store.restore();

  // Read URL patterns from .pinta.json so the registry entry exposes
  // them on first health check — no need to wait for an extension call.
  const projectConfig = await readProjectConfig(args.projectRoot);

  // Mutable registry-entry holder. The server reads through this on
  // every /v1/health and /v1/url-patterns POST; the CLI sets it after
  // listen() and updates it again after registry write.
  let registryEntry: RegistryEntry | null = null;

  const { port, server } = await startServer({
    port: args.port,
    autoAllocatePort: !args.portExplicit,
    store,
    log,
    getRegistryEntry: () => registryEntry,
  });
  attachWebSocket({ server, store, log });

  registryEntry = await registerEntry({
    port,
    projectRoot: args.projectRoot,
    urlPatterns: projectConfig.urlPatterns ?? [],
    version: VERSION,
  });

  process.stdout.write(
    `Pinta companion ready\n` +
      `  project: ${args.projectRoot}\n` +
      `  http:    http://127.0.0.1:${port}\n` +
      `  ws:      ws://127.0.0.1:${port}/\n` +
      (registryEntry.urlPatterns.length > 0
        ? `  patterns: ${registryEntry.urlPatterns.join(", ")}\n`
        : "  patterns: (none — add via the side panel)\n"),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\n[pinta] received ${signal}, shutting down\n`);
    try {
      if (registryEntry) await unregister(registryEntry.id);
    } catch (err) {
      process.stderr.write(
        `[pinta] registry cleanup failed: ${(err as Error).message}\n`,
      );
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Best-effort cleanup on uncaught exit — synchronous unlink is too
  // fiddly cross-platform, so we rely on the prune-stale path on the
  // next companion startup as the actual safety net.
}

main().catch((err) => {
  process.stderr.write(`[pinta] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
