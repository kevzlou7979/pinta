// Saved tester sheets — standalone Test Pilot only. A tester working
// without a companion often runs several projects' sheets in the same
// browser. The sheet on screen lives in the standalone chrome.storage
// slot as before; every OTHER sheet waits here, whole (catalog, marks,
// failure notes, plans, scope), so switching back needs no re-import.
//
// The shelf itself is behind an interface: the real one is IndexedDB
// (local-store.ts — no 10 MB cap, sheets carry screenshots), tests use
// the in-memory one below.

import type {
  TestPilotCatalog,
  TestPilotImportedRun,
  TestPlan,
} from "./state.svelte.js";

/** The view filter saved with a sheet. Mirrors `testPilot.scope`. */
export type SavedSheetScope =
  | { kind: "all" }
  | { kind: string; [k: string]: unknown };

/** One shelved sheet with everything needed to put it back on screen. */
export type SavedSheet = {
  docId: string;
  /** When it was last on screen — newest first in the switcher. */
  savedAt: number;
  catalog: TestPilotCatalog;
  importedRun: TestPilotImportedRun | null;
  plans: TestPlan[];
  scope: SavedSheetScope;
};

/** What the switcher lists for a shelved sheet. Stored beside the sheet
 *  so listing never has to load the sheets (and their screenshots). */
export type SavedSheetSummary = {
  docId: string;
  title: string;
  filename: string;
  total: number;
  pass: number;
  fail: number;
  savedAt: number;
};

export interface SheetShelf {
  /** Summaries only — cheap, however heavy the sheets are. */
  list(): Promise<SavedSheetSummary[]>;
  get(docId: string): Promise<SavedSheet | null>;
  put(sheet: SavedSheet): Promise<void>;
  remove(docId: string): Promise<void>;
}

/** Pass / fail / total across a catalog. */
export function tallyCatalog(catalog: TestPilotCatalog): {
  total: number;
  pass: number;
  fail: number;
} {
  let total = 0,
    pass = 0,
    fail = 0;
  for (const s of catalog.sections ?? []) {
    for (const t of s.tests ?? []) {
      total++;
      if (t.status === "pass") pass++;
      else if (t.status === "fail") fail++;
    }
  }
  return { total, pass, fail };
}

export function summarizeSheet(sheet: SavedSheet): SavedSheetSummary {
  return {
    docId: sheet.docId,
    title: sheet.catalog.title?.trim() || sheet.catalog.filename,
    filename: sheet.catalog.filename,
    savedAt: sheet.savedAt,
    ...tallyCatalog(sheet.catalog),
  };
}

/** A record read back from disk is only usable with a real catalog. */
export function isSavedSheet(x: unknown): x is SavedSheet {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  const c = s.catalog as Record<string, unknown> | undefined;
  return (
    typeof s.docId === "string" &&
    s.docId.length > 0 &&
    !!c &&
    typeof c === "object" &&
    c.docId === s.docId &&
    Array.isArray(c.sections)
  );
}

export function isSavedSheetSummary(x: unknown): x is SavedSheetSummary {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.docId === "string" &&
    s.docId.length > 0 &&
    typeof s.title === "string" &&
    typeof s.total === "number" &&
    typeof s.pass === "number" &&
    typeof s.fail === "number" &&
    typeof s.savedAt === "number"
  );
}

/** Heading text as a comparison key: case and spacing don't matter. */
function titleKey(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Same title, ignoring case and spacing. An empty title matches
 *  nothing. */
export function sameSheetTitle(a: string | undefined, b: string | undefined): boolean {
  const ta = titleKey(a);
  return ta.length > 0 && ta === titleKey(b);
}

/** True when two catalogs have at least one test id in common. */
export function sharesTestIds(a: TestPilotCatalog, b: TestPilotCatalog): boolean {
  const ids = new Set<string>();
  for (const s of a.sections ?? []) for (const t of s.tests ?? []) ids.add(t.id);
  for (const s of b.sections ?? []) for (const t of s.tests ?? []) if (ids.has(t.id)) return true;
  return false;
}

/**
 * Whether a sheet with no doc-id (hand-written, or converted from Word)
 * is another copy of a stored catalog. The title must match AND the two
 * must share a test id: projects often reuse a generic heading ("UAT
 * Test Script") and a file name (`uat.md`), and treating those as one
 * sheet would let one project's file replace the other's.
 */
export function isSamePlainSheet(
  incoming: TestPilotCatalog,
  stored: TestPilotCatalog,
): boolean {
  return (
    sameSheetTitle(incoming.title, stored.title?.trim() || stored.filename) &&
    sharesTestIds(incoming, stored)
  );
}

/** Shelf held in memory — tests, and nothing else. */
export function createMemorySheetShelf(): SheetShelf & { size(): number } {
  const rows = new Map<string, SavedSheet>();
  return {
    async list() {
      return [...rows.values()].map(summarizeSheet);
    },
    async get(docId) {
      const r = rows.get(docId);
      return r ? structuredClone(r) : null;
    },
    async put(sheet) {
      rows.set(sheet.docId, structuredClone(sheet));
    },
    async remove(docId) {
      rows.delete(docId);
    },
    size: () => rows.size,
  };
}
