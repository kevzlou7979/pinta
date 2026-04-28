#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpBackend } from "./mcp/backend.js";
import { createMcpServer } from "./mcp/server.js";
import { findEntryForCwd } from "./registry.js";

type Args = {
  /** When set, overrides registry lookup. */
  companionUrl: string | null;
  verbose: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    companionUrl: process.env.PINTA_COMPANION_URL ?? null,
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

/**
 * Resolve the URL to talk to. Precedence:
 *   1. explicit --companion-url / $PINTA_COMPANION_URL
 *   2. registry lookup for the deepest project containing $CLAUDE_PROJECT_DIR or cwd
 *   3. localhost:7878 (the historical default — still works for single-project setups)
 */
async function resolveCompanionUrl(
  override: string | null,
): Promise<{ url: string; source: "explicit" | "registry" | "default" }> {
  if (override) return { url: override, source: "explicit" };
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const entry = await findEntryForCwd(cwd);
    if (entry) {
      return { url: `http://127.0.0.1:${entry.port}`, source: "registry" };
    }
  } catch {
    // registry unreadable — fall through to default
  }
  return { url: "http://127.0.0.1:7878", source: "default" };
}

function printHelp(): void {
  process.stderr.write(
    [
      "pinta-mcp — stdio MCP server that proxies to a running Pinta companion",
      "",
      "Usage:",
      "  pinta-mcp [--companion-url http://127.0.0.1:7878] [--verbose]",
      "",
      "Discovery (in order):",
      "  1. --companion-url / $PINTA_COMPANION_URL",
      "  2. ~/.pinta/registry.json — pick the companion whose projectRoot",
      "     contains $CLAUDE_PROJECT_DIR or process.cwd() (deepest match wins)",
      "  3. http://127.0.0.1:7878 (single-project default)",
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

  const { url: companionUrl, source } = await resolveCompanionUrl(
    args.companionUrl,
  );
  log(`companion url: ${companionUrl} (source: ${source})`);

  const backend = new HttpBackend(companionUrl);
  const server = createMcpServer(backend);

  // Touch health early so we fail loudly if the companion isn't running.
  const health = await backend.health();
  if (!health.ok) {
    process.stderr.write(
      `[pinta-mcp] companion at ${companionUrl} is not responding ` +
        `(resolved via ${source}). Start it with \`pinta-companion --project .\` first.\n`,
    );
  } else {
    log(`bridged to companion at ${companionUrl}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[pinta-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
