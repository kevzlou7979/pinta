// Standalone-mode session storage. When no companion is running, the
// side panel's session lives here instead of round-tripping through the
// companion. One draft per URL origin, so a tester hopping between
// staging URLs gets a clean slate per site.
//
// IndexedDB (not chrome.storage.local) because annotations + image
// attachments + screenshots can easily exceed the 5MB chrome.storage cap;
// IDB's quota is a fraction of available disk space (gigabytes typically)
// and stores binary data efficiently.

import type { ImportedSession, Session } from "@pinta/shared";
import {
  isSavedSheet,
  isSavedSheetSummary,
  summarizeSheet,
  type SavedSheet,
  type SavedSheetSummary,
  type SheetShelf,
} from "./sheet-shelf.js";

const DB_NAME = "pinta-standalone";
// v2 added the imported_sessions store. createObjectStore is idempotent
// against `objectStoreNames.contains`, so the v1 → v2 migration is just
// "create if missing" — no data backfill needed.
// v3 added test_sheets (standalone Test Pilot's saved sheets) the same
// way; v4 added test_sheet_index, backfilled from test_sheets in case a
// v3 database already held sheets.
const DB_VERSION = 4;
const STORE = "sessions";
const IMPORTED_STORE = "imported_sessions";
const SHEETS_STORE = "test_sheets";
// One small row per shelved sheet (title + tally) so the switcher can
// list them without loading the sheets and their screenshots.
const SHEET_INDEX_STORE = "test_sheet_index";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Keyed by URL origin (e.g. "https://staging.example.com").
        db.createObjectStore(STORE, { keyPath: "origin" });
      }
      if (!db.objectStoreNames.contains(IMPORTED_STORE)) {
        // Keyed by the local ImportedSession.id, not the source session
        // id — multiple imports of the same source file remain distinct.
        db.createObjectStore(IMPORTED_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SHEETS_STORE)) {
        // One row per shelved tester sheet, keyed by the catalog doc-id.
        db.createObjectStore(SHEETS_STORE, { keyPath: "docId" });
      }
      if (!db.objectStoreNames.contains(SHEET_INDEX_STORE)) {
        const index = db.createObjectStore(SHEET_INDEX_STORE, { keyPath: "docId" });
        // Sheets saved before the index existed still need a row in it,
        // or the switcher would not list them. Same upgrade transaction.
        const sheets = req.transaction?.objectStore(SHEETS_STORE);
        if (sheets) {
          sheets.openCursor().onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) return;
            if (isSavedSheet(cursor.value)) index.put(summarizeSheet(cursor.value));
            cursor.continue();
          };
        }
      }
    };
    // Another extension page still holds the old schema open and has
    // not let go: fail this attempt rather than wait forever (the next
    // call retries).
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error("local database is busy in another Pinta window — close it and try again"));
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another extension page opening a newer schema must not be
      // blocked by this connection — let go and reopen on next use.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      // Invalidate the cached promise so subsequent callers retry
      // instead of awaiting the same poisoned rejection forever
      // (Firefox private mode, transient corruption, browser
      // mid-shutdown).
      dbPromise = null;
      reject(req.error);
    };
  });
  // If the promise rejects later for any reason, also clear the cache
  // so the next caller gets a fresh open attempt.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

type Row = { origin: string; session: Session };

export async function loadByOrigin(origin: string): Promise<Session | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(origin);
    req.onsuccess = () => resolve((req.result as Row | undefined)?.session ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function save(origin: string, session: Session): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ origin, session });
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      const err = tx.error;
      // Quota errors are user-actionable (clear data / drop big
      // pasted images) — distinguish them from generic IDB failures
      // so callers can surface a friendlier message.
      if (err && err.name === "QuotaExceededError") {
        reject(
          new Error(
            "browser storage quota exceeded — drop large pasted images, or clear data for this site",
          ),
        );
        return;
      }
      reject(err ?? new Error("indexeddb write failed"));
    };
  });
}

