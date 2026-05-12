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
  Annotation,
  AnnotationKind,
  AnnotationTarget,
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

/**
 * Parse a Pinta-exported markdown file into an ImportedSession. The MD
 * format is lossy compared to `.pinta`: no screenshot bitmap, no drawing
 * geometry, no inline-editor data. What survives is enough for the
 * viewer to resolve selectors live on the page and for "Send to agent"
 * to work — selector + outerHTML + nearbyText + comment per annotation.
 *
 * Expected shape (produced by formatSessionAsClipboard):
 *
 *   Pinta annotations on https://...
 *
 *   ### 1. Element
 *   - **Selector:** `...`
 *   - **Outer HTML:** `...`
 *   - **Nearby text:** "..."
 *   - **Comment:** ...
 */
export function decodePintaMarkdown(text: string): ImportedSession {
  if (text.length > MAX_PINTA_FILE_BYTES) {
    throw new PintaFileError(
      `file too large (${text.length} bytes; max ${MAX_PINTA_FILE_BYTES})`,
    );
  }

  const headerMatch = /Pinta annotations on (\S+)/i.exec(text);
  const sessionUrl = headerMatch?.[1]?.trim() ?? "";
  if (!sessionUrl) {
    throw new PintaFileError(
      "missing `Pinta annotations on <URL>` header — file does not look like a Pinta markdown export",
    );
  }

  const annotations = parseAnnotationBlocks(text);
  if (annotations.length === 0) {
    throw new PintaFileError(
      "no annotations found — expected `### 1. Element` style blocks",
    );
  }

  let host = "session";
  try {
    host = new URL(sessionUrl).hostname || host;
  } catch {
    // unparsable URL — keep "session"
  }
  const now = Date.now();
  const manifest: SessionManifest = {
    title: `${host} — imported markdown`,
    author: "Imported from markdown",
    accentColor: "#7C3AED",
    exportedAt: now,
  };
  const session: Session = {
    id: crypto.randomUUID(),
    url: sessionUrl,
    projectRoot: "",
    startedAt: now,
    annotations,
    status: "drafting",
    producer: "test",
  };
  return {
    id: crypto.randomUUID(),
    manifest,
    session,
    importedAt: now,
  };
}

function parseAnnotationBlocks(text: string): Annotation[] {
  const headerRe = /^###\s+(\d+)\.\s+(.+)$/gm;
  const headers: { index: number; kindLabel: string; offset: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) {
    headers.push({
      index: Number(m[1]),
      kindLabel: m[2]!.trim(),
      offset: m.index + m[0].length,
    });
  }
  const out: Annotation[] = [];
  const now = Date.now();
  for (let i = 0; i < headers.length; i++) {
    const tail = text.slice(headers[i]!.offset);
    const nextHeader = /\n###\s+\d+\.\s+/.exec(tail);
    const body = nextHeader ? tail.slice(0, nextHeader.index) : tail;
    const ann = parseSingleBlock(body, headers[i]!.kindLabel, now);
    if (ann) out.push(ann);
  }
  return out;
}

function parseSingleBlock(body: string, kindLabel: string, now: number): Annotation | null {
  const lines = body.split(/\r?\n/);
  let selector = "";
  let outerHTML = "";
  let nearbyText = "";
  let sourceFile: string | undefined;
  let sourceLine: number | undefined;
  let comment = "";
  let commentMode = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const sel = matchBullet(line, "Selector");
    if (sel !== null) {
      selector = unwrapBackticks(sel);
      commentMode = false;
      continue;
    }
    const html = matchBullet(line, "Outer HTML");
    if (html !== null) {
      outerHTML = unwrapBackticks(html);
      commentMode = false;
      continue;
    }
    const nt = matchBullet(line, "Nearby text");
    if (nt !== null) {
      nearbyText = unwrapQuotes(nt);
      commentMode = false;
      continue;
    }
    const src = matchBullet(line, "Source");
    if (src !== null) {
      const raw = unwrapBackticks(src);
      const colon = raw.lastIndexOf(":");
      if (colon > 0 && /^\d+$/.test(raw.slice(colon + 1))) {
        sourceFile = raw.slice(0, colon);
        sourceLine = Number(raw.slice(colon + 1));
      } else {
        sourceFile = raw;
      }
      commentMode = false;
      continue;
    }
    const cm = matchBullet(line, "Comment");
    if (cm !== null) {
      comment = cm;
      commentMode = true;
      continue;
    }
    if (commentMode) {
      // Continue accumulating multi-line comments until a blank line + new
      // bullet boundary. Trailing trim drops trailing blanks gracefully.
      comment += (comment ? "\n" : "") + line;
    }
  }
  comment = comment.trim();

  // A block with no selector AND no comment is useless — skip it rather
  // than create an annotation the user can do nothing with.
  if (!selector && !comment) return null;

  const kind = mapKind(kindLabel);
  const target: AnnotationTarget | undefined = selector
    ? {
        selector,
        outerHTML,
        computedStyles: {},
        nearbyText: nearbyText ? [nearbyText] : [],
        boundingRect: { x: 0, y: 0, width: 0, height: 0 },
        sourceFile,
        sourceLine,
      }
    : undefined;

  return {
    id: crypto.randomUUID(),
    createdAt: now,
    kind,
    strokes: [],
    color: "#7C3AED",
    comment,
    targets: target ? [target] : undefined,
    target,
  };
}

function matchBullet(line: string, label: string): string | null {
  const re = new RegExp(`^\\s*-\\s+\\*\\*${label}:\\*\\*\\s*(.*)$`);
  const m = re.exec(line);
  return m ? m[1]!.trim() : null;
}

function unwrapBackticks(s: string): string {
  const m = /^`(.+)`$/s.exec(s.trim());
  return m ? m[1]!.trim() : s.trim();
}

function unwrapQuotes(s: string): string {
  const m = /^"(.*)"$/s.exec(s.trim());
  return m ? m[1]! : s.trim();
}

function mapKind(label: string): AnnotationKind {
  const v = label.toLowerCase().trim();
  if (v === "element") return "select";
  if (v === "pin" || v === "arrow" || v === "rect" || v === "circle" || v === "freehand" || v === "image") {
    return v as AnnotationKind;
  }
  // Unknown kind labels fall back to "select" so the viewer can still
  // resolve the selector — the worst case is a pin badge on the right
  // element with no extra geometry, which is what we'd render anyway.
  return "select";
}
