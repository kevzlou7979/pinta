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

const DB_NAME = "pinta-standalone";
// v2 added the imported_sessions store. createObjectStore is idempotent
// against `objectStoreNames.contains`, so the v1 → v2 migration is just
// "create if missing" — no data backfill needed.
const DB_VERSION = 2;
const STORE = "sessions";
const IMPORTED_STORE = "imported_sessions";

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
    tx.onerror = () => reject(tx.error);
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
