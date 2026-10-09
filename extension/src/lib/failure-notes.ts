// Test Pilot failure notes — what a tester writes down when a row fails:
// a description, steps to reproduce and screenshots. A failed row can
// carry several. Pure helpers only (no chrome.* / $state) so the
// validation and the export text are unit-testable.
//
// Notes ride three ways: with the catalog in chrome.storage, in the
// per-author results sidecar on disk, and back to the developer inside
// a `.pinta` bundle. The last two are files someone else can edit, so
// everything read from them goes through `sanitizeFailureNotes`.

/** A screenshot on a failure note. Same shape as `ChatImage`. */
export type FailureNoteImage = {
  /** `data:image/png|jpeg;base64,…` — downscaled before it is stored. */
  dataUrl: string;
  mediaType: string;
  name?: string;
};

export type FailureNote = {
  id: string;
  at: number;
  /** What went wrong, in the tester's words. */
  description: string;
  /** Steps to reproduce — free text, one step per line. */
  steps?: string;
  images?: FailureNoteImage[];
};

/** An unsaved note, parked while its row's composer is not on screen.
 *  `editing` is a note id, or `NEW_NOTE` for a note not saved yet. */
export type FailureNoteParkedDraft = {
  editing: string;
  description: string;
  steps: string;
  images: FailureNoteImage[];
};

/** The composer's marker for "a note that has no id yet" — never a
 *  valid note id (the validator re-mints it). */
export const NEW_NOTE = "new";

/** What the composer hands to `saveFailureNote`. `id` set = edit. */
export type FailureNoteDraft = {
  id?: string;
  description: string;
  steps?: string;
  images?: FailureNoteImage[];
};

export const FAILURE_NOTE_LIMITS = {
  /** Notes per failed test. */
  notesPerTest: 10,
  /** Screenshots per note — each is ~100-300 KB in chrome.storage. */
  imagesPerNote: 4,
  /** Longest edge a screenshot is downscaled to before it is stored. */
  imageMaxEdge: 1280,
  descriptionChars: 4000,
  stepsChars: 4000,
  /** Upper bound on one stored screenshot (base64 chars). */
  imageDataUrlChars: 3_000_000,
} as const;

/** Only formats Word can embed and `<img>` renders without surprises. */
const IMAGE_DATA_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

/** A file name safe to print on one line of an export: control
 *  characters (newlines included) become spaces, length is capped. */
