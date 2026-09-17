import {
  WEB_STORE_EXTENSION_ID,
  addTrustedId,
  defaultUserTrustStorePath,
  isExtensionId,
  readTrustStoreStrict,
  removeTrustedId,
} from "./security.js";

export type TrustCommandResult = { code: number; out: string };

const USAGE =
  "Usage: pinta-companion trust <extension-id> | untrust <extension-id> | trust --list\n" +
  "  <extension-id> is the 32-letter id shown on chrome://extensions.\n";

/**
 * `pinta-companion trust <id>` / `untrust <id>` / `trust --list`. Edits the
 * per-user store (~/.pinta/trusted-extensions.json) — the only way an
 * extension beyond the Web Store build and $PINTA_EXTENSION_IDS becomes
 * trusted. Kept out of cli.ts (which boots the server on import) and pure
 * (store path injected, output returned) so it's unit-testable.
 */
export function runTrustCommand(
  argv: string[],
  storePath: string = defaultUserTrustStorePath(),
  envIds: string | undefined = process.env.PINTA_EXTENSION_IDS,
): TrustCommandResult {
  try {
    return runTrustCommandUnsafe(argv, storePath, envIds);
  } catch (err) {
    // e.g. TrustStoreCorruptError — the store is left untouched.
    return { code: 1, out: `Error: ${(err as Error).message}
` };
  }
}

function runTrustCommandUnsafe(
  argv: string[],
  storePath: string,
  envIds: string | undefined,
): TrustCommandResult {
  const [cmd, arg] = argv;
  if (cmd === "trust" && arg === "--list" && argv.length === 2) {
    const ids = readTrustStoreStrict(storePath).ids;
    const lines = [
      `Always trusted: ${WEB_STORE_EXTENSION_ID} (Chrome Web Store)`,
      ...(envIds ? [`PINTA_EXTENSION_IDS: ${envIds}`] : []),
      `Trusted in ${storePath}:`,
      ...(ids.length
        ? ids.map((e) => `  ${e.id}${e.addedAt ? `  (added ${e.addedAt})` : ""}`)
        : ["  (none)"]),
    ];
    return { code: 0, out: lines.join("\n") + "\n" };
  }
  if ((cmd !== "trust" && cmd !== "untrust") || argv.length !== 2 || !arg) {
    return { code: 1, out: USAGE };
  }
  const id = arg.trim().toLowerCase();
  if (!isExtensionId(id)) {
    return { code: 1, out: `Invalid extension id "${arg}".\n${USAGE}` };
  }
  if (cmd === "trust") {
    return addTrustedId(storePath, id)
      ? { code: 0, out: `Trusted extension ${id} (added to ${storePath}).\n` }
      : { code: 0, out: `Extension ${id} is already trusted (${storePath}); nothing changed.\n` };
  }
  return removeTrustedId(storePath, id)
    ? { code: 0, out: `Untrusted extension ${id} (removed from ${storePath}).\n` }
    : { code: 0, out: `Extension ${id} was not in ${storePath}; nothing changed.\n` };
}