export async function clearOrigin(origin: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(origin);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getImportedSessions(): Promise<ImportedSession[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMPORTED_STORE, "readonly");
    const req = tx.objectStore(IMPORTED_STORE).getAll();
    req.onsuccess = () => {
      const rows = (req.result as ImportedSession[] | undefined) ?? [];
      // Most-recent first so the History panel shows the newest import
      // at the top without callers having to re-sort.
      rows.sort((a, b) => b.importedAt - a.importedAt);
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function addImportedSession(s: ImportedSession): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMPORTED_STORE, "readwrite");
    tx.objectStore(IMPORTED_STORE).put(s);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeImportedSession(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMPORTED_STORE, "readwrite");
    tx.objectStore(IMPORTED_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearImportedSessions(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMPORTED_STORE, "readwrite");
    tx.objectStore(IMPORTED_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Stable URL origin for keying the local session. file:// URLs collapse
 *  to "file://" — fine for the tester case, all local pages share a draft. */
export function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return "file://";
    return u.origin;
  } catch {
    return null;
  }
}

/** A shelf call that never settles would stall every later sheet
 *  switch and import behind it — give up after this long instead. */
const SHELF_TIMEOUT_MS = 15_000;

function settleWithin<T>(work: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out — the browser's local database is not responding`)),
      SHELF_TIMEOUT_MS,
    );
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Run one transaction over the sheet stores; resolves with whatever
 *  `body` handed to `done` once the transaction has committed. */
function sheetTx<T>(
  mode: IDBTransactionMode,
  what: string,
  body: (tx: IDBTransaction, done: (value: T) => void) => void,
): Promise<T> {
  return settleWithin(
    openDb().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction([SHEETS_STORE, SHEET_INDEX_STORE], mode);
          let value!: T;
          // A failing request reports its reason on the request; the
          // transaction's own `error` is only set once it has aborted.
          // Keep the first reason and settle on abort, so the tester is
          // told WHY (a full disk reads very differently from a glitch).
          let cause: DOMException | null = null;
          const fail = () => {
            const err = tx.error ?? cause;
            reject(
              err?.name === "QuotaExceededError"
                ? new Error("this browser has no room left for saved sheets — delete a saved sheet you no longer need")
                : (err ?? new Error(`${what} failed`)),
            );
          };
          tx.oncomplete = () => resolve(value);
          tx.onerror = (e) => {
            cause ??= (e.target as IDBRequest | null)?.error ?? null;
          };
          tx.onabort = fail;
          body(tx, (v) => {
            value = v;
          });
        }),
    ),
    what,
  );
}

/** IndexedDB-backed shelf of saved tester sheets (see sheet-shelf.ts).
 *  Rows that don't look right are skipped, never thrown on. A sheet and
 *  its index row are always written and removed in one transaction. */
export const idbSheetShelf: SheetShelf = {
  list() {
    // No IndexedDB in this context at all: nothing can be on the shelf,
    // so "empty" is the true answer (writes still fail loudly). A
    // database that exists but won't answer is an error, not "empty".
    if (typeof indexedDB === "undefined") return Promise.resolve([]);
    return sheetTx<SavedSheetSummary[]>("readonly", "listing saved sheets", (tx, done) => {
      const req = tx.objectStore(SHEET_INDEX_STORE).getAll();
      req.onsuccess = () =>
        done(((req.result as unknown[] | undefined) ?? []).filter(isSavedSheetSummary));
    });
  },
  get(docId) {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return sheetTx<SavedSheet | null>("readonly", "opening a saved sheet", (tx, done) => {
      done(null);
      const req = tx.objectStore(SHEETS_STORE).get(docId);
      req.onsuccess = () => done(isSavedSheet(req.result) ? req.result : null);
    });
  },
  put(sheet: SavedSheet) {
    return sheetTx<void>("readwrite", "saving the sheet", (tx) => {
      tx.objectStore(SHEETS_STORE).put(sheet);
      tx.objectStore(SHEET_INDEX_STORE).put(summarizeSheet(sheet));
    });
  },
  remove(docId) {
    return sheetTx<void>("readwrite", "removing a saved sheet", (tx) => {
      tx.objectStore(SHEETS_STORE).delete(docId);
      tx.objectStore(SHEET_INDEX_STORE).delete(docId);
    });
  },
};
