#!/usr/bin/env node
import { resolve } from "node:path";
import { startServer } from "./server.js";
import { SessionStore } from "./store.js";
import { attachWebSocket } from "./ws.js";

type Args = {
  projectRoot: string;
  port: number;
  verbose: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    projectRoot: process.cwd(),
    port: 7878,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") {
      args.projectRoot = resolve(argv[++i] ?? process.cwd());
    } else if (a === "--port") {
      args.port = Number(argv[++i] ?? args.port);
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
      "  --port     7878",
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

  const { port, server } = await startServer({ port: args.port, store, log });
  attachWebSocket({ server, store, log });

  process.stdout.write(
    `Pinta companion ready\n` +
      `  project: ${args.projectRoot}\n` +
      `  http:    http://127.0.0.1:${port}\n` +
      `  ws:      ws://127.0.0.1:${port}/\n`,
  );

  const shutdown = (signal: string) => {
    process.stderr.write(`\n[pinta] received ${signal}, shutting down\n`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[pinta] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
