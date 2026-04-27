#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpBackend } from "./mcp/backend.js";
import { createMcpServer } from "./mcp/server.js";

type Args = {
  companionUrl: string;
  verbose: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    companionUrl: process.env.PINTA_COMPANION_URL ?? "http://127.0.0.1:7878",
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--companion-url" || a === "-u") {
      args.companionUrl = argv[++i] ?? args.companionUrl;
    } else if (a === "--verbose" || a === "-v") {
      args.verbose = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  process.stderr.write(
    [
      "pinta-mcp — stdio MCP server that proxies to a running Pinta companion",
      "",
      "Usage:",
      "  pinta-mcp [--companion-url http://127.0.0.1:7878] [--verbose]",
      "",
      "Defaults:",
      "  --companion-url  $PINTA_COMPANION_URL or http://127.0.0.1:7878",
      "",
      "The companion must be running separately (`pinta-companion --project .`).",
      "This process speaks MCP over stdio — wire it up in your agent's MCP config.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = args.verbose
    ? (msg: string) => process.stderr.write(`[pinta-mcp] ${msg}\n`)
    : () => {};

  const backend = new HttpBackend(args.companionUrl);
  const server = createMcpServer(backend);

  // Touch health early so we fail loudly if the companion isn't running.
  const health = await backend.health();
  if (!health.ok) {
    process.stderr.write(
      `[pinta-mcp] companion at ${args.companionUrl} is not responding. ` +
        `Start it with \`pinta-companion --project .\` first.\n`,
    );
  } else {
    log(`bridged to companion at ${args.companionUrl}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[pinta-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
