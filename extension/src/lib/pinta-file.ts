// `.pinta` share-file format — a single self-contained JSON document a
// developer can hand to a teammate or friend. Round-trips through
// encode/decode without lossy steps; no companion needed on the
// receiving end.
//
// Format (schema-versioned via $pinta):
//   { "$pinta": "1", "manifest": {...}, "session": {...} }
//
// Screenshots and image attachments are kept as inline base64 dataUrls
// so the file is portable. Transient companion-side fields (disk paths,
// claim metadata) are stripped on encode.

import type {
  ImportedSession,
  PintaFile,
  Session,
  SessionManifest,
} from "@pinta/shared";

const SCHEMA_VERSION = "1" as const;

/** Hard upper bound to keep a malicious or runaway file from blowing
 *  out IndexedDB. ~25 MB is enough for ~10 full-page screenshots. */
export const MAX_PINTA_FILE_BYTES = 25 * 1024 * 1024;

/** Strip companion-side / claim metadata + module config that shouldn't
 *  travel between machines.
 *  - Disk-extracted screenshot paths are dropped (recipients don't have
 *    the project on disk).
 *  - `modules` is dropped because module settings can carry secrets
 *    (e.g. a GitLab personal access token). The recipient configures
 *    their own modules in their own Settings; nothing leaks via share. */
function stripTransient(session: Session): Session {
  const {
    fullPageScreenshotPath,
    claimedBy,
    claimedAt,
    modules,
    ...rest
  } = session;
  void fullPageScreenshotPath;
  void claimedBy;
  void claimedAt;
  void modules;
  return rest;
}

export function encodePintaFile(
  session: Session,
  manifest: SessionManifest,
): Blob {
  const payload: PintaFile = {
    $pinta: SCHEMA_VERSION,
    manifest,
    session: stripTransient(session),
  };
  const json = JSON.stringify(payload);
  return new Blob([json], { type: "application/json" });
}

/** A safe filename for the downloaded `.pinta` based on the manifest
 *  title, falling back to host + timestamp. Spaces collapse to hyphens
 *  and unsafe characters drop. */
export function pintaFilename(manifest: SessionManifest, sessionUrl: string): string {
  const title = manifest.title.trim();
  if (title) {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    if (slug) return `${slug}.pinta`;
  }
  let host = "session";
  try {
    const u = new URL(sessionUrl);
    if (u.hostname) host = u.hostname;
  } catch {
    // sessionUrl unparsable — keep "session"
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  return `pinta-${host}-${stamp}.pinta`;
}

export class PintaFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PintaFileError";
  }
}

function isManifest(x: unknown): x is SessionManifest {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  return (
    typeof m.title === "string" &&
    typeof m.author === "string" &&
    typeof m.accentColor === "string" &&
    typeof m.exportedAt === "number" &&
    (m.description === undefined || typeof m.description === "string")
  );
}

function isSession(x: unknown): x is Session {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.url === "string" &&
    typeof s.startedAt === "number" &&
    Array.isArray(s.annotations) &&
    typeof s.status === "string" &&
    typeof s.producer === "string"
  );
}

/**
 * Validate + parse a `.pinta` payload. Throws PintaFileError on any
 * malformed input. The returned ImportedSession has a fresh local id
 * so multiple imports of the same source file are distinguishable.
 */
export function decodePintaFile(text: string): ImportedSession {
  if (text.length > MAX_PINTA_FILE_BYTES) {
    throw new PintaFileError(
      `file too large (${text.length} bytes; max ${MAX_PINTA_FILE_BYTES})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PintaFileError(`invalid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new PintaFileError("payload is not an object");
  }
  const p = parsed as Record<string, unknown>;
  if (p.$pinta !== SCHEMA_VERSION) {
    throw new PintaFileError(
      `unsupported $pinta schema version: ${JSON.stringify(p.$pinta)}`,
    );
  }
  if (!isManifest(p.manifest)) {
    throw new PintaFileError("manifest is missing or malformed");
  }
  if (!isSession(p.session)) {
    throw new PintaFileError("session is missing or malformed");
  }
  return {
    id: crypto.randomUUID(),
    manifest: p.manifest,
    session: p.session,
    importedAt: Date.now(),
  };
}