export function cleanImageName(name: unknown): string {
  if (typeof name !== "string") return "";
  let out = "";
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    out += cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function isFailureNoteImage(x: unknown): x is FailureNoteImage {
  if (!x || typeof x !== "object") return false;
  const im = x as Record<string, unknown>;
  return (
    typeof im.dataUrl === "string" &&
    im.dataUrl.length <= FAILURE_NOTE_LIMITS.imageDataUrlChars &&
    IMAGE_DATA_URL.test(im.dataUrl)
  );
}

/**
 * Validate notes read from a file (bundle / sidecar). Malformed notes
 * and images are dropped one by one; a note with nothing left in it
 * (no description, steps or image) is dropped too. Never throws.
 */
export function sanitizeFailureNotes(x: unknown): FailureNote[] {
  if (!Array.isArray(x)) return [];
  const out: FailureNote[] = [];
  const seen = new Set<string>();
  for (const raw of x) {
    if (out.length >= FAILURE_NOTE_LIMITS.notesPerTest) break;
    if (!raw || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    const description =
      typeof n.description === "string"
        ? n.description.slice(0, FAILURE_NOTE_LIMITS.descriptionChars).trim()
        : "";
    const steps =
      typeof n.steps === "string"
        ? n.steps.slice(0, FAILURE_NOTE_LIMITS.stepsChars).trim()
        : "";
    const images = (Array.isArray(n.images) ? n.images : [])
      .filter(isFailureNoteImage)
      .slice(0, FAILURE_NOTE_LIMITS.imagesPerNote)
      .map((im) => {
        const name = cleanImageName(im.name);
        return {
          dataUrl: im.dataUrl,
          mediaType: im.dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg",
          ...(name ? { name } : {}),
        };
      });
    if (!description && !steps && images.length === 0) continue;
    // Ids key the list in the UI and address edits / deletes — a
    // repeated one would make two notes move as one.
    let id = typeof n.id === "string" && n.id ? n.id.slice(0, 64) : "";
    if (!id || id === NEW_NOTE || seen.has(id)) id = crypto.randomUUID();
    seen.add(id);
    out.push({
      id,
      at: typeof n.at === "number" && Number.isFinite(n.at) ? n.at : Date.now(),
      description,
      ...(steps ? { steps } : {}),
      ...(images.length > 0 ? { images } : {}),
    });
  }
  return out;
}

/** Same as `sanitizeFailureNotes` for a `{testId: notes[]}` map. Ids
 *  whose notes all turn out invalid are left out. */
export function sanitizeFailureNotesById(x: unknown): Record<string, FailureNote[]> {
  const out: Record<string, FailureNote[]> = Object.create(null);
  if (!x || typeof x !== "object" || Array.isArray(x)) return out;
  for (const [id, notes] of Object.entries(x as Record<string, unknown>)) {
    const clean = sanitizeFailureNotes(notes);
    if (clean.length > 0) out[id] = clean;
  }
  return out;
}

/**
 * Split the free-text "steps to reproduce" into one step per line,
 * dropping blank lines and any numbering or bullet the tester typed
 * ("1. ", "2) ", "- ") so the exports can number them consistently.
 */
export function splitSteps(steps: string | undefined): string[] {
  return (steps ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "").trim())
    .filter((l) => l.length > 0);
}

/** A test's notes when it is failed and has any; otherwise empty.
 *  Exports use this so notes left on a row that was re-marked Pass
 *  never leak into a report. */
export function notesForExport(test: {
  status: string;
  failNotes?: FailureNote[];
}): FailureNote[] {
  return test.status === "fail" ? (test.failNotes ?? []) : [];
}

/**
 * Markdown block listing every failed test's notes in one section of
 * the results export. Empty string when the section has none.
 *
 * Every content line is a blockquote: the results file is re-imported
 * through a line-oriented parser, and a quoted line can never be read
 * as a table row, a heading or a numbered step. Screenshots become
 * `[image: name]` placeholders — the Word export embeds the pixels.
 */
export function renderFailureNotesMarkdown(
  tests: { id: string; test: string; status: string; failNotes?: FailureNote[] }[],
): string {
  let out = "";
  for (const t of tests) {
    const notes = notesForExport(t);
    if (notes.length === 0) continue;
    const title = t.test.replace(/\r?\n+/g, " ").trim() || "(untitled)";
    notes.forEach((n, i) => {
      const count = notes.length > 1 ? ` (${i + 1} of ${notes.length})` : "";
      out += `**Failure note — ${t.id} · ${title}**${count}\n\n`;
      const desc = n.description.split(/\r?\n/);
      if (n.description.trim()) {
        for (const line of desc) out += `> ${line}\n`;
      }
      const steps = splitSteps(n.steps);
      if (steps.length > 0) {
        if (n.description.trim()) out += `>\n`;
        out += `> **Steps to reproduce:**\n`;
        steps.forEach((s, si) => {
          out += `> ${si + 1}. ${s}\n`;
        });
      }
      const images = n.images ?? [];
      if (images.length > 0) {
        if (n.description.trim() || steps.length > 0) out += `>\n`;
        images.forEach((im, ii) => {
          out += `> _[image: ${cleanImageName(im.name) || `screenshot-${ii + 1}`}]_\n`;
        });
      }
      out += `\n`;
    });
  }
  return out ? `**Failure notes**\n\n${out}` : "";
}

/** Plain-text digest of a test's notes for the issue-filing payload —
 *  text only (no pixels), so the agent run stays cheap. */
export function failureNotesDigest(notes: FailureNote[]): string {
  return notes
    .map((n) => {
      const parts: string[] = [];
      if (n.description.trim()) parts.push(n.description.trim());
      const steps = splitSteps(n.steps);
      if (steps.length > 0) {
        parts.push(`Steps to reproduce: ${steps.map((s, i) => `${i + 1}. ${s}`).join(" ")}`);
      }
      return parts.join("\n");
    })
    .filter(Boolean)
    .join("\n---\n")
    .slice(0, 2000);
}
